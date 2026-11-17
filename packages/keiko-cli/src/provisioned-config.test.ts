import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SecurityLogEvent } from "@oscharko-dev/keiko-security";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import {
  PROVISIONED_CONFIG_MAX_BYTES,
  adoptProvisionedConfig,
  provisionedConfigMessage,
  type ProvisionedConfigOutcome,
} from "./provisioned-config.js";

// A standalone folder package ships an administrator's keiko.config.json next to its start files
// (ADR-0121 D9). `keiko start --provisioned-config` adopts it when it is new or changed. These tests
// drive the real adoption against real files and read the one activity line it leaves.

const SECRET = "sk-provisioned-secret-never-in-a-log";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  readonly source: string;
  readonly stateDir: string;
  readonly configPath: string;
  readonly markerPath: string;
  readonly events: SecurityLogEvent[];
  readonly adopt: (
    overrides?: Partial<{ running: boolean; env: Record<string, string>; source: string }>,
  ) => Promise<ProvisionedConfigOutcome>;
}

function configText(apiKey = SECRET): string {
  return JSON.stringify({
    providers: [{ modelId: "chat-model", baseUrl: "https://gateway.example.test", apiKey }],
  });
}

/** `null` leaves the provisioned file absent, for the test to put something else in its place. */
function fixture(content: string | null = configText()): Fixture {
  const root = mkdtempSync(join(tmpdir(), "keiko-provisioned-config-"));
  roots.push(root);
  const source = join(root, "package", "keiko.config.json");
  mkdirSync(join(root, "package"));
  if (content !== null) writeFileSync(source, content);
  const stateDir = join(root, "state");
  const events: SecurityLogEvent[] = [];
  return {
    source,
    stateDir,
    configPath: join(stateDir, "ui", "keiko.config.json"),
    markerPath: join(stateDir, "ui", "provisioned-config.sha256"),
    events,
    adopt: async (overrides = {}): Promise<ProvisionedConfigOutcome> =>
      (
        await adoptProvisionedConfig({
          sourcePath: overrides.source ?? source,
          stateDir,
          env: overrides.env ?? {},
          running: overrides.running ?? false,
          securityLogSink: { write: (event): void => void events.push(event) },
        })
      ).outcome,
  };
}

function lastLine(subject: Fixture): Record<string, unknown> {
  const line = formatActivityLogProofLine(subject.events.at(-1) ?? {});
  expect(line).not.toContain(SECRET);
  expect(line).not.toContain(subject.source);
  return expectActivityLogProof("cli.lifecycle.provisioned-config.outcome", line);
}

