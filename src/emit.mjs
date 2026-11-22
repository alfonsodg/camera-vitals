/**
 * Sinks — where observations go.
 *
 * The adapter stays useful without any infrastructure: stdout and JSONL need
 * nothing installed. NATS and HTTP are optional and loaded lazily, so a user
 * who only wants to see a pulse on screen never installs a broker client.
 */
import { appendFile } from "node:fs/promises";

export function stdoutSink({ fhir = false } = {}) {
  return {
    name: "stdout",
    async write(obs) {
      for (const o of obs) {
        process.stdout.write(`${JSON.stringify(fhir ? toFhirSafe(o) : o)}\n`);
      }
    },
    async close() {},
  };
}

function toFhirSafe(o) {
  return o;
}

export function jsonlSink(path) {
  return {
    name: `jsonl:${path}`,
    async write(obs) {
      if (!obs.length) return;
      const lines = obs.map((o) => JSON.stringify(o)).join("\n");
      await appendFile(path, `${lines}\n`, "utf8");
    },
    async close() {},
  };
}

/**
 * Publish to NATS JetStream.
 *
 * `nats` is a peer dependency, not a dependency: the adapter is useful without
 * a broker and a clinical deployment will already have its own client.
 */
export async function natsSink({ servers, subject }) {
  let nats;
  try {
    nats = await import("nats");
  } catch {
    throw new Error(
      "natsSink requires the 'nats' package: npm install nats"
    );
  }

  const connection = await nats.connect({ servers });
  const encoder = new nats.JSONCodec();

  return {
    name: `nats:${subject}`,
    async write(obs) {
      for (const o of obs) {
        connection.publish(subject, encoder.encode(o));
      }
      await connection.flush();
    },
    async close() {
      await connection.drain();
    },
  };
}

export function httpSink({ url, headers = {} }) {
  return {
    name: `http:${url}`,
    async write(obs) {
      for (const o of obs) {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/fhir+json", ...headers },
          body: JSON.stringify(o),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          process.stderr.write(
            `http sink: ${res.status} ${res.statusText} ${body.slice(0, 200)}\n`
          );
        }
      }
    },
    async close() {},
  };
}

/** Fan out to several sinks; one failing does not stop the others. */
export function multiSink(sinks) {
  return {
    name: "multi",
    async write(obs) {
      await Promise.all(
        sinks.map((s) =>
          s.write(obs).catch((e) => {
            process.stderr.write(`sink ${s.name} failed: ${e.message}\n`);
          })
        )
      );
    },
    async close() {
      await Promise.all(sinks.map((s) => s.close().catch(() => {})));
    },
  };
}
