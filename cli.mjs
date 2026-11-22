#!/usr/bin/env node
/**
 * camera-vitals — measure pulse, breathing and HRV from a camera and emit them
 * as LOINC-coded observations.
 *
 *   camera-vitals --seconds 30
 *   camera-vitals --out vitals.jsonl
 *   camera-vitals --nats nats://localhost:4222 --tenant demo
 */
import { parseArgs } from "node:util";
import { capture, VALIDATION_HINTS } from "./src/capture.mjs";
import { toObservations, toFhir, natsSubject } from "./src/loinc.mjs";
import { stdoutSink, jsonlSink, natsSink, httpSink, multiSink } from "./src/emit.mjs";

const { values: args } = parseArgs({
  options: {
    seconds: { type: "string", default: "30" },
    subject: { type: "string", default: "anonymous" },
    device: { type: "string", default: "camera" },
    tenant: { type: "string" },
    nats: { type: "string" },
    http: { type: "string" },
    out: { type: "string" },
    file: { type: "string" },
    fhir: { type: "boolean", default: false },
    quiet: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (args.help) {
  process.stdout.write(`camera-vitals — camera vitals as LOINC observations

  --seconds <n>     capture length, default 30
  --subject <id>    pseudonymous patient reference, default "anonymous"
  --device <label>  capture device label, default "camera"
  --out <path>      append observations as JSONL
  --nats <url>      publish to NATS instead of stdout
  --http <url>      POST FHIR Observations to an endpoint
  --tenant <id>     tenant used for the NATS subject
  --fhir            emit FHIR R4 Observations instead of flat records
  --file <path>     analyse a video file instead of the camera
  --quiet           suppress progress on stderr

Environment:
  PHYSIOLOGY_API_KEY   Presage physiology API key (required)
`);
  process.exit(0);
}

const apiKey = process.env.PHYSIOLOGY_API_KEY;
if (!apiKey) {
  process.stderr.write("PHYSIOLOGY_API_KEY is not set\n");
  process.exit(2);
}

const seconds = Number(args.seconds);
if (!Number.isFinite(seconds) || seconds < 5) {
  process.stderr.write("--seconds must be at least 5\n");
  process.exit(2);
}

const log = args.quiet ? () => {} : (m) => process.stderr.write(`${m}\n`);

const sinks = [];
if (args.nats) {
  sinks.push(
    await natsSink({
      servers: args.nats,
      subject: natsSubject(args.tenant ?? "default"),
    })
  );
  log(`publishing to ${natsSubject(args.tenant ?? "default")}`);
}
if (args.http) {
  sinks.push(httpSink({ url: args.http }));
  log(`POSTing observations to ${args.http}`);
}
if (args.out) {
  sinks.push(jsonlSink(args.out));
  log(`appending to ${args.out}`);
}
if (!sinks.length) sinks.push(stdoutSink());

const sink = sinks.length === 1 ? sinks[0] : multiSink(sinks);

const seen = new Set();
let emitted = 0;

const result = await capture({
  apiKey,
  seconds,
  source: args.file ? "file" : "camera",
  file: args.file,
  onStatus: (s) => {
    if (typeof s === "object" && s?.error !== undefined) {
      log(`sdk error: ${s.error}`);
    }
  },
  onValidation: (v) => {
    if (v.name === "kOk" || seen.has(v.name)) return;
    seen.add(v.name);
    log(`guidance: ${v.hint}`);
  },
  onObservations: async (payload) => {
    const observations = toObservations(payload, {
      subject: args.subject,
      device: args.device,
    });
    if (!observations.length) return;
    // One emission per metric per second is plenty; the SDK updates far more
    // often and a monitoring pipeline does not need every frame.
    const second = new Date().toISOString().slice(0, 19);
    const fresh = observations.filter((o) => {
      const key = `${o.metric}:${second}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!fresh.length) return;
    emitted += fresh.length;
    await sink.write(args.fhir ? fresh.map(toFhir) : fresh);
  },
});

await sink.close();

if (!args.quiet) {
  log("");
  log(`frames: ${result.frames} · observations emitted: ${emitted}`);
  log(`readiness: ${result.readiness?.verdict ?? "unknown"}`);
  const top = [...result.validation.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  for (const [code, count] of top) {
    const hint = Object.values(VALIDATION_HINTS);
    log(`  ${count}x validation code ${code}`);
  }
  if (emitted === 0) {
    log("");
    log("No vitals measured. Usually framing: the SDK needs your face centred");
    log("and your chest visible. Re-run after repositioning.");
    process.exitCode = 1;
  }
}
