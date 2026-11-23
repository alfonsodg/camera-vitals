# med365x integration — continuous control of the chronic patient

Platform: **[med365x.com](https://med365x.com)** — remote patient monitoring with
FHIR R4 / HL7 interoperability and 33 disease profiles.

<p align="center">
  <img src="mockup-monitor.png" alt="Monitor screen with the camera channel" width="360">
  <br/>
  <sub>The existing Monitor screen (PA / FC / SpO2 / Temp, BLE history) with the
  camera card added: value, confidence, and the second-opinion verdict against
  the BLE oximeter.</sub>
</p>

The camera does not replace the chronic patient's devices: it adds a channel that
does not depend on hardware, and it lets the platform **corroborate** what the
patient reports. A hypertensive patient who forgot the cuff keeps transmitting
pulse, breathing and HRV; and a reading that contradicts the oximeter stops being
an isolated number and becomes a signal worth reviewing.

## Phase 1 — standalone service

The adapter runs where the camera is and exposes HTTP. It needs no change in the
med365x backend to deliver value: it emits LOINC observations over NATS and
records adherence over REST.

```mermaid
flowchart LR
    subgraph device["Patient device"]
        cam["Camera"]
        svc["camera-vitals<br/>server.mjs :8099<br/><i>capture in a child process</i>"]
        cam -->|frames| svc
    end

    subgraph adapt["Adapter (public, MIT)"]
        cap["src/capture.mjs<br/>SDK · telemetry OFF"]
        loinc["src/loinc.mjs<br/>metric → LOINC → FHIR"]
        rec["src/reconcile.mjs<br/>second opinion"]
        cap --> loinc
        loinc --> rec
    end

    svc --> cap

    subgraph m365["med365x (private)"]
        nats[["NATS<br/>med365x.tenant.vitals.camera"]]
        ch[("ClickHouse")]
        eng["inference-engine<br/>33 disease profiles"]
        api["patient-identity<br/>POST /rpm-transmissions"]
        fhir["FHIR R4 Gateway"]
        nats --> ch --> eng --> fhir
    end

    loinc -->|"FHIR Observation"| nats
    rec -->|"source: camera-rppg"| api
    fhir --> ehr["Clinic EHR"]

    classDef pub fill:#d1fae5,stroke:#10b981,color:#065f46
    classDef priv fill:#dbeafe,stroke:#3b82f6,color:#1e3a8a
    classDef dev fill:#f1f5f9,stroke:#94a3b8,color:#334155
    class adapt pub
    class m365 priv
    class device dev
```

### What this phase already delivers

| | |
|---|---|
| Vitals in the pipeline | observations enter through the same subject as BLE and HealthKit |
| RPM adherence | `source: "camera-rppg"` counts toward `transmission-days` |
| Corroboration | second opinion against any prior channel |
| No engine changes | the scoring logic and the 33 profiles are untouched |

## Phase 2 — integrated into the mobile app

The app (Expo 58, with `expo-camera` and `nats.ws` already installed) calls the
service from the Monitor screen. Capture stays outside the app process because the
SDK needs its own lifecycle, and a stuck session must not lock the UI.

```mermaid
sequenceDiagram
    autonumber
    participant P as Patient
    participant App as med365x app<br/>(Expo)
    participant S as camera-vitals<br/>:8099
    participant SDK as SmartSpectra SDK
    participant N as NATS
    participant E as inference-engine
    participant M as Clinician monitor

    P->>App: opens Monitor, taps "Measure with camera"
    App->>App: requests camera permission
    App->>S: POST /capture {seconds: 30, subject}
    S->>SDK: start() in a child process

    loop every validated frame
        SDK-->>S: validationStatus
        S-->>App: GET /capture/:id → guidance
        App->>P: "raise your head" / "tilt the camera down"
    end

    Note over SDK: ~20 s warm-up<br/>12 s pulse · 30 s breathing · 60 s HRV

    SDK-->>S: metrics (protobuf) → LOINC
    App->>S: GET /capture/:id
    S-->>App: FHIR R4 observations

    App->>App: renders the CAMERA card with confidence
    S->>N: publish med365x.tenant.vitals.camera
    N->>E: consume
    E->>E: evaluate against the patient profile

    alt reading agrees with the prior channel
        E->>M: no alert
    else reading disagrees with the prior channel
        E->>M: alert "review: camera 90 vs oximeter 120"
        M->>P: contact and verify
    end

    App->>S: POST /second-opinion {reference}
    S-->>App: verdict concordant | discordant | insufficient
    App->>App: record adherence (source: camera-rppg)
```

## Why it matters for the chronic patient

A hypertensive or diabetic patient under remote follow-up is measured by devices
that depend on them: charging the cuff, pairing the oximeter, remembering the
scale. The resulting gaps read as non-adherence when they are often dead
batteries or forgotten hardware.

Three concrete effects:

**Continuity without hardware.** Pulse and breathing come from what the patient
already owns, so the channel does not disappear because a device is discharged.

**Drift detection.** HRV and respiratory pattern capture autonomic stress and
breathing rhythm — signals a cuff never sees. For a chronic patient the trend
matters more than any single value.

**Readings that can be contradicted.** If the patient reports a normal blood
pressure but the camera shows a resting pulse of 96, that is a discrepancy worth
a phone call. Before, it was a number with no context.

## Limits not to cross

- **It does not replace** a validated device. It is an additional channel.
- **It does not diagnose.** General wellness, no regulatory clearance.
- **The second-opinion tolerances are heuristics**, not validated clinical
  limits. Every deployment must calibrate them against its own reference.
- **Framing is mandatory**: face centred and upper chest visible. That is why the
  live guide is part of the product and not an error message.