describe("adoption of a provisioned gateway configuration", () => {
  it("adopts a new file byte for byte, privately, and records only the outcome", async () => {
    const subject = fixture();

    expect(await subject.adopt()).toBe("adopted");

    expect(readFileSync(subject.configPath, "utf8")).toBe(configText());
    // The marker is the digest of the provisioned file and nothing else.
    expect(readFileSync(subject.markerPath, "utf8")).toBe(
      `${createHash("sha256").update(configText()).digest("hex")}\n`,
    );
    if (process.platform !== "win32") {
      expect(statSync(subject.configPath).mode & 0o777).toBe(0o600);
      expect(statSync(subject.markerPath).mode & 0o777).toBe(0o600);
    }
    expect(readdirSync(join(subject.stateDir, "ui")).sort()).toEqual([
      "keiko.config.json",
      "provisioned-config.sha256",
    ]);
    expect(subject.events).toHaveLength(1);
    expect(lastLine(subject)).toMatchObject({ level: "info", outcome: "adopted" });
    expect(lastLine(subject)).not.toHaveProperty("failureKind");
  });

  it("leaves the configuration alone when the same file was adopted before", async () => {
    const subject = fixture();
    await subject.adopt();
    // The server rewrites the adopted copy (it seals the key), so the copy no longer equals the
    // provisioned file. "Unchanged" must follow the provisioned file, never the copy.
    writeFileSync(subject.configPath, '{"providers":[{"modelId":"chat-model"}]}');

    expect(await subject.adopt()).toBe("unchanged");

    expect(readFileSync(subject.configPath, "utf8")).toBe(
      '{"providers":[{"modelId":"chat-model"}]}',
    );
    expect(lastLine(subject)).toMatchObject({ level: "info", outcome: "unchanged" });
  });

  it("adopts again when the administrator ships a changed file", async () => {
    const subject = fixture();
    await subject.adopt();
    writeFileSync(subject.source, configText("sk-rotated-key"));

    expect(await subject.adopt()).toBe("adopted");

    expect(readFileSync(subject.configPath, "utf8")).toBe(configText("sk-rotated-key"));
    expect(await subject.adopt()).toBe("unchanged");
  });

  it("does not write under a running Keiko, and adopts on the next start", async () => {
    const subject = fixture();

    expect(await subject.adopt({ running: true })).toBe("deferred-running");
    expect(existsSync(subject.configPath)).toBe(false);
    expect(existsSync(subject.markerPath)).toBe(false);
    expect(lastLine(subject)).toMatchObject({ level: "info", outcome: "deferred-running" });

    expect(await subject.adopt()).toBe("adopted");
  });

  it("adopts again when the marker is unreadable", async () => {
    const subject = fixture();
    await subject.adopt();
    writeFileSync(subject.markerPath, "not a digest");

    expect(await subject.adopt()).toBe("adopted");
    expect(await subject.adopt()).toBe("unchanged");
  });

  it.each(["KEIKO_CONFIG_FILE", "KEIKO_UI_DATA_DIR"])(
    "stands back when %s names another configuration location",
    async (name) => {
      const subject = fixture();

      expect(await subject.adopt({ env: { [name]: join(subject.stateDir, "elsewhere") } })).toBe(
        "overridden",
      );

      expect(existsSync(subject.configPath)).toBe(false);
      expect(lastLine(subject)).toMatchObject({ level: "info", outcome: "overridden" });
    },
  );

  it("reports an absent file without touching the state directory", async () => {
    const subject = fixture(null);

    expect(await subject.adopt()).toBe("absent");

    expect(existsSync(subject.stateDir)).toBe(false);
    expect(lastLine(subject)).toMatchObject({ level: "info", outcome: "absent" });
  });
});

