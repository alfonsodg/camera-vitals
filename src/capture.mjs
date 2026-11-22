/**
 * Capture — wraps a SmartSpectra session and turns it into observations.
 *
 * Two decisions are deliberate:
 *
 *   Telemetry is off. The SDK sends aggregate session summaries by default,
 *   which is fine for a consumer toy and wrong for a clinical platform that has
 *   to answer "what leaves this device". Passing `enableTelemetry: false` makes
 *   that answer "nothing".
 *
 *   Validation codes are surfaced, not swallowed. The SDK emits eighteen of
 *   them (face too low, too dark, moving) and they are the only guidance a user
 *   gets. They are translated here so the caller can show them verbatim.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sdk = require("@smartspectra/node-sdk");

const { SmartSpectraSDK, MetricType, ValidationCode } = sdk;

/** Plain-English guidance for each validation code the SDK can emit. */
export const VALIDATION_HINTS = {
  kOk: "Measurement conditions are good",
  kNoFaceFound: "No face in view — step into frame",
  kMultipleFacesFound: "More than one face — be alone in frame",
  kFaceNotCentered: "Face not centred",
  kFaceSizeOutOfRange: "Face too big or too small — adjust distance",
  kTooDark: "Too dark — add light in front of you",
  kTooBright: "Backlit or overexposed — remove light behind you",
  kChestNotVisible: "Chest not visible — tilt the camera down",
  kCameraTuning: "Camera is still tuning",
  kFrameRateTooLow: "Frame rate too low — close other camera apps",
  kExcessiveMotion: "Too much movement — hold still",
  kFaceTooClose: "Face too close — move back",
  kFaceTooFar: "Face too far — move closer",
  kFaceTooHigh: "Face too high — lower your head",
  kFaceTooLow: "Face too low — raise your head or tilt the camera down",
  kFaceNotForward: "Face not facing the camera — look straight at it",
};

const CODE_NAME = Object.fromEntries(
  Object.entries(ValidationCode ?? {}).map(([k, v]) => [v, k])
);

export function describeValidation(code) {
  const name = CODE_NAME[code] ?? `unknown(${code})`;
  return { code, name, hint: VALIDATION_HINTS[name] ?? "Unknown condition" };
}

const METRICS = [
  MetricType.PULSE_RATE,
  MetricType.HRV,
  MetricType.BREATHING_RATE,
  MetricType.FACE_LANDMARKS,
  MetricType.EXPRESSIONS,
];

/**
 * Run a capture session.
 *
 * @param {object} opts
 * @param {string} opts.apiKey        Presage physiology API key
 * @param {number} [opts.seconds]     how long to run (default 30)
 * @param {"camera"|"file"} [opts.source]
 * @param {string} [opts.file]        path when source is "file"
 * @param {(obs: object[]) => void} [opts.onObservations]
 * @param {(v: object) => void} [opts.onValidation]
 * @param {(s: unknown) => void} [opts.onStatus]
 * @returns {Promise<{frames:number, validation:Map<number,number>}>}
 */
export async function capture(opts) {
  const {
    apiKey,
    seconds = 30,
    source = "camera",
    file,
    onObservations,
    onValidation,
    onStatus,
  } = opts;

  if (!apiKey) throw new Error("apiKey is required");

  const instance = new SmartSpectraSDK({
    apiKey,
    requestedMetrics: METRICS,
    enableTelemetry: false,
  });

  let frames = 0;
  const validation = new Map();

  instance.on("validationStatus", (v) => {
    const code = Number(v);
    if (!Number.isFinite(code)) return;
    validation.set(code, (validation.get(code) ?? 0) + 1);
    onValidation?.(describeValidation(code));
  });

  instance.on("metrics", (payload) => {
    frames++;
    onObservations?.(payload);
  });

  instance.on("processingStatus", (s) => onStatus?.(s));

  instance.on("error", (e) => {
    const code = typeof e === "number" ? e : e?.code;
    onStatus?.({ error: code, message: e instanceof Error ? e.message : undefined });
  });

  if (source === "file") {
    if (!file) throw new Error("file is required when source is 'file'");
    instance.useFile(file);
  } else {
    instance.useCamera();
  }

  const readiness = await instance.checkDeviceReadiness();

  instance.start();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  await instance.stopAsync().catch(() => instance.stop());
  await instance.destroy();

  return { frames, validation, readiness };
}
