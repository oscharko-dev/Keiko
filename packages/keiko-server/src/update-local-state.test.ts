import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  UPDATE_HEALTH_LABELS,
  UPDATE_LOCAL_STATE_SCHEMA_VERSION,
} from "@oscharko-dev/keiko-contracts";
import {
  createUpdateLocalStateManager,
  type UpdateLocalStateManager,
} from "./update-local-state.js";

const tempRoots: string[] = [];
const NOW = Date.parse("2026-06-30T12:00:00.000Z");

function makeStateDir(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-update-state-"));
  tempRoots.push(root);
  const stateDir = join(root, ".keiko");
  mkdirSync(stateDir, { recursive: true });
  return stateDir;
}

function touch(path: string, content = "x"): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function manager(stateDir: string, ids: readonly string[]): UpdateLocalStateManager {
  let index = 0;
  return createUpdateLocalStateManager({
    stateDir,
    now: () => NOW,
    idFactory: () => ids[index++] ?? `id-${String(index)}`,
  });
}

function seedSensitiveState(stateDir: string): void {
  touch(join(stateDir, "keiko.config.json"), '{"path":"/Users/alice/private-bank-repo"}');
  touch(join(stateDir, "credentials", "provider-credentials.vault"), "sk-secret-from-vault");
  touch(join(stateDir, "memory", "keiko-memory.db"), "PROMPT: customer prompt text");
  touch(join(stateDir, "local-knowledge", "default", "capsules.db"), "MODEL OUTPUT BODY");
  touch(join(stateDir, "ui.log"), "npm install @oscharko-dev/keiko raw package-manager output");
  touch(join(stateDir, "evidence", "run-1.json"), '{"modelOutput":"raw model output"}');
  touch(join(stateDir, "customer-repo", "secret.txt"), "customer repository file");
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("update local state compatibility scan", () => {
  it("maps release impact to plain health labels without reading model credentials", () => {
    const stateDir = makeStateDir();
    touch(join(stateDir, "credentials", "provider-credentials.vault"), "sk-do-not-read");
    touch(join(stateDir, "memory", "keiko-memory.db"));
    touch(join(stateDir, "local-knowledge", "default", "capsules.db"));

    const scan = manager(stateDir, ["scan-id"]).scanCompatibility({
      affectedStateStores: ["package-install"],
      userActionRequired: true,
      stateImpact: [
        {
          store: "memory",
          description: "Memory requires a reviewed carry-forward action.",
          remediation: "repair-required",
          userActionRequired: true,
        },
        {
          store: "local knowledge",
          description: "Local Knowledge must be refreshed.",
          remediation: "local-knowledge-reindex-required",
          userActionRequired: false,
        },
      ],
    });

    const memory = scan.stores.find((store) => store.store === "memory-vault");
    const knowledge = scan.stores.find((store) => store.store === "local-knowledge");
    const packageInstall = scan.stores.find((store) => store.store === "package-install");
    expect(memory?.health).toBe("needs-action");
    expect(memory?.healthLabel).toBe(UPDATE_HEALTH_LABELS["needs-action"]);
    expect(knowledge?.health).toBe("ready");
    expect(knowledge?.healthLabel).toBe(UPDATE_HEALTH_LABELS.ready);
    expect(packageInstall?.health).toBe("needs-action");
    expect(scan.stores.map((store) => store.healthLabel)).toEqual(
      expect.arrayContaining(["Ready", "Needs action", "Not affected"]),
    );
    expect(JSON.stringify(scan)).not.toContain("sk-do-not-read");
  });

  it("retains unreadable owned subtrees instead of throwing", () => {
    if (process.platform === "win32") return;
    const stateDir = makeStateDir();
    const memoryDir = join(stateDir, "memory");
    mkdirSync(memoryDir, { recursive: true });
    chmodSync(memoryDir, 0);
    try {
      const scan = manager(stateDir, ["scan-id"]).scanCompatibility({
        affectedStateStores: ["memory-vault"],
        userActionRequired: true,
      });
      const memory = scan.stores.find((store) => store.store === "memory-vault");

      expect(scan.stateDirStatus).toBe("directory");
      expect(memory).toMatchObject({
        health: "manual-review-required",
        retainedEntryCount: 1,
      });
    } finally {
      chmodSync(memoryDir, 0o700);
    }
  });
});

describe("update recovery snapshots", () => {
  it("writes content-free manifests without customer files, secrets, raw logs, or private paths", () => {
    const stateDir = makeStateDir();
    seedSensitiveState(stateDir);

    const snapshot = manager(stateDir, ["snap-privacy"]).createRecoverySnapshot({
      fromVersion: "0.2.11",
      toVersion: "0.2.12",
      impact: {
        affectedStateStores: [
          "durable-config",
          "memory-vault",
          "local-knowledge",
          "evidence",
          "package-install",
        ],
      },
    });

    const manifestPath = join(stateDir, "updates", "snapshots", "snap-privacy", "manifest.json");
    const manifest = readFileSync(manifestPath, "utf8");
    expect(snapshot.status).toBe("created");
    expect(snapshot.entries.length).toBeGreaterThan(0);
    expect(snapshot.entries.every((entry) => !Object.hasOwn(entry, "relativePath"))).toBe(true);
    expect(existsSync(join(stateDir, "updates", "snapshots", "snap-privacy", "files"))).toBe(false);
    for (const forbidden of [
      stateDir,
      "/Users/alice/private-bank-repo",
      "sk-secret-from-vault",
      "PROMPT: customer prompt text",
      "MODEL OUTPUT BODY",
      "raw package-manager output",
      "raw model output",
      "customer repository file",
    ]) {
      expect(manifest).not.toContain(forbidden);
    }
    expect(manager(stateDir, ["unused"]).validateRecoverySnapshot("snap-privacy")).toBe(true);
  });

  it("retains only the latest valid previous-version snapshot", () => {
    const stateDir = makeStateDir();
    const localState = manager(stateDir, ["snap-old", "snap-new"]);

    localState.createRecoverySnapshot({ fromVersion: "0.2.10", toVersion: "0.2.11" });
    expect(existsSync(join(stateDir, "updates", "snapshots", "snap-old"))).toBe(true);
    localState.createRecoverySnapshot({ fromVersion: "0.2.11", toVersion: "0.2.12" });

    expect(existsSync(join(stateDir, "updates", "snapshots", "snap-old"))).toBe(false);
    expect(existsSync(join(stateDir, "updates", "snapshots", "snap-new"))).toBe(true);
    expect(localState.validateRecoverySnapshot("snap-new")).toBe(true);
  });

  it("fails closed on a symlinked state root", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "keiko-update-symlink-"));
    tempRoots.push(root);
    const target = join(root, "outside-state");
    const stateDir = join(root, ".keiko");
    mkdirSync(target, { recursive: true });
    touch(join(target, "memory", "keiko-memory.db"), "outside");
    symlinkSync(target, stateDir, "dir");

    const localState = manager(stateDir, ["snap-symlink"]);
    const snapshot = localState.createRecoverySnapshot({
      fromVersion: "0.2.11",
      toVersion: "0.2.12",
      impact: { affectedStateStores: ["memory"] },
    });

    expect(snapshot.status).toBe("failed");
    expect(snapshot.stateDirStatus).toBe("symlink");
    expect(snapshot.entries).toHaveLength(0);
    expect(localState.validateRecoverySnapshot("snap-symlink")).toBe(false);
  });
});

describe("update runtime state and audit events", () => {
  it("surfaces audit persistence failure without discarding recovery runtime state", () => {
    const stateDir = makeStateDir();
    const localState = manager(stateDir, ["event-1"]);
    localState.writeRuntimeState({
      schemaVersion: UPDATE_LOCAL_STATE_SCHEMA_VERSION,
      updatedAt: "stale",
      targetVersion: "0.2.12",
      remediations: [],
      warnings: [],
    });
    mkdirSync(join(stateDir, "updates", "update-audit.jsonl"), { recursive: true });

    const result = localState.recordAuditEvent("user-confirmed", {
      targetVersion: "0.2.12",
      status: "succeeded",
    });

    expect(result.warning).toBe("Update audit event could not be persisted.");
    expect(result.event).toMatchObject({
      eventId: "event-1",
      type: "user-confirmed",
      targetVersion: "0.2.12",
      status: "succeeded",
    });
    expect(localState.readRuntimeState().targetVersion).toBe("0.2.12");
  });
});
