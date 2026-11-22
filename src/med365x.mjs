/**
 * med365x integration.
 *
 * Two separate things travel to the platform, and they are not the same:
 *
 *   The vitals themselves go over NATS as FHIR Observations, beside the BLE and
 *   HealthKit channels.
 *
 *   The transmission record goes over REST and answers a different question:
 *   did the patient transmit today. It is what RPM enrolment and billing count,
 *   and it carries no clinical value on its own.
 *
 * Keeping them apart means a broker outage does not erase the day's adherence,
 * and a REST failure does not lose the measurement.
 */

/** Source label accepted by med365x `TransmissionCreate.source` (max 30 chars). */
export const SOURCE = "camera-rppg";

/**
 * Build the body for POST /api/v1/patients/{id}/rpm-transmissions.
 *
 * @param {Array<object>} observations
 * @param {object} [opts]
 * @param {string} [opts.deviceId]  registered device UUID, if any
 * @param {Date}   [opts.at]        defaults to the newest observation
 */
export function toTransmission(observations, opts = {}) {
  const at =
    opts.at ??
    (observations?.[0]?.effectiveDateTime
      ? new Date(observations[0].effectiveDateTime)
      : new Date());

  const body = {
    transmitted_at: at.toISOString(),
    source: SOURCE,
  };
  if (opts.deviceId) body.device_id = opts.deviceId;
  return body;
}

/**
 * Record the transmission. Requires an active RPM enrolment, a tenant header
 * and a bearer token; the platform returns 404 without the enrolment.
 *
 * @returns {Promise<{ok:boolean, status:number, detail?:string}>}
 */
export async function recordTransmission(opts) {
  const { baseUrl, token, tenantId, patientId, body } = opts;
  if (!baseUrl) throw new Error("baseUrl is required");
  if (!token) throw new Error("token is required");
  if (!tenantId) throw new Error("tenantId is required");
  if (!patientId) throw new Error("patientId is required");

  const url = `${baseUrl.replace(/\/$/, "")}/api/v1/patients/${patientId}/rpm-transmissions`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "X-Tenant-Id": tenantId,
    },
    body: JSON.stringify(body),
  });

  if (res.ok) return { ok: true, status: res.status };

  const detail = await res.text().catch(() => "");
  return { ok: false, status: res.status, detail: detail.slice(0, 300) };
}
