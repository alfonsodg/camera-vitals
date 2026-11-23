# Integración con med365x — control del paciente crónico

La cámara no reemplaza los dispositivos del paciente crónico: añade un canal
que no depende de hardware y permite **corroborar** lo que el paciente reporta.
Un hipertenso que olvidó el tensiómetro sigue transmitiendo pulso, respiración y
HRV; y una lectura que contradice la del oxímetro deja de ser un dato suelto y
pasa a ser una señal para revisar.

## Fase 1 — como servicio independiente

El adaptador corre donde está la cámara y expone HTTP. No necesita tocar el
backend de med365x para aportar valor: emite observaciones LOINC por NATS y
registra la adherencia por REST.

```mermaid
flowchart LR
    subgraph device["Dispositivo del paciente"]
        cam["Cámara"]
        svc["camera-vitals<br/>server.mjs :8099<br/><i>captura en subproceso</i>"]
        cam -->|frames| svc
    end

    subgraph adapt["Adaptador (público, MIT)"]
        cap["src/capture.mjs<br/>SDK · telemetría OFF"]
        loinc["src/loinc.mjs<br/>métrica → LOINC → FHIR"]
        rec["src/reconcile.mjs<br/>segunda opinión"]
        cap --> loinc
        loinc --> rec
    end

    svc --> cap

    subgraph m365["med365x (privado)"]
        nats[["NATS<br/>med365x.tenant.vitals.camera"]]
        ch[("ClickHouse")]
        eng["inference-engine<br/>33 perfiles de enfermedad"]
        api["patient-identity<br/>POST /rpm-transmissions"]
        fhir["FHIR R4 Gateway"]
        nats --> ch --> eng --> fhir
    end

    loinc -->|"FHIR Observation"| nats
    rec -->|"source: camera-rppg"| api
    fhir --> ehr["EHR del centro de salud"]

    classDef pub fill:#d1fae5,stroke:#10b981,color:#065f46
    classDef priv fill:#dbeafe,stroke:#3b82f6,color:#1e3a8a
    classDef dev fill:#f1f5f9,stroke:#94a3b8,color:#334155
    class adapt pub
    class m365 priv
    class device dev
```

**Qué resuelve ya en esta fase**

| | |
|---|---|
| Vitales en el pipeline | las observaciones entran por el mismo subject que BLE y HealthKit |
| Adherencia RPM | `source: "camera-rppg"` cuenta para `transmission-days` |
| Corroboración | segunda opinión contra cualquier canal previo |
| Cero cambios en el motor | no se toca el scoring ni los 33 perfiles |

## Fase 2 — integrado en la app móvil

La app (Expo 58, `expo-camera` y `nats.ws` ya instalados) llama al servicio desde
la pantalla de Monitoreo. La captura sigue fuera del proceso de la app porque el
SDK necesita su propio ciclo de vida.

```mermaid
sequenceDiagram
    autonumber
    participant P as Paciente
    participant App as med365x app<br/>(Expo)
    participant S as camera-vitals<br/>:8099
    participant SDK as SmartSpectra SDK
    participant N as NATS
    participant E as inference-engine
    participant M as Monitor (clínico)

    P->>App: abre Monitor y pulsa "Medir con cámara"
    App->>App: solicita permiso de cámara
    App->>S: POST /capture {seconds: 30, subject}
    S->>SDK: start() en subproceso

    loop cada frame validado
        SDK-->>S: validationStatus
        S-->>App: GET /capture/:id → guidance
        App->>P: "sube un poco la cara" / "inclina la cámara"
    end

    Note over SDK: ~20 s de calentamiento<br/>12 s pulso · 30 s respiración · 60 s HRV

    SDK-->>S: metrics (protobuf) → LOINC
    App->>S: GET /capture/:id
    S-->>App: observations FHIR R4

    App->>App: pinta tarjeta CÁMARA con confianza
    S->>N: publish med365x.tenant.vitals.camera
    N->>E: consume
    E->>E: evalúa contra perfil del paciente

    alt lectura concuerda con el canal previo
        E->>M: sin alerta
    else discrepa del canal previo
        E->>M: alerta "revisar: cámara 90 vs oxímetro 120"
        M->>P: contacto y verificación
    end

    App->>S: POST /second-opinion {reference}
    S-->>App: verdict concordant | discordant | insufficient
    App->>App: registra adherencia (source: camera-rppg)
```

## Por qué importa en el paciente crónico

Un hipertenso o un diabético en seguimiento remoto se mide con dispositivos que
dependen de él: cargar el tensiómetro, emparejar el oxímetro, recordar la
báscula. Los huecos de datos se leen como falta de adherencia cuando muchas
veces son fallos de hardware o de memoria.

Tres efectos concretos:

**Continuidad sin hardware.** Pulso y respiración se obtienen con lo que el
paciente ya tiene. El canal no desaparece porque el dispositivo esté descargado.

**Detección de deriva.** El HRV y la respiración capturan estrés autonómico y
patrón respiratorio, señales que un tensómetro no ve. En un crónico, la tendencia
importa más que el valor aislado.

**Datos que se pueden contrastar.** Si el paciente reporta 118/76 y la cámara da
un pulso de 96 en reposo, eso es una discrepancia que merece una llamada. Antes
era un dato sin contexto.

## Límites que no se deben cruzar

- **No sustituye** un dispositivo validado. Es un canal adicional.
- **No diagnostica.** Bienestar informativo, sin aprobación regulatoria.
- **Las tolerancias de la segunda opinión son heurísticas**, no límites
  clínicos validados. Cada despliegue debe calibrarlas contra su referencia.
- **El encuadre es obligatorio**: cara centrada y pecho superior visible. Por eso
  la guía en vivo es parte del producto y no un mensaje de error.
