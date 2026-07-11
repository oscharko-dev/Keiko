import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareFeedbackReportV1,
  type PreparedFeedbackReportV1,
} from "@oscharko-dev/keiko-security/feedback-report";
import { afterEach, describe, expect, it } from "vitest";
import { startHostedFeedbackIntake } from "./runtime.js";
import type { PgClientLike, PgPoolLike, PgQueryResult } from "./postgres.js";

const secretRoots: string[] = [];
afterEach(() => {
  for (const root of secretRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeKey(directory: string, kind: "abuse" | "dedupe", date: string, fill: number): void {
  const id = `${kind === "dedupe" ? "dedupe-v1:" : ""}${date}`;
  const path = join(directory, `${kind}-${date}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      id,
      activatedAt: `${date}T00:00:00.000Z`,
      key: Buffer.alloc(32, fill).toString("base64"),
    }),
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
}

function secretDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-feedback-secrets-"));
  secretRoots.push(root);
  chmodSync(root, 0o700);
  const abuse = join(root, "abuse");
  const dedupe = join(root, "dedupe");
  mkdirSync(abuse, { mode: 0o700 });
  mkdirSync(dedupe, { mode: 0o700 });
  writeKey(abuse, "abuse", "2026-07-10", 6);
  writeKey(abuse, "abuse", "2026-07-11", 7);
  writeKey(dedupe, "dedupe", "2026-01-02", 8);
  writeKey(dedupe, "dedupe", "2026-04-02", 9);
  writeKey(dedupe, "dedupe", "2026-07-01", 10);
  return root;
}

function env(): Record<string, string> {
  return {
    KEIKO_FEEDBACK_HOST: "127.0.0.1",
    KEIKO_FEEDBACK_PORT: "12345",
    KEIKO_FEEDBACK_MANAGEMENT_HOST: "127.0.0.1",
    KEIKO_FEEDBACK_MANAGEMENT_PORT: "12346",
    DATABASE_URL: "postgres://unused",
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
    KEIKO_FEEDBACK_SECRET_DIR: secretDirectory(),
    KEIKO_FEEDBACK_RETENTION_INTERVAL_MS: "60000",
  };
}

function prepared(): PreparedFeedbackReportV1 {
  const result = prepareFeedbackReportV1({
    schemaVersion: "1",
    category: "defect",
    title: "Runtime",
    description: "Hosted runtime path.",
    reproductionSteps: "Submit feedback.",
    expectedBehavior: "Accepted.",
    actualBehavior: "Ready.",
    productVersion: "0.2.14",
    platform: "Linux",
    featureArea: "model-configuration",
    impact: "Degrades core workflow",
  });
  if (!result.ok) throw new Error("fixture");
  return result.value;
}

class RuntimeClient implements PgClientLike {
  readonly calls: string[] = [];
  receiptHash: Uint8Array | undefined;
  receiptExpiry: Date | undefined;
  failPurge = false;
  failAttempt = false;
  query<Row extends object>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    this.calls.push(text);
    if (this.failPurge && text.startsWith("DELETE FROM feedback_receipts")) {
      return Promise.reject(new Error("database unavailable"));
    }
    if (this.failAttempt && text.includes("feedback_abuse_buckets")) {
      return Promise.reject(new Error("database unavailable"));
    }
    const selected = this.selected<Row>(text, values);
    if (selected !== undefined) return selected;
    if (text.startsWith("INSERT INTO feedback_receipts")) {
      this.receiptHash = values[2] as Uint8Array;
      this.receiptExpiry = values[4] as Date;
    }
    if (text.startsWith("SELECT secret_hash"))
      return result(
        this.receiptHash === undefined
          ? []
          : ([
              { secret_hash: this.receiptHash, expires_at: this.receiptExpiry, closed: false },
            ] as Row[]),
      );
    return result([{} as Row]);
  }
  private selected<Row extends object>(
    text: string,
    values: readonly unknown[],
  ): Promise<PgQueryResult<Row>> | undefined {
    if (text.includes("to_regclass")) return result([{ name: null }] as Row[]);
    if (text.startsWith("SELECT key_class")) return result([]);
    if (text.startsWith("SELECT DISTINCT")) return result([]);
    if (text.startsWith("SELECT count")) return result([{ count: "0", bytes: "0" }] as Row[]);
    if (text.startsWith("SELECT id FROM feedback_semantic_groups")) return result([]);
    if (text.includes("feedback_semantic_groups") && text.includes("RETURNING id"))
      return result([{ id: values[0] }] as Row[]);
    return text.startsWith("SELECT id, expires_at FROM feedback_payloads") ? result([]) : undefined;
  }
  release(): void {
    this.calls.push("RELEASE");
  }
}

function result<Row extends object>(rows: readonly Row[]): Promise<PgQueryResult<Row>> {
  return Promise.resolve({ rows, rowCount: rows.length });
}

describe("hosted production runtime composition", () => {
  it("routes POST and receipt GET through PostgreSQL, runs retention, and shuts down", async () => {
    const client = new RuntimeClient();
    const runtimeEnv = env();
    let ended = 0;
    let cleared = 0;
    let poolMaximum = 0;
    let origin = "";
    let managementOrigin = "";
    const pool: PgPoolLike & { end(): Promise<void> } = {
      connect: () => Promise.resolve(client),
      end: () => {
        ended += 1;
        return Promise.resolve();
      },
    };
    const runtime = await startHostedFeedbackIntake({
      env: runtimeEnv,
      now: () => new Date("2026-07-11T12:00:00Z"),
      poolFactory: (_databaseUrl, maximum) => {
        poolMaximum = maximum;
        return pool;
      },
      migrationSource: () => Promise.resolve("MIGRATION"),
      serverFactory: (handler) => {
        const instance = createServer(handler);
        return {
          listen: (port, _host, callback): void => {
            instance.listen(0, "127.0.0.1", () => {
              const address = `http://127.0.0.1:${String((instance.address() as AddressInfo).port)}`;
              if (port === 12346) managementOrigin = address;
              else origin = address;
              callback();
            });
          },
          close: (callback): void => {
            instance.close((error) => {
              callback(error ?? undefined);
            });
          },
          closeAllConnections: (): void => {
            instance.closeAllConnections();
          },
        };
      },
      timer: {
        setInterval: () => "timer",
        clearInterval: () => {
          cleared += 1;
        },
      },
    });
    const report = prepared();
    expect(await (await fetch(`${managementOrigin}/live`)).json()).toEqual({ status: "ok" });
    expect(poolMaximum).toBe(6);
    expect((await fetch(`${managementOrigin}/ready`)).status).toBe(200);
    expect((await fetch(`${managementOrigin}/v1/feedback/reports`)).status).toBe(404);
    const post = await fetch(`${origin}/v1/feedback/reports`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "keiko-feedback-body-sha256": report.exactBodySha256,
      },
      body: report.canonicalJson,
    });
    expect(
      post.status,
      JSON.stringify({ body: await post.clone().text(), calls: client.calls }),
    ).toBe(202);
    const capability = (await post.json()) as { receiptId: string; receiptSecret: string };
    const get = await fetch(`${origin}/v1/feedback/receipts/${capability.receiptId}`, {
      headers: { authorization: `Keiko-Receipt ${capability.receiptSecret}` },
    });
    expect(get.status).toBe(200);
    expect(client.calls).toContain("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await runtime.runRetention();
    expect(client.calls.some((call) => call.startsWith("DELETE FROM feedback_receipts"))).toBe(
      true,
    );
    expect(
      client.calls.some((call) => call.startsWith("DELETE FROM feedback_key_deletion_evidence")),
    ).toBe(true);
    expect(runtime.ready()).toBe(true);
    client.failPurge = true;
    await expect(runtime.runRetention()).rejects.toThrow("database unavailable");
    expect(runtime.ready()).toBe(false);
    expect((await fetch(`${managementOrigin}/ready`)).status).toBe(503);
    expect((await fetch(`${managementOrigin}/live`)).status).toBe(200);
    const blockedBeforeReplay = await fetch(`${origin}/v1/feedback/reports`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "keiko-feedback-body-sha256": report.exactBodySha256,
      },
      body: report.canonicalJson,
    });
    expect(blockedBeforeReplay.status).toBe(503);
    expect(await blockedBeforeReplay.json()).toEqual({ error: "temporarily-unavailable" });
    expect(
      (
        await fetch(`${origin}/v1/feedback/receipts/${capability.receiptId}`, {
          headers: { authorization: `Keiko-Receipt ${capability.receiptSecret}` },
        })
      ).status,
    ).toBe(200);
    client.failPurge = false;
    await runtime.runRetention();
    client.failAttempt = true;
    const unavailable = await fetch(`${origin}/v1/feedback/reports`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "keiko-feedback-body-sha256": report.exactBodySha256,
      },
      body: report.canonicalJson,
    });
    expect(unavailable.status).toBe(503);
    expect(runtime.ready()).toBe(false);
    client.failAttempt = false;
    await runtime.runRetention();
    expect(runtime.ready()).toBe(true);
    const secretRoot = runtimeEnv.KEIKO_FEEDBACK_SECRET_DIR;
    if (secretRoot === undefined) throw new Error("Expected feedback secret fixture");
    unlinkSync(join(secretRoot, "dedupe", "dedupe-2026-07-01.json"));
    const unavailableDedupe = await fetch(`${origin}/v1/feedback/reports`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "keiko-feedback-body-sha256": report.exactBodySha256,
      },
      body: report.canonicalJson,
    });
    expect(unavailableDedupe.status).toBe(503);
    expect(await unavailableDedupe.json()).toEqual({ error: "temporarily-unavailable" });
    expect(runtime.ready()).toBe(false);
    expect((await fetch(`${managementOrigin}/ready`)).status).toBe(503);
    await runtime.stop();
    expect(runtime.ready()).toBe(false);
    expect(cleared).toBe(1);
    expect(ended).toBe(1);
  });

  it("bounds forced drain and releases the pool", async () => {
    const client = new RuntimeClient();
    let forced = 0;
    let ended = 0;
    const runtime = await startHostedFeedbackIntake({
      env: env(),
      now: () => new Date("2026-07-11T12:00:00Z"),
      poolFactory: () => ({
        connect: (): Promise<PgClientLike> => Promise.resolve(client),
        end: (): Promise<void> => {
          ended += 1;
          return Promise.resolve();
        },
      }),
      migrationSource: () => Promise.resolve("MIGRATION"),
      serverFactory: () => ({
        listen: (_port, _host, callback): void => {
          callback();
        },
        close: (): void => undefined,
        closeAllConnections: (): void => {
          forced += 1;
        },
      }),
      timer: { setInterval: () => "timer", clearInterval: (): void => undefined },
    });
    expect(runtime.ready()).toBe(true);
    await runtime.stop();
    expect(forced).toBe(2);
    expect(ended).toBe(1);
  });

  it("fails before pool/listener creation for missing config and closes pool on migration failure", async () => {
    let pools = 0;
    let listeners = 0;
    let ended = 0;
    await expect(
      startHostedFeedbackIntake({
        env: {},
        poolFactory: () => {
          pools += 1;
          throw new Error("must not run");
        },
      }),
    ).rejects.toThrow("Missing");
    expect(pools).toBe(0);
    const client: PgClientLike = {
      query: () => Promise.reject(new Error("migration failed")),
      release: () => undefined,
    };
    await expect(
      startHostedFeedbackIntake({
        env: env(),
        poolFactory: () => ({
          connect: (): Promise<PgClientLike> => Promise.resolve(client),
          end: (): Promise<void> => {
            ended += 1;
            return Promise.resolve();
          },
        }),
        migrationSource: () => Promise.resolve("MIGRATION"),
        serverFactory: () => {
          listeners += 1;
          throw new Error("must not listen");
        },
      }),
    ).rejects.toThrow("migration failed");
    expect(listeners).toBe(0);
    expect(ended).toBe(1);
  });

  it("fails closed before pool creation when key classes overlap", async () => {
    const invalid = env();
    writeKey(join(invalid.KEIKO_FEEDBACK_SECRET_DIR ?? "", "dedupe"), "dedupe", "2026-01-02", 6);
    let ended = 0;
    let listeners = 0;
    const client = new RuntimeClient();
    await expect(
      startHostedFeedbackIntake({
        env: invalid,
        now: () => new Date("2026-07-11T12:00:00Z"),
        poolFactory: () => ({
          connect: (): Promise<PgClientLike> => Promise.resolve(client),
          end: (): Promise<void> => {
            ended += 1;
            return Promise.resolve();
          },
        }),
        migrationSource: () => Promise.resolve("MIGRATION"),
        serverFactory: () => {
          listeners += 1;
          throw new Error("must not listen");
        },
      }),
    ).rejects.toThrow("independent");
    expect(listeners).toBe(0);
    expect(ended).toBe(1);
  });
});
