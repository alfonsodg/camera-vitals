import { test } from "node:test";
import assert from "node:assert/strict";
import { toObservations } from "../src/loinc.mjs";
import { reconcile, summarise, VERDICT } from "../src/reconcile.mjs";
import { toTransmission, SOURCE } from "../src/med365x.mjs";

const at = new Date("2026-11-22T12:00:00Z");

function camera(pulse) {
  return toObservations({ cardio: { pulseRate: pulse } }, { subject: "p1", at });
}

function reference(metricValue, code) {
  const obs = toObservations(metricValue, { subject: "p1", at });
  return obs.map((o) => ({ ...o, device: "ble-oximeter" }));
}

test("concordant when inside the tolerance", () => {
  const result = reconcile(camera(72), reference({ cardio: { pulseRate: 74 } }));
  assert.equal(result.verdict, VERDICT.CONCORDANT);
  const c = result.comparisons[0];
  assert.equal(c.delta, -2);
  assert.equal(c.referenceSource, "ble-oximeter");
});

test("discordant when outside the tolerance", () => {
  const result = reconcile(camera(72), reference({ cardio: { pulseRate: 96 } }));
  assert.equal(result.verdict, VERDICT.DISCORDANT);
  assert.match(summarise(result), /disagrees/);
});

test("tolerance is the larger of absolute and relative", () => {
  // 8% of 120 is 9.6, larger than the 5 bpm absolute default.
  const result = reconcile(camera(129), reference({ cardio: { pulseRate: 120 } }));
  assert.equal(result.verdict, VERDICT.CONCORDANT);
  assert.equal(result.comparisons[0].tolerance, 9.6);
});

test("insufficient when the reference channel has no reading", () => {
  const result = reconcile(camera(72), []);
  assert.equal(result.verdict, VERDICT.INSUFFICIENT);
  assert.match(summarise(result), /unavailable/);
});

test("one discordant metric makes the whole verdict discordant", () => {
  const cam = toObservations(
    { cardio: { pulseRate: 72 }, breathing: { rate: 30 } },
    { subject: "p1", at }
  );
  const ref = toObservations(
    { cardio: { pulseRate: 73 }, breathing: { rate: 14 } },
    { subject: "p1", at }
  );
  const result = reconcile(cam, ref);
  assert.equal(result.verdict, VERDICT.DISCORDANT);
  assert.equal(result.comparisons.length, 2);
});

test("tolerances can be overridden per metric", () => {
  const result = reconcile(camera(80), reference({ cardio: { pulseRate: 86 } }), {
    tolerances: { PULSE_RATE: { absolute: 10, relative: 0 } },
  });
  assert.equal(result.verdict, VERDICT.CONCORDANT);
});

test("transmission body matches the med365x contract", () => {
  const body = toTransmission(camera(72));
  assert.equal(body.source, SOURCE);
  assert.equal(body.source, "camera-rppg");
  assert.ok(body.source.length <= 30, "source max_length is 30");
  assert.equal(body.transmitted_at, "2026-11-22T12:00:00.000Z");
  assert.equal(body.device_id, undefined);
});

test("transmission includes the device when supplied", () => {
  const body = toTransmission(camera(72), { deviceId: "d-1" });
  assert.equal(body.device_id, "d-1");
});
