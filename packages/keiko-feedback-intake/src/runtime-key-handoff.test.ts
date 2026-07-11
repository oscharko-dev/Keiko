import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

function fixture(): {
  readonly env: Record<string, string>;
  readonly abuse: string;
  readonly dedupe: string;
} {
  const root = mkdtempSync(join(tmpdir(), "feedback-key-handoff-"));
  roots.push(root);
  chmodSync(root, 0o700);
  const abuse = join(root, "abuse");
  const dedupe = join(root, "dedupe");
  mkdirSync(abuse, { mode: 0o700 });
  mkdirSync(dedupe, { mode: 0o700 });
  writeKey(abuse, "abuse", "2026-07-09", 1);
  writeKey(abuse, "abuse", "2026-07-10", 2);
  writeKey(dedupe, "dedupe", "2026-01-02", 3);
  writeKey(dedupe, "dedupe", "2026-04-02", 4);
  writeKey(dedupe, "dedupe", "2026-07-01", 5);
  return {
    abuse,
    dedupe,
    env: {
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
      KEIKO_FEEDBACK_SECRET_DIR: root,
      KEIKO_FEEDBACK_RETENTION_INTERVAL_MS: "60000",
    },
  };
}

class KeyHandoffClient implements PgClientLike {
  readonly evidence: string[] = [];
  readonly live = { abuse: [] as string[], dedupe: [] as string[] };
  releases = 0;
  private result: "pending" | "destroyed" | undefined;

  constructor(private readonly ready: () => boolean) {}

  query<Row extends object>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    if (text.includes("to_regclass")) return rows([{ name: null }] as Row[]);
    if (text.startsWith("SELECT key_class")) return rows([]);
    if (text.startsWith("SELECT DISTINCT key_id")) {
      return rows(this.live.abuse.map((key_id) => ({ key_id }) as Row));
    }
    if (text.startsWith("SELECT DISTINCT dedupe_key_id")) {
      return rows(this.live.dedupe.map((key_id) => ({ key_id }) as Row));
    }
    if (text.startsWith("SELECT 1 FROM feedback_")) return rows([]);
    if (text.includes("INSERT INTO feedback_key_deletion_evidence")) {
      this.result = "pending";
      this.evidence.push(`pending:${String(values[1])}:${String(this.ready())}`);
      return rows([{ result: this.result }] as Row[]);
    }
    if (text.includes("UPDATE feedback_key_deletion_evidence")) {
      this.result = "destroyed";
      this.evidence.push(`destroyed:${String(values[1])}:${String(this.ready())}`);
      return rows([{ result: this.result }] as Row[]);
    }
    return rows(text.startsWith("DELETE") ? [] : ([{}] as Row[]));
  }

  release(): void {
    this.releases += 1;
  }
}

function rows<Row extends object>(items: readonly Row[]): Promise<PgQueryResult<Row>> {
  return Promise.resolve({ rows: items, rowCount: items.length });
}

describe("feedback key handoff boundary", () => {
  it("keeps intake unready until every live database key has mounted custody", async () => {
    const setup = fixture();
    let readiness = (): boolean => false;
    const client = new KeyHandoffClient(() => readiness());
    let intakeOrigin = "";
    const runtime = await startHostedFeedbackIntake({
      env: setup.env,
      now: () => new Date("2026-07-10T12:00:00Z"),
      poolFactory: () => ({
        connect: (): Promise<PgClientLike> => Promise.resolve(client),
        end: (): Promise<void> => Promise.resolve(),
      }),
      migrationSource: () => Promise.resolve("MIGRATION"),
      serverFactory: (handler) => {
        const server = createServer(handler);
        return {
          listen: (port, _host, callback): void => {
            server.listen(0, "127.0.0.1", () => {
              if (port === 12345) {
                intakeOrigin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
              }
              callback();
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
    readiness = (): boolean => runtime.ready();

    client.live.dedupe = ["dedupe-v1:2026-01-02"];
    rmSync(join(setup.dedupe, "dedupe-2026-01-02.json"));
    await expect(runtime.runRetention()).rejects.toThrow("custody");
    expect(runtime.ready()).toBe(false);
    expect(
      (
        await fetch(`${intakeOrigin}/v1/feedback/reports`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(503);

    writeKey(setup.dedupe, "dedupe", "2026-01-02", 3);
    await runtime.runRetention();
    expect(runtime.ready()).toBe(true);
    client.live.abuse = ["2026-07-08"];
    await expect(runtime.runRetention()).rejects.toThrow("custody");
    expect(runtime.ready()).toBe(false);

    client.live.abuse = [];
    client.live.dedupe = [];
    rmSync(join(setup.dedupe, "dedupe-2026-01-02.json"));
    await runtime.runRetention();
    expect(runtime.ready()).toBe(true);
    await runtime.stop();
  });

  it("records retirement before external activation and admits nothing in the gap", async () => {
    const setup = fixture();
    let readiness = (): boolean => false;
    const client = new KeyHandoffClient(() => readiness());
    let time = new Date("2026-07-10T12:00:00Z");
    let intakeOrigin = "";
    const runtime = await startHostedFeedbackIntake({
      env: setup.env,
      now: () => time,
      poolFactory: () => ({
        connect: (): Promise<PgClientLike> => Promise.resolve(client),
        end: (): Promise<void> => Promise.resolve(),
      }),
      migrationSource: () => Promise.resolve("MIGRATION"),
      serverFactory: (handler) => {
        const server = createServer(handler);
        return {
          listen: (port, _host, callback): void => {
            server.listen(0, "127.0.0.1", () => {
              if (port === 12345) {
                intakeOrigin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
              }
              callback();
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
    readiness = (): boolean => runtime.ready();

    time = new Date("2026-07-11T00:00:00Z");
    await expect(runtime.runRetention()).rejects.toThrow("custody");
    expect(runtime.ready()).toBe(false);
    expect(client.evidence).toEqual(["pending:2026-07-09:false", "destroyed:2026-07-09:false"]);
    expect(readdirSync(setup.abuse)).toEqual(["abuse-2026-07-10.json"]);
    expect(
      (
        await fetch(`${intakeOrigin}/v1/feedback/reports`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(503);

    writeKey(setup.abuse, "abuse", "2026-07-11", 6);
    await runtime.runRetention();
    expect(runtime.ready()).toBe(true);
    expect(readdirSync(setup.abuse).sort()).toEqual([
      "abuse-2026-07-10.json",
      "abuse-2026-07-11.json",
    ]);
    await runtime.stop();
  });
});
