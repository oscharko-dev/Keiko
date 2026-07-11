import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PgClientLike, PgQueryResult } from "./postgres.js";
import { startHostedFeedbackIntake } from "./runtime.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeKey(directory: string, kind: "abuse" | "dedupe", date: string, fill: number): void {
  writeFileSync(
    join(directory, `${kind}-${date}.json`),
    JSON.stringify({
      id: `${kind === "dedupe" ? "dedupe-v1:" : ""}${date}`,
      activatedAt: `${date}T00:00:00.000Z`,
      key: Buffer.alloc(32, fill).toString("base64"),
    }),
    { mode: 0o600 },
  );
}

function secretRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "feedback-lifecycle-"));
  roots.push(root);
  chmodSync(root, 0o700);
  const abuse = join(root, "abuse");
  const dedupe = join(root, "dedupe");
  mkdirSync(abuse, { mode: 0o700 });
  mkdirSync(dedupe, { mode: 0o700 });
  writeKey(abuse, "abuse", "2026-07-10", 1);
  writeKey(abuse, "abuse", "2026-07-11", 2);
  writeKey(dedupe, "dedupe", "2026-01-02", 3);
  writeKey(dedupe, "dedupe", "2026-04-02", 4);
  writeKey(dedupe, "dedupe", "2026-07-01", 5);
  return root;
}

function environment(): Record<string, string> {
  return {
    DATABASE_URL: "postgres://unused",
    KEIKO_FEEDBACK_HOST: "127.0.0.1",
    KEIKO_FEEDBACK_PORT: "12345",
    KEIKO_FEEDBACK_MANAGEMENT_HOST: "127.0.0.1",
    KEIKO_FEEDBACK_MANAGEMENT_PORT: "12346",
    KEIKO_FEEDBACK_PER_IDENTITY_LIMIT: "10",
    KEIKO_FEEDBACK_GLOBAL_LIMIT: "100",
    KEIKO_FEEDBACK_CONCURRENCY_LIMIT: "4",
    KEIKO_FEEDBACK_RECEIPT_CONCURRENCY_LIMIT: "2",
    KEIKO_FEEDBACK_OPEN_COUNT_LIMIT: "100",
    KEIKO_FEEDBACK_OPEN_BYTES_LIMIT: "1000000",
    KEIKO_FEEDBACK_PROXY_HOPS_LIMIT: "2",
    KEIKO_FEEDBACK_BODY_BYTES_LIMIT: "262144",
    KEIKO_FEEDBACK_HEADER_BYTES_LIMIT: "16384",
    KEIKO_FEEDBACK_BODY_DEADLINE_MS: "2000",
    KEIKO_FEEDBACK_STORAGE_DEADLINE_MS: "2000",
    KEIKO_FEEDBACK_DRAIN_DEADLINE_MS: "1000",
    KEIKO_FEEDBACK_PROXY_FAMILY: "forwarded",
    KEIKO_FEEDBACK_SECRET_DIR: secretRoot(),
    KEIKO_FEEDBACK_RETENTION_INTERVAL_MS: "60000",
  };
}

class LifecycleClient implements PgClientLike {
  readonly calls: string[] = [];
  query<Row extends object>(text: string): Promise<PgQueryResult<Row>> {
    this.calls.push(text);
    if (text.includes("to_regclass")) {
      return Promise.resolve({ rows: [{ name: null } as Row], rowCount: 1 });
    }
    if (text.startsWith("SELECT 1 FROM feedback_")) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (text.startsWith("SELECT key_class")) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (text.startsWith("SELECT DISTINCT")) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    return Promise.resolve({ rows: [{} as Row], rowCount: text.startsWith("DELETE") ? 0 : 1 });
  }
  release(): void {
    this.calls.push("RELEASE");
  }
}

interface ListenerDouble {
  once(event: "error", listener: (error: Error) => void): void;
  removeListener(): void;
  listen(port: number, host: string, callback: () => void): void;
  close(callback: (error?: Error) => void): void;
  closeAllConnections(): void;
}

function listenerDouble(
  mode: "success" | "address-in-use" | "close-error",
  closed: () => void,
): ListenerDouble {
  let errorListener: ((error: Error) => void) | undefined;
  return {
    once: (_event, listener): void => {
      errorListener = listener;
    },
    removeListener: (): void => {
      errorListener = undefined;
    },
    listen: (_port, _host, callback): void => {
      if (mode === "address-in-use") {
        const error = Object.assign(new Error("address in use"), { code: "EADDRINUSE" });
        queueMicrotask(() => errorListener?.(error));
      } else callback();
    },
    close: (callback): void => {
      closed();
      callback(mode === "close-error" ? new Error("close failed") : undefined);
    },
    closeAllConnections: (): void => undefined,
  };
}

