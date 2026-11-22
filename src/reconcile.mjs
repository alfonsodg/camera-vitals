/**
 * Second opinion — compare a camera reading against another channel.
 *
 * A camera measurement is worth more when it can contradict or confirm
 * something the patient already reported. A pulse oximeter says 72; the camera
 * says 74; the reading is corroborated. The same pair at 72 and 96 is not a
 * disagreement to average away, it is a reason to look.
 *
 * The tolerances below are heuristics chosen for this adapter, not validated
 * clinical limits. They are configurable on purpose: a deployment must choose
 * its own after validating against its reference device.
 */

export const DEFAULT_TOLERANCES = {
  PULSE_RATE: { absolute: 5, relative: 0.08 },
  BREATHING_RATE: { absolute: 3, relative: 0.2 },
  HRV_SDNN: { absolute: 10, relative: 0.25 },
  HRV_RMSSD: { absolute: 10, relative: 0.25 },
};

export const VERDICT = {
  CONCORDANT: "concordant",
  DISCORDANT: "discordant",
  INSUFFICIENT: "insufficient",
};

const LABEL = {
  PULSE_RATE: "heart rate",
  BREATHING_RATE: "respiratory rate",
  HRV_SDNN: "HRV SDNN",
  HRV_RMSSD: "HRV RMSSD",
};

function toleranceFor(metric, value, overrides) {
  const t = overrides?.[metric] ?? DEFAULT_TOLERANCES[metric];
  if (!t) return Math.abs(value) * 0.1;
  return Math.max(t.absolute, Math.abs(value) * t.relative);
}

/**
 * Compare two sets of observations metric by metric.
 *
 * @param {Array<object>} candidate  observations under test (the camera)
 * @param {Array<object>} reference  observations from the other channel
 * @param {object} [opts]
 * @param {object} [opts.tolerances] per-metric { absolute, relative } overrides
 * @returns {{verdict:string, comparisons:Array<object>}}
 */
export function reconcile(candidate, reference, opts = {}) {
  const refByMetric = new Map();
  for (const r of reference ?? []) {
    if (r?.metric && r?.valueQuantity?.value != null) {
      refByMetric.set(r.metric, r);
    }
  }

  const comparisons = [];

  for (const c of candidate ?? []) {
    const value = c?.valueQuantity?.value;
    if (value == null) continue;

    const ref = refByMetric.get(c.metric);
    if (!ref) {
      comparisons.push({
        metric: c.metric,
        label: LABEL[c.metric] ?? c.metric,
        verdict: VERDICT.INSUFFICIENT,
        reason: "no reading from the reference channel",
        candidate: value,
        reference: null,
      });
      continue;
    }

    const refValue = ref.valueQuantity.value;
    const delta = Math.round((value - refValue) * 10) / 10;
    const tolerance = toleranceFor(c.metric, refValue, opts.tolerances);
    const within = Math.abs(delta) <= tolerance;

    comparisons.push({
      metric: c.metric,
      label: LABEL[c.metric] ?? c.metric,
      verdict: within ? VERDICT.CONCORDANT : VERDICT.DISCORDANT,
      candidate: value,
      reference: refValue,
      delta,
      tolerance: Math.round(tolerance * 10) / 10,
      referenceSource: ref.device ?? "unknown",
      reason: within
        ? `within ${Math.round(tolerance * 10) / 10} of the reference channel`
        : `differs by ${Math.abs(delta)}, beyond ${Math.round(tolerance * 10) / 10}`,
    });
  }

  const compared = comparisons.filter((c) => c.verdict !== VERDICT.INSUFFICIENT);
  let verdict = VERDICT.INSUFFICIENT;
  if (compared.length) {
    verdict = compared.some((c) => c.verdict === VERDICT.DISCORDANT)
      ? VERDICT.DISCORDANT
      : VERDICT.CONCORDANT;
  }

  return { verdict, comparisons };
}

/**
 * One-line summary for a clinician dashboard, or for a log line.
 */
export function summarise(result) {
  if (result.verdict === VERDICT.INSUFFICIENT) {
    return "No comparable reading from another channel — second opinion unavailable.";
  }
  if (result.verdict === VERDICT.CONCORDANT) {
    return "Camera reading agrees with the reference channel.";
  }
  const worst = result.comparisons
    .filter((c) => c.verdict === VERDICT.DISCORDANT)
    .map((c) => `${c.label} ${c.candidate} vs ${c.reference}`)
    .join(", ");
  return `Camera reading disagrees with the reference channel: ${worst}. Review before acting.`;
}
