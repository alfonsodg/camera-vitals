#!/usr/bin/env node
/**
 * Capture service — the backend the med365x app will talk to.
 *
 * The camera lives on the patient's device, so this process runs there and
 * exposes a small HTTP surface.
 *
 * Capture runs in a child process, not in this one. The SDK's native layer
 * stalls when a session is started from inside a request handler, and a child
 * process is the honest fix: the camera is an external resource with its own
 * lifecycle, a stuck session is killed on timeout, and an API restart never
 * leaves the device locked.
 *
 *   node server.mjs --port 8099
 *
 *   POST /capture        { seconds?, subject? } -> 202 { id }
 *   GET  /capture/:id    -> { state, observations, guidance }
 *   GET  /vitals/latest  -> latest observations from the newest capture
 *   POST /second-opinion { reference: [observation, ...] }
 *   GET  /health
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { toFhir } from "./src/loinc.mjs";
import { reconcile, summarise } from "./src/reconcile.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, "cli.mjs");

const port = Number(process.env.PORT ?? 8099);
const apiKey = process.env.PHYSIOLOGY_API_KEY;

if (!apiKey) {
  process.stderr.write("PHYSIOLOGY_API_KEY is not set\n");
  process.exit(2);
}

// The SDK captures through X11 even on a Wayland session. Without DISPLAY it
// opens the video device and then stalls instead of failing, so a missing
// display looks like a hung camera. Surface it at startup.
const display = process.env.DISPLAY ?? ":0";
if (!process.env.DISPLAY) {
  process.stderr.write(
    "DISPLAY is not set; assuming :0. If captures hang, start the service " +
      "from a graphical session or set DISPLAY explicitly.\n"
  );
}

/** id -> { state, observations, guidance:Set, error, child } */
const sessions = new Map();
let running = null;
let latest = [];

const LOINC_TO_METRIC = {
  "8867-4": "PULSE_RATE",
  "9279-1": "BREATHING_RATE",
  "80404-7": "HRV_SDNN",
  "80406-2": "HRV_RMSSD",
};

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function startCapture({ seconds = 30, subject = "anonymous" }) {
  const id = randomUUID();
  const session = {
    state: "running",
    observations: [],
    guidance: new Set(),
    error: null,
    child: null,
  };
  sessions.set(id, session);
  running = id;

  const child = spawn(
    process.execPath,
    [cliPath, "--seconds", String(seconds), "--subject", subject],
    { env: { ...process.env, DISPLAY: display, PHYSIOLOGY_API_KEY: apiKey } }
  );
  session.child = child;

  let buffered = "";
  child.stdout.on("data", (chunk) => {
    buffered += chunk.toString();
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        session.observations.push(JSON.parse(line));
      } catch {
        // A partial line is kept in `buffered`; anything unparseable here is
        // console noise from the native layer and is not an observation.
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n")) {
      const m = line.match(/^guidance: (.+)$/);
      if (m) session.guidance.add(m[1].trim());
      const e = line.match(/^sdk error: (.+)$/);
      if (e) session.error = `sdk error ${e[1].trim()}`;
    }
  });

  // A session that never returns would otherwise hold the camera until the
  // process dies. The SDK spends roughly 20 seconds warming up before the first
  // frame is validated, so the deadline is the requested time plus that slack.
  const deadline = setTimeout(() => {
    if (session.state === "running") {
      child.kill("SIGKILL");
      session.state = "timeout";
      session.error = "capture exceeded its deadline";
    }
  }, (seconds + 60) * 1000);

  child.on("exit", (code) => {
    clearTimeout(deadline);
    if (session.state === "running") {
      const ok = code === 0 && session.observations.length > 0;
      session.state = ok ? "complete" : "empty";
      if (ok) latest = session.observations;
    }
    if (running === id) running = null;
  });

  child.on("error", (e) => {
    clearTimeout(deadline);
    session.state = "failed";
    session.error = e.message;
    if (running === id) running = null;
  });

  return id;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const path = url.pathname;

  try {
    if (req.method === "GET" && path === "/health") {
      return json(res, 200, {
        status: "ok",
        busy: running !== null,
        hasLatest: latest.length > 0,
      });
    }

    if (req.method === "POST" && path === "/capture") {
      if (running) {
        return json(res, 409, { error: "a capture is already running", id: running });
      }
      const body = (await readBody(req)) ?? {};
      const seconds = Number(body.seconds ?? 30);
      if (!Number.isFinite(seconds) || seconds < 5) {
        return json(res, 400, { error: "seconds must be at least 5" });
      }
      const id = startCapture({ seconds, subject: body.subject });
      return json(res, 202, { id, state: "running" });
    }

    if (req.method === "GET" && path.startsWith("/capture/")) {
      const id = path.slice("/capture/".length);
      const s = sessions.get(id);
      if (!s) return json(res, 404, { error: "unknown capture" });
      return json(res, 200, {
        id,
        state: s.state,
        observations: s.observations.map(toFhir),
        guidance: [...s.guidance],
        error: s.error,
      });
    }

    if (req.method === "GET" && path === "/vitals/latest") {
      if (!latest.length) return json(res, 404, { error: "no reading yet" });
      return json(res, 200, { observations: latest.map(toFhir) });
    }

    if (req.method === "POST" && path === "/second-opinion") {
      const body = await readBody(req);
      if (!body) return json(res, 400, { error: "invalid JSON" });
      if (!Array.isArray(body.reference)) {
        return json(res, 400, { error: "reference must be an array of observations" });
      }
      if (!latest.length) {
        return json(res, 409, { error: "no camera reading to compare yet" });
      }
      // Accept flat observations and FHIR Observations alike.
      const reference = body.reference.map((r) =>
        r?.valueQuantity && r?.code && !r.metric
          ? {
              metric: LOINC_TO_METRIC[r.code.code] ?? r.code.code,
              valueQuantity: r.valueQuantity,
              device: r.device?.display,
            }
          : r
      );
      const result = reconcile(latest, reference, { tolerances: body.tolerances });
      return json(res, 200, { ...result, summary: summarise(result) });
    }

    return json(res, 404, { error: "not found" });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
});

server.listen(port, () => {
  process.stderr.write(`camera-vitals capture service on http://localhost:${port}\n`);
});
