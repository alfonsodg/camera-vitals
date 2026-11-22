import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toObservations,
  toFhir,
  natsSubject,
  LOINC,
} from "../src/loinc.mjs";

test("maps pulse to LOINC 8867-4", () => {
  const [obs] = toObservations(
    { cardio: { pulseRate: 68.4 } },
    { subject: "p1", device: "laptop-cam", at: new Date("2026-11-22T12:00:00Z") }
  );
  assert.equal(obs.code.code, "8867-4");
  assert.equal(obs.code.system, "http://loinc.org");
  assert.equal(obs.valueQuantity.value, 68.4);
  assert.equal(obs.valueQuantity.unit, "/min");
  assert.equal(obs.subject, "p1");
});

test("maps breathing to LOINC 9279-1", () => {
  const obs = toObservations({ breathing: { rate: 14.2 } });
  const breathing = obs.find((o) => o.metric === "BREATHING_RATE");
  assert.equal(breathing.code.code, "9279-1");
});

test("maps HRV SDNN and RMSSD", () => {
  const obs = toObservations({ cardio: { hrv: { sdnn: 42.1, rmssd: 31.7 } } });
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
  assert.equal(toObservations({ cardio: { pulseRate: 0 } }).length, 0);
  assert.equal(toObservations({ cardio: { pulseRate: -5 } }).length, 0);
});

test("tolerates flat payload shapes", () => {
  const obs = toObservations({ pulseRate: 72, rate: 12 });
  assert.ok(obs.some((o) => o.code.code === "8867-4"));
  assert.ok(obs.some((o) => o.code.code === "9279-1"));
});

test("emits a valid FHIR R4 Observation", () => {
  const [obs] = toObservations(
    { cardio: { pulseRate: 70 } },
    { subject: "p1", at: new Date("2026-11-22T12:00:00Z") }
  );
  const fhir = toFhir(obs);
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
  const at = new Date("2026-11-22T12:00:00.400Z");
  const a = toObservations({ cardio: { pulseRate: 70 } }, { subject: "p1", at });
  const b = toObservations({ cardio: { pulseRate: 71 } }, { subject: "p1", at });
  assert.equal(toFhir(a[0]).id, toFhir(b[0]).id);
});

test("builds the med365x NATS subject", () => {
  assert.equal(natsSubject("acme"), "med365x.acme.vitals.camera");
  assert.equal(
    natsSubject("acme", "camera-rppg"),
    "med365x.acme.vitals.camera-rppg"
  );
});

test("sanitises tenant names in the subject", () => {
  // Subject tokens cannot contain whitespace, dots or wildcards, so anything
  // outside [A-Za-z0-9_-] is dropped rather than escaped.
  assert.equal(natsSubject("acme/../evil"), "med365x.acmeevil.vitals.camera");
  assert.equal(natsSubject("a b*c"), "med365x.abc.vitals.camera");
});

test("FHIR id obeys the [A-Za-z0-9-.]{1,64} constraint", () => {
  const [obs] = toObservations(
    { cardio: { pulseRate: 70 } },
    { subject: "patient/with:odd_chars and spaces", at: new Date("2026-11-22T12:00:00Z") }
  );
  const id = toFhir(obs).id;
  assert.match(id, /^[A-Za-z0-9.-]{1,64}$/);
});
