import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toObservations,
  toFhir,
  natsSubject,
  LOINC,
} from "../src/loinc.mjs";

/**
 * Fixtures use the shape the SDK actually emits: `pulseRate` and
 * `breathing.rate` are arrays of MeasurementWithConfidence, `hrv` is an array
 * of Hrv. Values are protobuf doubles, so the expectations read raw.
 */
const AT = new Date("2026-11-22T12:00:00Z");

function mw(value, extra = {}) {
  return { value, timestamp: "1", stable: true, confidence: 90, ...extra };
}

test("maps pulse to LOINC 8867-4", () => {
  const obs = toObservations(
    { cardio: { pulseRate: [mw(68.4)] } },
    { subject: "p1", device: "laptop-cam", at: AT }
  );
  const pulse = obs.find((o) => o.metric === "PULSE_RATE");
  assert.equal(pulse.code.code, "8867-4");
  assert.equal(pulse.code.system, "http://loinc.org");
  assert.equal(pulse.valueQuantity.value, 68.4);
  assert.equal(pulse.valueQuantity.unit, "/min");
  assert.equal(pulse.subject, "p1");
});

test("takes the newest measurement, not the first", () => {
  const obs = toObservations({
    cardio: { pulseRate: [mw(70), mw(75), mw(80)] },
  });
  assert.equal(obs.find((o) => o.metric === "PULSE_RATE").valueQuantity.value, 80);
});

test("carries confidence and stability through", () => {
  const obs = toObservations({
    cardio: { pulseRate: [mw(72, { confidence: 96.2, stable: true })] },
  });
  const pulse = obs.find((o) => o.metric === "PULSE_RATE");
  assert.equal(pulse.stable, true);
  assert.ok(Math.abs(pulse.confidence - 96.2) < 0.01);
});

test("maps breathing to LOINC 9279-1", () => {
  const obs = toObservations({ breathing: { rate: [mw(14.2)] } });
  const breathing = obs.find((o) => o.metric === "BREATHING_RATE");
  assert.equal(breathing.code.code, "9279-1");
  assert.equal(breathing.valueQuantity.value, 14.2);
});

test("maps HRV SDNN and RMSSD from the hrv array", () => {
  const obs = toObservations({
    cardio: { hrv: [{ sdnn: 42.1, rmssd: 31.7, confidence: 60, stable: true }] },
  });
  assert.equal(obs.find((o) => o.metric === "HRV_SDNN").code.code, "80404-7");
  assert.equal(obs.find((o) => o.metric === "HRV_RMSSD").code.code, "80406-2");
});

test("every mapped code has a display name and unit", () => {
  for (const [metric, def] of Object.entries(LOINC)) {
    assert.match(def.code, /^\d{4,5}-\d$/, `${metric} code format`);
    assert.ok(def.display, `${metric} display`);
    assert.ok(def.unit, `${metric} unit`);
  }
});

test("ignores missing, zero and negative values", () => {
  assert.equal(toObservations({}).length, 0);
  assert.equal(toObservations({ cardio: { pulseRate: [] } }).length, 0);
  assert.equal(toObservations({ cardio: { pulseRate: [mw(0)] } }).length, 0);
  assert.equal(toObservations({ cardio: { pulseRate: [mw(-5)] } }).length, 0);
});

test("falls back to the flat shapes when nesting is absent", () => {
  const obs = toObservations({ pulseRate: [mw(72)], rate: [mw(12)] });
  assert.ok(obs.some((o) => o.code.code === "8867-4"));
  assert.ok(obs.some((o) => o.code.code === "9279-1"));
});

test("emits a valid FHIR R4 Observation", () => {
  const obs = toObservations(
    { cardio: { pulseRate: [mw(70)] } },
    { subject: "p1", at: AT }
  );
  const fhir = toFhir(obs.find((o) => o.metric === "PULSE_RATE"));
  assert.equal(fhir.resourceType, "Observation");
  assert.equal(fhir.status, "final");
  assert.equal(fhir.category[0].coding[0].code, "vital-signs");
  assert.equal(fhir.code.code, "8867-4");
  assert.equal(fhir.subject.reference, "Patient/p1");
  assert.equal(fhir.valueQuantity.value, 70);
  assert.equal(fhir.effectiveDateTime, "2026-11-22T12:00:00.000Z");
  assert.match(fhir.id, /^[A-Za-z0-9.-]+$/);
});

test("FHIR id is stable for the same second", () => {
  const a = toObservations({ cardio: { pulseRate: [mw(70)] } }, { subject: "p1", at: AT });
  const b = toObservations({ cardio: { pulseRate: [mw(71)] } }, { subject: "p1", at: AT });
  assert.equal(toFhir(a[0]).id, toFhir(b[0]).id);
});

test("builds the med365x NATS subject", () => {
  assert.equal(natsSubject("acme"), "med365x.acme.vitals.camera");
  assert.equal(natsSubject("acme", "camera-rppg"), "med365x.acme.vitals.camera-rppg");
});

test("sanitises tenant names in the subject", () => {
  assert.equal(natsSubject("acme/../evil"), "med365x.acmeevil.vitals.camera");
  assert.equal(natsSubject("a b*c"), "med365x.abc.vitals.camera");
});

test("FHIR id obeys the [A-Za-z0-9-.]{1,64} constraint", () => {
  const obs = toObservations(
    { cardio: { pulseRate: [mw(70)] } },
    { subject: "patient/with:odd_chars and spaces", at: AT }
  );
  assert.match(toFhir(obs[0]).id, /^[A-Za-z0-9.-]{1,64}$/);
});
