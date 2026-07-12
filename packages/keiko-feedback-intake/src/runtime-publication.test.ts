import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PgClientLike, PgQueryResult } from "./postgres.js";
import type { FeedbackPublicationRuntimeOptions } from "./feedback-publication-runtime.js";
import { startHostedFeedbackIntake } from "./runtime.js";
import type { RuntimePool } from "./runtime-pools.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeCustodyKey(root: string, kind: "abuse" | "dedupe", date: string, fill: number): void {
  writeFileSync(
    join(root, kind, `${kind}-${date}.json`),
    JSON.stringify({
      id: `${kind === "dedupe" ? "dedupe-v1:" : ""}${date}`,
      activatedAt: `${date}T00:00:00.000Z`,
      key: Buffer.alloc(32, fill).toString("base64"),
    }),
    { mode: 0o600 },
  );
}

function configuredEnvironment(): Record<string, string> {
  const root = mkdtempSync(join(tmpdir(), "publication-runtime-"));
  roots.push(root);
  chmodSync(root, 0o700);
  mkdirSync(join(root, "abuse"), { mode: 0o700 });
  mkdirSync(join(root, "dedupe"), { mode: 0o700 });
  writeCustodyKey(root, "abuse", "2026-07-10", 1);
  writeCustodyKey(root, "abuse", "2026-07-11", 2);
  writeCustodyKey(root, "dedupe", "2026-01-02", 3);
  writeCustodyKey(root, "dedupe", "2026-04-02", 4);
  writeCustodyKey(root, "dedupe", "2026-07-01", 5);
  const keyFile = join(root, "github.pem");
  const policyFile = join(root, "targets.json");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  writeFileSync(
    policyFile,
    JSON.stringify({
      version: 1,
      targets: [
        {
          targetKey: "public",
          installationId: "123",
          repositoryId: "456",
          owner: "owner",
          repository: "repository",
          labels: ["feedback"],
          labelPolicyVersion: "labels-v1",
          targetPolicyVersion: "target-v1",
        },
      ],
    }),
    { mode: 0o600 },
  );
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
    KEIKO_FEEDBACK_RETENTION_INTERVAL_MS: "60000",
    KEIKO_FEEDBACK_PROXY_FAMILY: "forwarded",
    KEIKO_FEEDBACK_SECRET_DIR: root,
    KEIKO_FEEDBACK_GITHUB_APP_ID: "42",
    KEIKO_FEEDBACK_GITHUB_PRIVATE_KEY_FILE: keyFile,
    KEIKO_FEEDBACK_GITHUB_TARGETS_POLICY_FILE: policyFile,
    KEIKO_FEEDBACK_GITHUB_PRIVATE_KEY_ROTATED_AT: "2026-07-01T00:00:00Z",
    KEIKO_FEEDBACK_GITHUB_MAX_CONCURRENT_DELIVERIES: "2",
  };
}

function configuredMaintainerEnvironment(): Record<string, string> {
  return {
    ...configuredEnvironment(),
    KEIKO_FEEDBACK_MAINTAINER_ENABLED: "true",
    KEIKO_FEEDBACK_MAINTAINER_HOST: "127.0.0.1",
    KEIKO_FEEDBACK_MAINTAINER_PORT: "12347",
    KEIKO_FEEDBACK_MAINTAINER_PUBLIC_ORIGIN: "https://maintainer.example",
    KEIKO_FEEDBACK_MAINTAINER_OIDC_ISSUER: "https://idp.example/tenant/",
    KEIKO_FEEDBACK_MAINTAINER_OIDC_CLIENT_ID: "keiko",
    KEIKO_FEEDBACK_MAINTAINER_OIDC_CLIENT_SECRET_FILE: "/unused/oidc",
    KEIKO_FEEDBACK_MAINTAINER_OIDC_CLIENT_AUTH_METHOD: "client_secret_basic",
    KEIKO_FEEDBACK_MAINTAINER_OIDC_ID_TOKEN_ALG: "RS256",
    KEIKO_FEEDBACK_MAINTAINER_OIDC_REDIRECT_URI:
      "https://maintainer.example/v1/maintainer/auth/callback",
    KEIKO_FEEDBACK_MAINTAINER_PERMISSION_CLAIM: "groups",
    KEIKO_FEEDBACK_MAINTAINER_PERMISSION_RULES_JSON:
      '{"publishers":["feedback.review","feedback.publish"]}',
    KEIKO_FEEDBACK_MAINTAINER_PERMISSION_POLICY_VERSION: "policy-v1",
    KEIKO_FEEDBACK_MAINTAINER_LEGAL_HOLD_POLICIES_JSON: "[]",
    KEIKO_FEEDBACK_MAINTAINER_SESSION_IDLE_MS: "60000",
    KEIKO_FEEDBACK_MAINTAINER_SESSION_ABSOLUTE_MS: "120000",
    KEIKO_FEEDBACK_MAINTAINER_LOGIN_PER_SOURCE_LIMIT: "5",
    KEIKO_FEEDBACK_MAINTAINER_LOGIN_GLOBAL_LIMIT: "20",
    KEIKO_FEEDBACK_MAINTAINER_LOGIN_WINDOW_MS: "60000",
    KEIKO_FEEDBACK_MAINTAINER_LOGIN_CONCURRENCY_LIMIT: "4",
  };
}

