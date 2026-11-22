# camera-vitals

Turn a webcam into a vital-signs source. Measures **pulse, breathing rate and
heart-rate variability** from a camera and emits them as **LOINC-coded
observations**, ready for a remote patient monitoring pipeline.

No wearable. No BLE device. No screen to photograph. The camera is the sensor.

```bash
npm install
export PHYSIOLOGY_API_KEY=your-key
npx camera-vitals --seconds 30
```

```json
{"metric":"PULSE_RATE","subject":"anonymous","code":{"system":"http://loinc.org","code":"8867-4","display":"Heart rate"},"valueQuantity":{"value":68.4,"unit":"/min"}}
```

## Why

Remote patient monitoring has a hardware problem. Every vital sign needs
something to measure it: a blood-pressure cuff, a pulse oximeter, a scale, a
BLE wearable. If the device is not charged, not paired, or not there, there is
no data that day.

Almost every patient already has a camera. This adapter makes that camera count.

It is deliberately small: it measures, it maps to clinical vocabulary, and it
hands the result to whatever pipeline you already run. It does not store
anything, does not ship a database, and does not care which EHR you use.

## Install

Requires Node 20 or newer and a working camera.

```bash
git clone <this-repo>
cd camera-vitals
npm install
```

Get a physiology API key from [Presage](https://physiology.presagetech.com)
and export it:

```bash
export PHYSIOLOGY_API_KEY=...
```

Verify the camera and key before measuring:

```bash
npx camera-vitals --seconds 10
```

On Linux, the SDK needs an X display and `libx11`. On a headless server that
means no camera capture — use `--file` with a recorded video instead.

## Usage

### Measure from the camera

```bash
npx camera-vitals --seconds 30 --subject patient-42
```

### Write JSONL

```bash
npx camera-vitals --seconds 60 --subject patient-42 --out vitals.jsonl
```

### Emit FHIR R4 Observations

```bash
npx camera-vitals --seconds 30 --subject patient-42 --fhir
```

```json
{
  "resourceType": "Observation",
  "id": "patient-42-PULSE_RATE-2026-11-22T12-00-00",
  "status": "final",
  "category": [{ "coding": [{ "system": "http://terminology.hl7.org/CodeSystem/observation-category", "code": "vital-signs" }] }],
  "code": { "system": "http://loinc.org", "code": "8867-4", "display": "Heart rate" },
  "subject": { "reference": "Patient/patient-42" },
  "effectiveDateTime": "2026-11-22T12:00:00.000Z",
  "valueQuantity": { "value": 68.4, "unit": "/min", "system": "http://unitsofmeasure.org", "code": "/min" }
}
```

### Publish to NATS

```bash
npm install nats
npx camera-vitals --seconds 30 --subject patient-42 \
  --nats nats://localhost:4222 --tenant acme
```

Publishes to `med365x.acme.vitals.camera`, beside the BLE and HealthKit
channels, so an existing pipeline needs no change to consume it.

### Analyse a recorded video

```bash
npx camera-vitals --file ./consultation.mp4 --seconds 120 --subject patient-42
```

### As a library

```js
import { capture, toObservations, toFhir, natsSubject } from "@ccvass/camera-vitals";

await capture({
  apiKey: process.env.PHYSIOLOGY_API_KEY,
  seconds: 30,
  onObservations: (payload) => {
    const observations = toObservations(payload, { subject: "patient-42" });
    for (const obs of observations) {
      console.log(toFhir(obs));
    }
  },
});
```

## LOINC mapping

A number without a code is not interoperable. Every metric is mapped to a
verified LOINC code so it can enter any clinical system unchanged.

| SDK metric | LOINC | Display | Unit |
|---|---|---|---|
| `PULSE_RATE` | [8867-4](https://loinc.org/8867-4) | Heart rate | /min |
| `BREATHING_RATE` | [9279-1](https://loinc.org/9279-1) | Respiratory rate | /min |
| `HRV_SDNN` | [80404-7](https://loinc.org/80404-7) | R-R interval.standard deviation | ms |
| `HRV_RMSSD` | [80406-2](https://loinc.org/80406-2) | R-R interval.RMSSD | ms |

Add a metric by extending `LOINC` and `READERS` in `src/loinc.mjs`. The test
suite asserts every entry has a well-formed code, a display name and a unit.

## Consent and data handling

This matters more than the measurement, so it is written down rather than
assumed.

**Camera access** is explicit. Nothing is captured until the process starts and
`start()` is called. There is no background capture and no idle camera.

**SDK telemetry is off.** SmartSpectra sends aggregate session summaries by
default. This adapter passes `enableTelemetry: false` on every session, so no
usage data leaves the device. If you fork this and remove that flag, disclose
the change.

**Video never leaves the machine.** Frames are processed locally and are not
written to disk, uploaded, or retained. `--file` reads a local video and does
the same.

**Only derived numbers are emitted.** The output is a heart rate, a breathing
rate and HRV statistics — no imagery, no face landmarks, no embeddings, no
identifiers beyond the `--subject` value you supply.

**No storage by default.** Without `--out`, `--nats` or `--http`, observations
go to stdout and are gone when the process exits. With a sink, retention is
whatever that sink does — this adapter sets none and deletes none.

**Subjects are pseudonymous.** `--subject` is yours to choose. Use a study id or
a hashed identifier, not a name. The default is `anonymous`.

**LLM processing is not used.** The SDK offers optional LLM Insights that send
metric windows to a gateway. This adapter does not enable them.

**Not a medical device.** These measurements are for general wellness and
informational purposes. They are not FDA-cleared and must not be used for
diagnosis or treatment. See the Presage model cards for validated ranges and
failure conditions.

## Measurement quality

The SDK is strict about conditions, and it tells you exactly what is wrong.
This adapter surfaces those codes as plain guidance instead of failing silently:

```text
guidance: Face too low — raise your head or tilt the camera down
guidance: Chest not visible — tilt the camera down
```

Typical fixes:

| Message | Fix |
|---|---|
| Face too low / too high | Raise or lower your head; centre the face vertically |
| Chest not visible | Tilt the camera down so shoulders are in frame |
| Too dark | Put light in front of you, not behind |
| Face not forward | Look straight at the lens |
| Excessive motion | Hold still; a phone on a stand beats a hand |

Validated ranges, per the Presage model cards:

| Metric | Window | Valid range |
|---|---|---|
| Pulse rate | 12 s average | 40–110 BPM |
| Breathing rate | 30 s average | 5–40 breaths/min |
| HRV | 60 s window | 40–110 BPM |

HRV confidence stays at zero until the full 60-second window completes. A
30-second run will report pulse and breathing but no HRV — that is expected,
not a bug.

## Architecture

```text
camera ──▶ SmartSpectra SDK ──▶ toObservations ──▶ sink
             (rPPG, on device)      (LOINC)         ├─ stdout
                                                    ├─ JSONL
                                                    ├─ FHIR R4
                                                    └─ NATS
```

| File | Responsibility |
|---|---|
| `src/capture.mjs` | SDK session, telemetry off, validation translated |
| `src/loinc.mjs` | Metric → LOINC → FHIR mapping, NATS subject |
| `src/emit.mjs` | Sinks, loaded lazily |
| `cli.mjs` | Command-line entry |

## Tests

```bash
npm test
```

Covers the mapping, FHIR shape, id constraints, tenant sanitisation and
tolerance of payload shape changes. No camera or API key needed.

## License

MIT. See [LICENSE](LICENSE).

SmartSpectra is a product of Presage Technologies and is licensed separately.