describe("hosted runtime lifecycle", () => {
  it("does not advertise readiness until both listeners are running", async () => {
    let created = 0;
    let managementOrigin = "";
    let releaseIntake: (() => void) | undefined;
    let markIntakeBound: (() => void) | undefined;
    const intakeBound = new Promise<void>((resolve) => {
      markIntakeBound = resolve;
    });
    const starting = startHostedFeedbackIntake({
      env: environment(),
      now: () => new Date("2026-07-11T12:00:00Z"),
      poolFactory: () => ({
        connect: (): Promise<PgClientLike> => Promise.resolve(new LifecycleClient()),
        end: (): Promise<void> => Promise.resolve(),
      }),
      migrationSource: () => Promise.resolve("MIGRATION"),
      serverFactory: (handler) => {
        const kind = created++ === 0 ? "intake" : "management";
        const server = createServer(handler);
        return {
          listen: (_port, _host, callback): void => {
            server.listen(0, "127.0.0.1", () => {
              const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
              if (kind === "management") {
                managementOrigin = origin;
                callback();
              } else {
                releaseIntake = callback;
                markIntakeBound?.();
              }
            });
          },
          close: (callback): void => {
            server.close((error) => {
              callback(error ?? undefined);
            });
          },
          closeAllConnections: (): void => {
            server.closeAllConnections();
          },
        };
      },
      timer: { setInterval: () => "timer", clearInterval: () => undefined },
    });

    await intakeBound;
    expect((await fetch(`${managementOrigin}/ready`)).status).toBe(503);
    expect((await fetch(`${managementOrigin}/live`)).status).toBe(503);
    releaseIntake?.();
    const runtime = await starting;
    expect((await fetch(`${managementOrigin}/ready`)).status).toBe(200);
    await runtime.stop();
  });

  it.each(["management", "intake"] as const)(
    "rejects %s EADDRINUSE and cleans both servers plus the pool",
    async (failing) => {
      let created = 0;
      let closed = 0;
      let ended = 0;
      await expect(
        startHostedFeedbackIntake({
          env: environment(),
          now: () => new Date("2026-07-11T12:00:00Z"),
          poolFactory: () => ({
            connect: (): Promise<PgClientLike> => Promise.resolve(new LifecycleClient()),
            end: (): Promise<void> => {
              ended += 1;
              return Promise.resolve();
            },
          }),
          migrationSource: () => Promise.resolve("MIGRATION"),
          serverFactory: () => {
            const kind = created++ === 0 ? "intake" : "management";
            return listenerDouble(kind === failing ? "address-in-use" : "success", () => {
              closed += 1;
            });
          },
          timer: { setInterval: () => "unused", clearInterval: () => undefined },
        }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(closed).toBe(2);
      expect(ended).toBe(1);
    },
  );

  it("ends the pool even when shutdown server close rejects", async () => {
    let ended = 0;
    const runtime = await startHostedFeedbackIntake({
      env: environment(),
      now: () => new Date("2026-07-11T12:00:00Z"),
      poolFactory: () => ({
        connect: (): Promise<PgClientLike> => Promise.resolve(new LifecycleClient()),
        end: (): Promise<void> => {
          ended += 1;
          return Promise.resolve();
        },
      }),
      migrationSource: () => Promise.resolve("MIGRATION"),
      serverFactory: () => listenerDouble("close-error", () => undefined),
      timer: { setInterval: () => "timer", clearInterval: () => undefined },
    });

    await expect(runtime.stop()).rejects.toThrow("close failed");
    expect(ended).toBe(1);
  });

  it("awaits in-flight retention during stop without restoring readiness", async () => {
    let releasePurge: (() => void) | undefined;
    let markPurgeStarted: (() => void) | undefined;
    const purgeStarted = new Promise<void>((resolve) => {
      markPurgeStarted = resolve;
    });
    let pausePurge = false;
    let ended = 0;
    const client = new LifecycleClient();
    const query = client.query.bind(client);
    client.query = <Row extends object>(text: string): Promise<PgQueryResult<Row>> => {
      if (pausePurge && text.startsWith("DELETE FROM feedback_receipts")) {
        markPurgeStarted?.();
        return new Promise((resolve) => {
          releasePurge = (): void => {
            resolve({ rows: [], rowCount: 0 });
          };
        });
      }
      return query<Row>(text);
    };
    const runtime = await startHostedFeedbackIntake({
      env: environment(),
      now: () => new Date("2026-07-11T12:00:00Z"),
      poolFactory: () => ({
        connect: (): Promise<PgClientLike> => Promise.resolve(client),
        end: (): Promise<void> => {
          ended += 1;
          return Promise.resolve();
        },
      }),
      migrationSource: () => Promise.resolve("MIGRATION"),
      serverFactory: () => listenerDouble("success", () => undefined),
      timer: { setInterval: () => "timer", clearInterval: () => undefined },
    });
    pausePurge = true;
    const retaining = runtime.runRetention();
    await purgeStarted;
    const stopping = runtime.stop();
    await Promise.resolve();

    expect(runtime.ready()).toBe(false);
    expect(ended).toBe(0);
    releasePurge?.();
    await retaining;
    await stopping;
    expect(runtime.ready()).toBe(false);
    expect(ended).toBe(1);
  });

  it("takes the migration advisory transaction on concurrent startup", async () => {
    const clients = [new LifecycleClient(), new LifecycleClient()];
    const runtimes = await Promise.all(
      clients.map((client) =>
        startHostedFeedbackIntake({
          env: environment(),
          now: () => new Date("2026-07-11T12:00:00Z"),
          poolFactory: () => ({
            connect: (): Promise<PgClientLike> => Promise.resolve(client),
            end: (): Promise<void> => Promise.resolve(),
          }),
          migrationSource: () => Promise.resolve("MIGRATION"),
          serverFactory: () => listenerDouble("success", () => undefined),
          timer: { setInterval: () => "timer", clearInterval: () => undefined },
        }),
      ),
    );
    for (const client of clients) {
      expect(client.calls).toContain("BEGIN");
      expect(client.calls).toContain("SELECT pg_advisory_xact_lock($1)");
      expect(client.calls).toContain("COMMIT");
    }
    await Promise.all(runtimes.map((runtime) => runtime.stop()));
  });
});