class RuntimeClient implements PgClientLike {
  query<Row extends object>(text: string): Promise<PgQueryResult<Row>> {
    if (text.includes("to_regclass")) return result([{ name: null }] as Row[]);
    if (text.startsWith("SELECT key_class") || text.startsWith("SELECT DISTINCT"))
      return result([]);
    return result([{} as Row]);
  }
  release(): void {
    return undefined;
  }
}

function result<Row extends object>(rows: readonly Row[]): Promise<PgQueryResult<Row>> {
  return Promise.resolve({ rows, rowCount: rows.length });
}

describe("publication runtime composition", () => {
  it("inspects before listeners, uses isolated exact-size pools, and drains before pool close", async () => {
    const events: string[] = [];
    const maximums: number[] = [];
    let publicationOptions: FeedbackPublicationRuntimeOptions | undefined;
    const runtime = await startHostedFeedbackIntake({
      env: configuredMaintainerEnvironment(),
      now: () => new Date("2026-07-11T12:00:00Z"),
      poolFactory: (_url, maximum): RuntimePool => {
        const index = maximums.length;
        maximums.push(maximum);
        return {
          connect: (): Promise<PgClientLike> => Promise.resolve(new RuntimeClient()),
          end: (): Promise<void> => {
            events.push(`pool-end-${String(index)}`);
            return Promise.resolve();
          },
        };
      },
      migrationSources: (): Promise<readonly { version: number; source: string }[]> =>
        Promise.resolve([{ version: 1, source: "MIGRATION" }]),
      publicationRuntimeFactory: (options: FeedbackPublicationRuntimeOptions) => {
        publicationOptions = options;
        return {
          inspectReadiness: (): Promise<void> => {
            events.push("inspect");
            return Promise.resolve();
          },
          start: (): void => {
            events.push("publication-start");
          },
          stop: (): Promise<void> => {
            events.push("publication-stop");
            return Promise.reject(new Error("publication drain failed"));
          },
        };
      },
      maintainerOidcClient: {
        begin: () => Promise.reject(new Error("unused")),
        exchange: () => Promise.reject(new Error("unused")),
      },
      serverFactory: () => ({
        listen: (_port, _host, callback): void => {
          events.push("listen");
          callback();
        },
        close: (callback): void => {
          events.push("server-close");
          callback();
        },
      }),
      timer: { setInterval: () => "timer", clearInterval: () => undefined },
    });
    expect(maximums).toEqual([6, 4, 2, 2]);
    expect(events.slice(0, 5)).toEqual([
      "inspect",
      "listen",
      "listen",
      "listen",
      "publication-start",
    ]);
    expect(runtime.ready()).toBe(true);
    expect(runtime.publicationReady()).toBe(true);
    publicationOptions?.onHealthChange?.(false);
    expect(runtime.ready()).toBe(true);
    expect(runtime.publicationReady()).toBe(false);
    publicationOptions?.onHealthChange?.(true);
    expect(runtime.publicationReady()).toBe(true);
    await expect(runtime.stop()).rejects.toThrow("publication drain failed");
    expect(events.indexOf("publication-stop")).toBeLessThan(events.indexOf("pool-end-2"));
    expect(events).toContain("server-close");
    expect(runtime.ready()).toBe(false);
    expect(runtime.publicationReady()).toBe(false);
  });

  it("fails readiness before listeners and closes every allocated pool", async () => {
    let listeners = 0;
    let ended = 0;
    await expect(
      startHostedFeedbackIntake({
        env: configuredEnvironment(),
        now: () => new Date("2026-07-11T12:00:00Z"),
        poolFactory: (): RuntimePool => ({
          connect: (): Promise<PgClientLike> => Promise.resolve(new RuntimeClient()),
          end: (): Promise<void> => {
            ended += 1;
            return Promise.resolve();
          },
        }),
        migrationSources: (): Promise<readonly { version: number; source: string }[]> =>
          Promise.resolve([{ version: 1, source: "MIGRATION" }]),
        publicationRuntimeFactory: () => ({
          inspectReadiness: (): Promise<void> => Promise.reject(new Error("unready")),
          start: (): void => undefined,
          stop: (): Promise<void> => Promise.resolve(),
        }),
        serverFactory: () => ({
          listen: (): void => {
            listeners += 1;
          },
          close: (callback): void => {
            callback();
          },
        }),
      }),
    ).rejects.toThrow("unready");
    expect(listeners).toBe(0);
    expect(ended).toBe(3);
  });
});
