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
 * Read a value out of the SDK's metrics payload.
 *
 * The payload nests values under metric names that differ between SDK builds,
 * so each entry lists the paths it has been seen at. Adding a path is cheaper
 * than chasing a payload shape change across the codebase.
 */
const READERS = {
  PULSE_RATE: ["cardio.pulseRate", "pulseRate", "cardio.pulse_rate"],
  BREATHING_RATE: ["breathing.rate", "breathing.breathingRate", "rate"],
  HRV_SDNN: ["cardio.hrv.sdnn", "cardio.hrv.sdNn", "hrv.sdnn"],
  HRV_RMSSD: ["cardio.hrv.rmssd", "hrv.rmssd"],
};

function read(obj, path) {
  const v = path.split(".").reduce((a, k) => (a == null ? a : a[k]), obj);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Turn one SDK metrics payload into a list of observations.
 *
 * @param {object} payload   metrics event from SmartSpectra
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

  for (const [metric, paths] of Object.entries(READERS)) {
    const def = LOINC[metric];
    if (!def) continue;

    let value = null;
    for (const path of paths) {
      value = read(payload, path);
      if (value !== null) break;
    }
    if (value === null || value <= 0) continue;

    out.push({
      metric,
      subject,
      device,
      effectiveDateTime: at,
      code: {
        system: "http://loinc.org",
        code: def.code,
        display: def.display,
      },
      valueQuantity: {
        value: Math.round(value * 10) / 10,
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