describe("a provisioned file that cannot be adopted", () => {
  // Every row would replace a working configuration with one the gateway cannot load. The last
  // three have the right outline (an object with providers) and are caught only because the
  // candidate must pass the gateway's own loader before it is published.
  it.each([
    ["text that is not JSON", `{ "providers": [ ${SECRET}`],
    ["a JSON array", "[]"],
    ["a config without providers", "{}"],
    ["a config with an empty provider list", '{"providers":[]}'],
    ["providers that are not a list", '{"providers":{}}'],
    ["a provider that is not an object", '{"providers":[1]}'],
    ["a provider without a gateway address", '{"providers":[{"modelId":"chat","apiKey":"k"}]}'],
    [
      "a reference to a key sealed on another computer",
      '{"providers":[{"modelId":"chat","baseUrl":"https://g.example.test","apiKeySecretRef":"cred:chat"}]}',
    ],
  ])("refuses %s and keeps the current configuration", async (_label, content) => {
    const subject = fixture(content);
    mkdirSync(join(subject.stateDir, "ui"), { recursive: true });
    writeFileSync(subject.configPath, "current");

    expect(await subject.adopt()).toBe("invalid");

    expect(readFileSync(subject.configPath, "utf8")).toBe("current");
    expect(readdirSync(join(subject.stateDir, "ui"))).toEqual(["keiko.config.json"]);
    expect(lastLine(subject)).toMatchObject({ level: "warn", outcome: "invalid" });
  });

  it("accepts a config whose key comes from the environment, as the gateway does", async () => {
    const subject = fixture(
      '{"providers":[{"modelId":"chat","baseUrl":"https://g.example.test"}]}',
    );

    expect(await subject.adopt({ env: { KEIKO_DEFAULT_API_KEY: "sk-from-environment" } })).toBe(
      "adopted",
    );
  });

  it("adopts a file saved with a byte order mark, without the mark", async () => {
    const subject = fixture(`\uFEFF${configText()}`);

    expect(await subject.adopt()).toBe("adopted");

    expect(readFileSync(subject.configPath, "utf8")).toBe(configText());
    expect(await subject.adopt()).toBe("unchanged");
  });

  it("refuses a directory in the file's place", async () => {
    const subject = fixture(null);
    mkdirSync(subject.source);

    expect(await subject.adopt()).toBe("invalid");
    expect(existsSync(subject.configPath)).toBe(false);
  });

  // Opening a FIFO for reading blocks until a writer appears: the start would hang for good.
  it.skipIf(process.platform === "win32")("refuses a named pipe without opening it", async () => {
    const subject = fixture(null);
    execFileSync("mkfifo", [subject.source]);

    expect(await subject.adopt()).toBe("invalid");
    expect(existsSync(subject.configPath)).toBe(false);
  });

  it("refuses a file beyond the size bound before parsing it", async () => {
    const subject = fixture(`{"providers":["${"x".repeat(PROVISIONED_CONFIG_MAX_BYTES)}"]}`);

    expect(await subject.adopt()).toBe("too-large");

    expect(existsSync(subject.configPath)).toBe(false);
    expect(lastLine(subject)).toMatchObject({ level: "warn", outcome: "too-large" });
  });

  it.skipIf(process.platform === "win32")("does not follow a link", async () => {
    const subject = fixture(null);
    const target = join(subject.stateDir, "..", "outside.json");
    writeFileSync(target, configText());
    symlinkSync(target, subject.source);

    expect(await subject.adopt()).toBe("refused-link");

    expect(existsSync(subject.configPath)).toBe(false);
    expect(lastLine(subject)).toMatchObject({ level: "warn", outcome: "refused-link" });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports an unreadable file with its error class",
    async () => {
      const subject = fixture();
      chmodSync(subject.source, 0o000);

      expect(await subject.adopt()).toBe("read-failed");

      expect(lastLine(subject)).toMatchObject({
        level: "warn",
        outcome: "read-failed",
        failureKind: "EACCES",
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not write through a link in place of the UI data directory",
    async () => {
      const subject = fixture();
      const elsewhere = join(subject.stateDir, "..", "elsewhere");
      mkdirSync(elsewhere);
      mkdirSync(subject.stateDir, { recursive: true });
      symlinkSync(elsewhere, join(subject.stateDir, "ui"));

      expect(await subject.adopt()).toBe("write-failed");

      expect(readdirSync(elsewhere)).toEqual([]);
      expect(lastLine(subject)).toMatchObject({
        level: "warn",
        outcome: "write-failed",
        failureKind: "ELOOP",
      });
    },
  );

  // The configuration is in force once it is published; a marker that cannot be written must not
  // be reported as "Keiko keeps its current one".
  it("says the configuration is in use when only the record of the adoption fails", async () => {
    const subject = fixture();
    mkdirSync(subject.markerPath, { recursive: true });
    writeFileSync(join(subject.markerPath, "in-the-way"), "");

    expect(await subject.adopt()).toBe("marker-failed");

    expect(readFileSync(subject.configPath, "utf8")).toBe(configText());
    expect(lastLine(subject)).toMatchObject({ level: "warn", outcome: "marker-failed" });
    expect(provisionedConfigMessage("marker-failed")).toContain("uses the configuration");
    // The next start converges: the same bytes are adopted again.
    expect(await subject.adopt()).toBe("marker-failed");
  });

  it("reports a failed save, leaves no temporary file and records no adoption", async () => {
    const subject = fixture();
    // A file where the UI data directory belongs: the configuration cannot be written.
    mkdirSync(subject.stateDir, { recursive: true });
    writeFileSync(join(subject.stateDir, "ui"), "in the way");

    expect(await subject.adopt()).toBe("write-failed");

    expect(readdirSync(subject.stateDir)).toEqual(["ui"]);
    expect(lastLine(subject)).toMatchObject({ level: "warn", outcome: "write-failed" });
    expect(lastLine(subject).failureKind).toEqual(expect.any(String));
  });
});

describe("what the person reads", () => {
  it("stays silent when nothing changed for them", () => {
    expect(provisionedConfigMessage("unchanged")).toBeUndefined();
    expect(provisionedConfigMessage("absent")).toBeUndefined();
  });

  it.each([
    "adopted",
    "deferred-running",
    "overridden",
    "invalid",
    "too-large",
    "refused-link",
    "read-failed",
    "write-failed",
    "marker-failed",
  ] as const)("names the %s outcome in one sentence", (outcome) => {
    expect(provisionedConfigMessage(outcome)).toMatch(/^[A-Z].+\.$/u);
  });
});
