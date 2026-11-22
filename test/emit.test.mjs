import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toObservations } from "../src/loinc.mjs";
import { jsonlSink, multiSink, stdoutSink } from "../src/emit.mjs";

const PAYLOAD = {
  cardio: { pulseRate: 71.2, hrv: { sdnn: 44.5, rmssd: 33.1 } },
  breathing: { rate: 13.8 },
};

test("jsonl sink appends one line per observation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "camera-vitals-"));
  const path = join(dir, "vitals.jsonl");
  try {
    const sink = jsonlSink(path);
    const obs = toObservations(PAYLOAD, { subject: "p1" });
    assert.equal(obs.length, 4);

    await sink.write(obs);
    await sink.write(toObservations(PAYLOAD, { subject: "p1" }));
    await sink.close();

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    assert.equal(lines.length, 8);
    const first = JSON.parse(lines[0]);
    assert.equal(first.subject, "p1");
    assert.ok(first.code.code);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("multi sink survives a failing sink", async () => {
  const dir = await mkdtemp(join(tmpdir(), "camera-vitals-"));
  const path = join(dir, "out.jsonl");
  try {
    const broken = {
      name: "broken",
      async write() {
        throw new Error("sink down");
      },
      async close() {},
    };
    const sink = multiSink([broken, jsonlSink(path)]);
    await sink.write(toObservations({ cardio: { pulseRate: 70 } }));
    await sink.close();

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stdout sink writes nothing for an empty batch", async () => {
  const sink = stdoutSink();
  const original = process.stdout.write;
  let written = "";
  process.stdout.write = (chunk) => {
    written += chunk;
    return true;
  };
  try {
    await sink.write([]);
  } finally {
    process.stdout.write = original;
  }
  assert.equal(written, "");
});
