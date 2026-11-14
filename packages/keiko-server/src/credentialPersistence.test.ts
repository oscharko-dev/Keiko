// Regression coverage for the migration failure path (#3244 review, thread 12): before this test
// existed, `migrateLocalConfigCredentials`'s catch swallowed every migration failure and returned
// `{ migrated: false }` with no operator diagnostic at all — a plaintext credential configuration
// could remain in use indefinitely and nobody would ever see why. This proves the redacted,
// correlation-keyed diagnostic is emitted instead of the failure staying silent.

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SecurityLogEvent } from "@oscharko-dev/keiko-security";
import {
  migrateLocalConfigCredentials,
  persistSealedGatewayConfig,
} from "./credentialPersistence.js";
import { openProviderCredentialVault } from "./credentialVault.js";
import type { ServerDiagnosticRecord, ServerDiagnosticSink } from "./diagnostics-log.js";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "credential-persistence-migrate-"));
  dirs.push(dir);
  return dir;
}

function recordingDiagnosticSink(): {
  sink: ServerDiagnosticSink;
  records: ServerDiagnosticRecord[];
} {
  const records: ServerDiagnosticRecord[] = [];
  return {
    sink: {
      record: (record): void => {
        records.push(record);
      },
    },
    records,
  };
}

describe("migrateLocalConfigCredentials", () => {
  it("does nothing and reports no diagnostic when the config file simply does not exist", () => {
    const dir = tempConfigDir();
    const { sink, records } = recordingDiagnosticSink();

    const outcome = migrateLocalConfigCredentials({
      configPath: join(dir, "keiko.config.json"),
      env: {},
      evidenceDir: dir,
      diagnostics: sink,
    });

    expect(outcome).toEqual({ migrated: false });
    expect(records).toHaveLength(0);
  });

  it("reports a redacted, correlation-keyed diagnostic when migration fails, instead of failing silently", () => {
    const dir = tempConfigDir();
    const configPath = join(dir, "keiko.config.json");
    // Malformed JSON makes JSON.parse throw inside migrateLocalConfigCredentials's try, exercising
    // the best-effort catch without needing a real vault/provider fixture.
    writeFileSync(configPath, "{ not valid json", "utf8");
    const { sink, records } = recordingDiagnosticSink();

    const outcome = migrateLocalConfigCredentials({
      configPath,
      env: {},
      evidenceDir: dir,
      diagnostics: sink,
    });

    expect(outcome).toEqual({ migrated: false });
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record).toMatchObject({
      operation: "credential.migration",
      source: "credentialPersistence.migrateLocalConfigCredentials",
      errorClass: "SyntaxError",
    });
    expect(typeof record?.correlationId).toBe("string");
    expect(record?.correlationId.length ?? 0).toBeGreaterThan(0);
    // Redacted: never the config path or the malformed file content.
    expect(JSON.stringify(record)).not.toContain(configPath);
    expect(JSON.stringify(record)).not.toContain("not valid json");
  });
});

// One vault serves every config file of a directory (credentialVaultDir), so a seal may only give
// up what its own config named: a second config beside the first, and a credential stored by hand,
// must survive every seal. Both writers (the startup migration and Gateway Setup) go through
// persistSealedGatewayConfig, the one owner of the rule.
describe("sealing a config never deletes another config's credentials", () => {
  const KEY = Buffer.alloc(32, 0x33).toString("base64");
  const env = { KEIKO_PROVIDER_CREDENTIALS_KEY: KEY };
  function folder(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "credential-shared-vault-")));
    dirs.push(dir);
    return dir;
  }
  function seal(path: string, models: readonly string[], sink?: SecurityLogEvent[]): void {
    persistSealedGatewayConfig(
      {
        providers: models.map((modelId) => ({
          modelId,
          baseUrl: "https://gateway.example.invalid",
          apiKey: `secret-of-${modelId}`,
        })),
      },
      {
        env,
        storagePath: path,
        evidenceDir: join(dirname(path), "evidence"),
        ...(sink === undefined
          ? {}
          : {
              securityLogSink: {
                write: (event: SecurityLogEvent): void => {
                  sink.push(event);
                },
              },
            }),
      },
    );
  }
  const stored = (path: string): readonly string[] =>
    [...openProviderCredentialVault({ configPath: path, env }).list()].sort();

  it("keeps the other config's credentials when one config is sealed (the defect)", () => {
    const dir = folder();
    const first = join(dir, "keiko.config.json");
    const second = join(dir, "keiko.local.config.json");
    seal(first, ["gemma", "qwen", "whisper"]);
    expect(stored(first)).toEqual(["cred:gemma", "cred:qwen", "cred:whisper"]);
    // A narrower config beside it is sealed: it names only one model.
    seal(second, ["gpt"]);
    expect(stored(first)).toEqual(["cred:gemma", "cred:gpt", "cred:qwen", "cred:whisper"]);
    expect(openProviderCredentialVault({ configPath: first, env }).get("cred:gemma")).toBe(
      "secret-of-gemma",
    );
  });

  it("still prunes a reference removed from the config being sealed, and reports counts only", () => {
    const dir = folder();
    const first = join(dir, "keiko.config.json");
    const second = join(dir, "keiko.local.config.json");
    seal(first, ["gemma", "qwen"]);
    seal(second, ["gpt"]);
    const events: SecurityLogEvent[] = [];
    // The first config gives up qwen: only its own reference goes, the second config's stays.
    seal(first, ["gemma"], events);
    expect(stored(first)).toEqual(["cred:gemma", "cred:gpt"]);
    const deleted = events.filter((event) => event.op === "security.vault.entries-deleted");
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({ extra: { count: 1, foreignRetainedCount: 1 } });
    expect(JSON.stringify(events)).not.toMatch(/secret-of|cred:/u);
  });

  it("prunes nothing on the first seal of a config, and says it left a foreign entry", () => {
    const dir = folder();
    const first = join(dir, "keiko.config.json");
    seal(first, ["gemma"]);
    const events: SecurityLogEvent[] = [];
    expect(existsSync(join(dir, "keiko.local.config.json"))).toBe(false);
    seal(join(dir, "keiko.local.config.json"), ["gpt"], events);
    expect(stored(first)).toEqual(["cred:gemma", "cred:gpt"]);
    const deleted = events.filter((event) => event.op === "security.vault.entries-deleted");
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({ extra: { count: 0, foreignRetainedCount: 1 } });
  });

  it("prunes nothing when the previous config cannot be read", () => {
    const dir = folder();
    const first = join(dir, "keiko.config.json");
    const second = join(dir, "keiko.local.config.json");
    seal(first, ["gemma"]);
    writeFileSync(second, "{ not valid json", "utf8");
    seal(second, ["gpt"]);
    expect(stored(first)).toEqual(["cred:gemma", "cred:gpt"]);
    expect(readFileSync(second, "utf8")).toContain("cred:gpt");
  });

  it("the startup migration leaves the credentials of the config beside it", () => {
    const dir = folder();
    const first = join(dir, "keiko.config.json");
    seal(first, ["gemma", "qwen"]);
    const second = join(dir, "keiko.local.config.json");
    writeFileSync(
      second,
      JSON.stringify({
        providers: [
          { modelId: "gpt", baseUrl: "https://gateway.example.invalid", apiKey: "plain" },
        ],
      }),
      "utf8",
    );
    expect(migrateLocalConfigCredentials({ configPath: second, env, evidenceDir: dir })).toEqual({
      migrated: true,
    });
    expect(stored(first)).toEqual(["cred:gemma", "cred:gpt", "cred:qwen"]);
  });
});
