#!/usr/bin/env node
/**
 * End-to-end check with a real video.
 *
 * Runs one capture from a file, then asks for a second opinion twice: once with
 * a reference that should agree, once with one that should not. Proves the whole
 * chain without a camera.
 */
import { capture } from "../src/capture.mjs";
import { toObservations, toFhir } from "../src/loinc.mjs";
import { reconcile, summarise } from "../src/reconcile.mjs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/e2e-video.mjs <video>");
  process.exit(2);
}

const latest = [];

const result = await capture({
  apiKey: process.env.PHYSIOLOGY_API_KEY,
  seconds: Number(process.argv[3] ?? 60),
  source: "file",
  file,
  onObservations: (payload) => {
    const obs = toObservations(payload, { subject: "e2e" });
    if (obs.length) latest.splice(0, latest.length, ...obs);
  },
});

console.log(`\nframes: ${result.frames} · readings: ${latest.length}`);
const top = [...result.validation.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
for (const [code, n] of top) {
  console.log(`  ${n}x validation ${code}`);
}

if (!latest.length) {
  console.log("\nno readings — nothing to reconcile");
  process.exit(1);
}

console.log("\n=== last reading (FHIR) ===");
for (const o of latest.map(toFhir)) {
  console.log(`${o.code.code.padEnd(9)} ${String(o.valueQuantity.value).padStart(6)} ${o.valueQuantity.unit}`);
}

const pulse = latest.find((o) => o.metric === "PULSE_RATE");
if (pulse) {
  const value = pulse.valueQuantity.value;
  for (const [label, ref] of [
    ["agreeing", Math.round(value + 2)],
    ["disagreeing", Math.round(value + 30)],
  ]) {
    const r = reconcile(
      [pulse],
      [{ metric: "PULSE_RATE", valueQuantity: { value: ref }, device: "reference-device" }]
    );
    console.log(`\n${label} reference (${ref} vs ${value}): ${r.verdict}`);
    console.log(`  ${summarise(r)}`);
  }
}
