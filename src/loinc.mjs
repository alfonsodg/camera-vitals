/**
 * LOINC mapping.
 *
 * A vital sign without a LOINC code is a number; with one it is interoperable.
 * This module is the only place where SmartSpectra metric names meet clinical
 * terminology, so the rest of the pipeline can stay vocabulary-agnostic.
 *
 * Codes verified against loinc.org:
 *   8867-4   Heart rate
 *   9279-1   Respiratory rate
 *   80404-7  R-R interval.standard deviation (heart rate variability, SDNN)
 *   80406-2  R-R interval.RMSSD
 */

export const LOINC = {
  PULSE_RATE: {
    code: "8867-4",
    display: "Heart rate",
    unit: "/min",
    ucum: "/min",
    system: "http://unitsofmeasure.org",
  },
  BREATHING_RATE: {
    code: "9279-1",
    display: "Respiratory rate",
    unit: "/min",
    ucum: "/min",
    system: "http://unitsofmeasure.org",
  },
  HRV_SDNN: {
    code: "80404-7",
    display: "R-R interval.standard deviation",
    unit: "ms",
    ucum: "ms",
    system: "http://unitsofmeasure.org",
  },
  HRV_RMSSD: {
    code: "80406-2",
    display: "R-R interval.RMSSD",
    unit: "ms",
    ucum: "ms",
    system: "http://unitsofmeasure.org",
  },
};

/**
 * Read a value out of the SDK's decoded metrics payload.
 *
 * The SDK emits protobuf, and the shape is not what it looks like at first
 * glance: `pulseRate` and `breathing.rate` are *arrays* of
 * MeasurementWithConfidence, and `hrv` is an array of Hrv. Each carries a
 * timestamp, so the newest entry is the reading.
 *
 * A measurement is a running window, not a snapshot: taking the last stable
 * entry is what gives a current value instead of an average of the session.
 */
function lastValue(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i];
    const v = typeof m === "number" ? m : m?.value;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      return {
        value: v,
        stable: typeof m === "object" ? m.stable === true : undefined,
        confidence: typeof m === "object" ? m.confidence : undefined,
      };
    }
  }
  return null;
}

function lastHrvField(arr, field) {
  if (!Array.isArray(arr) || !arr.length) return null;
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i]?.[field];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      return { value: v, stable: arr[i].stable === true, confidence: arr[i].confidence };
    }
  }
  return null;
}

/** Locate a value in the decoded payload, trying the shapes the SDK uses. */
const READERS = {
  PULSE_RATE: (p) => lastValue(p?.cardio?.pulseRate ?? p?.pulseRate),
  BREATHING_RATE: (p) => lastValue(p?.breathing?.rate ?? p?.rate),
  HRV_SDNN: (p) => lastHrvField(p?.cardio?.hrv ?? p?.hrv, "sdnn"),
  HRV_RMSSD: (p) => lastHrvField(p?.cardio?.hrv ?? p?.hrv, "rmssd"),
};

/**
 * Turn one decoded SDK metrics payload into a list of observations.
 *
 * @param {object} payload   decoded metrics message
 * @param {object} [opts]
 * @param {string} [opts.subject]  pseudonymous patient reference
 * @param {string} [opts.device]   capture device label
 * @param {Date}   [opts.at]
 * @returns {Array<object>} observations with a LOINC code attached
 */
export function toObservations(payload, opts = {}) {
  const subject = opts.subject ?? "anonymous";
  const device = opts.device ?? "camera";
  const at = (opts.at ?? new Date()).toISOString();
  const out = [];

  for (const [metric, reader] of Object.entries(READERS)) {
    const def = LOINC[metric];
    if (!def) continue;

    const reading = reader(payload);
    if (!reading || reading.value <= 0) continue;

    out.push({
      metric,
      subject,
      device,
      effectiveDateTime: at,
      // Confidence rides along so a consumer can ignore weak readings instead
      // of treating every number as equal.
      confidence: reading.confidence,
      stable: reading.stable,
      code: {
        system: "http://loinc.org",
        code: def.code,
        display: def.display,
      },
      valueQuantity: {
        value: Math.round(reading.value * 10) / 10,
        unit: def.unit,
        system: def.system,
        code: def.ucum,
      },
    });
  }

  return out;
}

/**
 * Shape one observation as an FHIR R4 Observation.
 *
 * Kept minimal on purpose: a gateway that already validates FHIR will reject
 * unknown fields, and a gateway that does not will ignore them. Ids are derived
 * from subject, metric and second so a retry does not duplicate a reading.
 */
export function toFhir(obs) {
  // FHIR restricts `id` to [A-Za-z0-9-.]{1,64} — no underscores, no colons.
  const id = [
    obs.subject,
    obs.metric,
    obs.effectiveDateTime.slice(0, 19),
  ]
    .join("-")
    .replace(/[^A-Za-z0-9.-]/g, "-")
    .slice(0, 64);

  return {
    resourceType: "Observation",
    id,
    status: "final",
    category: [
      {
        coding: [
          {
            system: "http://terminology.hl7.org/CodeSystem/observation-category",
            code: "vital-signs",
            display: "Vital Signs",
          },
        ],
      },
    ],
    code: obs.code,
    subject: { reference: `Patient/${obs.subject}` },
    effectiveDateTime: obs.effectiveDateTime,
    valueQuantity: obs.valueQuantity,
    device: { display: obs.device },
  };
}

/**
 * Build the NATS subject for a tenant.
 *
 * med365x streams vitals as `med365x.<tenant>.vitals.<channel>`, so a camera
 * reading lands beside BLE and HealthKit without any pipeline change.
 */
export function natsSubject(tenant, channel = "camera") {
  const clean = String(tenant).replace(/[^a-zA-Z0-9_-]/g, "");
  return `med365x.${clean}.vitals.${channel}`;
}
