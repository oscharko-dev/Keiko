import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MANAGED_LSP_LANGUAGES,
  parseManagedLspEvidence,
  type ManagedLspLanguage,
  type ManagedLspShellConfiguration,
} from "@oscharko-dev/keiko-contracts";
import { createWorkspaceMutexRegistry } from "../../task-workspace/mutex.js";
import {
  createManagedLspActivationStore,
  managedLspActivationRecordPath,
} from "./managedLspActivationStore.js";
import {
  createManagedLspControlService,
  type ManagedLspControlServiceOptions,
} from "./managedLspControl.js";
import type { ManagedLspEvidenceProjector } from "./managedLspEvidenceProjector.js";

const roots: string[] = [];

function temporaryDirectory(label: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), `keiko-${label}-`)));
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function serviceOptions(
  overrides: {
    readonly stateDir?: string;
    readonly processEnv?: NodeJS.ProcessEnv;
    readonly provisioned?: (language: ManagedLspLanguage) => boolean;
    readonly dispose?: (root: string, language: ManagedLspLanguage) => Promise<void>;
    readonly save?: (path: string, value: Record<string, unknown>) => void;
    readonly projectEvidence?: ManagedLspEvidenceProjector;
  } = {},
): ManagedLspControlServiceOptions {
  const stateDir = overrides.stateDir ?? temporaryDirectory("managed-lsp-state");
  return {
    store: createManagedLspActivationStore({ stateDir, save: overrides.save }),
    processEnv: overrides.processEnv ?? {},
    provisioning: (_root: string, language: ManagedLspLanguage): boolean =>
      overrides.provisioned?.(language) ?? true,
    disposePoolEntry: overrides.dispose ?? ((): Promise<void> => Promise.resolve()),
    runtimeApproved: (_language: ManagedLspLanguage, runtimeId: string): boolean =>
      runtimeId.endsWith("-lsp"),
    configurationSafe: (): boolean => true,
    projectEvidence: overrides.projectEvidence ?? ((): "projected" => "projected"),
    mutex: createWorkspaceMutexRegistry(),
    now: (): number => 1_725_000_000_000,
  };
}

function shellConfiguration(
  revision: number,
  etag: string,
  dialect: "bash" | "posix" = "bash",
): ManagedLspShellConfiguration {
  return {
    schemaVersion: "1" as const,
    language: "shell" as const,
    revision,
    etag,
    activation: "enabled" as const,
    runtime: { kind: "operatorApproved" as const, runtimeId: "shell-lsp" },
    provenance: {
      activation: "workspace" as const,
      runtime: "operatorProvisioning" as const,
      settings: "workspace" as const,
    },
    restartRequired: false,
    restartFields: [],
    settings: {
      dialect,
      sourcePolicy: "workspaceOnly" as const,
      shellCheck: {
        mode: "workspace" as const,
        severity: "warning" as const,
        excludedCodes: [],
        includePaths: [],
        externalSources: false as const,
      },
    },
  };
}

describe("managed LSP activation control service", () => {
  it.each(["absent", "corrupt", "unknown-version"] as const)(
    "fails closed for %s persisted state and never disposes a process",
    async (variant) => {
      const stateDir = temporaryDirectory(`managed-lsp-${variant}`);
      const root = temporaryDirectory(`workspace-${variant}`);
      const dispose = vi.fn(() => Promise.resolve());
      if (variant !== "absent") {
        const path = managedLspActivationRecordPath(stateDir, root);
        writeFileSync(
          path,
          variant === "corrupt" ? "{" : JSON.stringify({ schemaVersion: "999" }),
          "utf8",
        );
      }
      const service = createManagedLspControlService(serviceOptions({ stateDir, dispose }));

      const snapshot = await service.read(root);

      expect(snapshot.storeState).toBe(variant === "absent" ? "absent" : "unavailable");
      expect(snapshot.languages.every((entry) => entry.state === "disabled")).toBe(true);
      expect(dispose).not.toHaveBeenCalled();
    },
  );

  it("recovers corrupt state only through the explicit reset-to-defaults action", async () => {
    const stateDir = temporaryDirectory("managed-lsp-corrupt-reset");
    const root = temporaryDirectory("workspace-corrupt-reset");
    writeFileSync(managedLspActivationRecordPath(stateDir, root), "{", "utf8");
    const service = createManagedLspControlService(serviceOptions({ stateDir }));

    const reset = await service.mutate({
      action: "reset",
      actorClass: "localHuman",
      expectedRevision: 0,
      idempotencyKey: "corrupt-reset",
      language: "python",
      root,
    });

    expect(reset.kind).toBe("ok");
    expect(await service.read(root)).toMatchObject({ storeState: "ready", revision: 0 });
  });

  it("gives the deployment ceiling precedence over provisioning, settings, and legacy enablement", async () => {
    const root = temporaryDirectory("workspace-policy");
    const service = createManagedLspControlService(
      serviceOptions({
        processEnv: {
          KEIKO_EDITOR_LSP_POLICY_PYTHON: "denied",
          KEIKO_EDITOR_LSP_PYTHON: "enabled",
        },
      }),
    );
    const initial = await service.read(root);
    const mutation = await service.mutate({
      action: "activate",
      actorClass: "localHuman",
      expectedRevision: 0,
      idempotencyKey: "policy-denial-1",
      language: "python",
      root,
    });

    expect(
      initial.languages.find((entry) => entry.ok && entry.language === "python"),
    ).toMatchObject({
      state: "disabledByPolicy",
      reasonCode: "POLICY_DENIED",
    });
    expect(mutation.kind).toBe("denied");
    const persisted = readFileSync(managedLspActivationRecordPath(service.stateDir, root), "utf8");
    expect(persisted).toContain('"outcome": "denied"');
  });

  it.each([
    ["denied", "enabled", true, "disabledByPolicy", "POLICY_DENIED"],
    ["unexpected", "enabled", true, "disabledByPolicy", "POLICY_DENIED"],
    ["allowed", "disabled", true, "disabledByPolicy", "LEGACY_ENV_DISABLED"],
    ["allowed", undefined, false, "disabled", "WORKSPACE_ACTIVATION_UNSET"],
    ["allowed", undefined, true, "disabled", "WORKSPACE_ACTIVATION_UNSET"],
  ] as const)(
    "maps deployment=%s legacy=%s provisioned=%s to %s",
    async (policy, legacy, provisioned, expectedState, expectedReason) => {
      const root = temporaryDirectory(`workspace-policy-${expectedReason}`);
      const env: NodeJS.ProcessEnv = { KEIKO_EDITOR_LSP_POLICY_PYTHON: policy };
      if (legacy !== undefined) env.KEIKO_EDITOR_LSP_PYTHON = legacy;
      const service = createManagedLspControlService(
        serviceOptions({ processEnv: env, provisioned: () => provisioned }),
      );

      const python = (await service.read(root)).languages.find(
        (entry) => entry.ok && entry.language === "python",
      );

      expect(python).toMatchObject({ state: expectedState, reasonCode: expectedReason });
    },
  );

  it("reports not provisioned after an explicit opt-in without spawning a process", async () => {
    const root = temporaryDirectory("workspace-not-provisioned");
    const dispose = vi.fn(() => Promise.resolve());
    const service = createManagedLspControlService(
      serviceOptions({ provisioned: () => false, dispose }),
    );

    const result = await service.mutate({
      action: "activate",
      actorClass: "localHuman",
      expectedRevision: 0,
      idempotencyKey: "not-provisioned-opt-in",
      language: "python",
      root,
    });

    expect(result).toMatchObject({
      kind: "ok",
      status: { state: "notProvisioned", reasonCode: "NOT_PROVISIONED" },
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent writers so a stale revision changes no state, evidence, or process", async () => {
    const root = temporaryDirectory("workspace-concurrency");
    const dispose = vi.fn(() => Promise.resolve());
    const service = createManagedLspControlService(serviceOptions({ dispose }));
    const base = {
      actorClass: "localHuman" as const,
      expectedRevision: 0,
      language: "python" as const,
      root,
    };

    const [first, stale] = await Promise.all([
      service.mutate({ ...base, action: "activate", idempotencyKey: "concurrent-a" }),
      service.mutate({ ...base, action: "deactivate", idempotencyKey: "concurrent-b" }),
    ]);

    expect([first.kind, stale.kind].sort()).toStrictEqual(["conflict", "ok"]);
    expect(dispose).toHaveBeenCalledTimes(1);
    const snapshot = await service.read(root);
    expect(snapshot.revision).toBe(1);
    expect(snapshot.evidenceCount).toBe(1);
  });

  it("commits evidence atomically before disposing only the affected workspace and language", async () => {
    const root = temporaryDirectory("workspace-disposal");
    const otherRoot = temporaryDirectory("workspace-unrelated");
    const calls: string[] = [];
    const service = createManagedLspControlService(
      serviceOptions({
        dispose: (targetRoot, language) => {
          calls.push(`${targetRoot}:${language}`);
          return Promise.resolve();
        },
      }),
    );

    const result = await service.mutate({
      action: "activate",
      actorClass: "localHuman",
      expectedRevision: 0,
      idempotencyKey: "activate-python",
      language: "python",
      root,
    });
    await service.read(otherRoot);

    expect(result.kind).toBe("ok");
    expect(calls).toStrictEqual([`${root}:python`]);
    const stored = readFileSync(managedLspActivationRecordPath(service.stateDir, root), "utf8");
    expect(stored).toContain('"action": "activate"');
    expect(stored).toContain('"outcome": "accepted"');
  });

  it("cannot leave activation enabled when the atomic state/evidence write fails", async () => {
    const root = temporaryDirectory("workspace-failed-write");
    const dispose = vi.fn(() => Promise.resolve());
    const stateDir = temporaryDirectory("managed-lsp-failed-write");
    const projected: Parameters<ManagedLspEvidenceProjector>[1][] = [];
    const projectEvidence: ManagedLspEvidenceProjector = (_fingerprint, evidence) => {
      projected.push(evidence);
      return "projected";
    };
    const service = createManagedLspControlService(
      serviceOptions({
        stateDir,
        dispose,
        save: () => {
          throw new Error("SENTINEL_SECRET_WRITE_FAILURE");
        },
        projectEvidence,
      }),
    );

    const result = await service.mutate({
      action: "activate",
      actorClass: "localHuman",
      expectedRevision: 0,
      idempotencyKey: "failed-write",
      language: "python",
      root,
    });

    expect(result).toMatchObject({ kind: "unavailable", code: "STATE_UNAVAILABLE" });
    expect(dispose).not.toHaveBeenCalled();
    expect(await service.read(root)).toMatchObject({ revision: 0, storeState: "absent" });
    expect(JSON.stringify(result)).not.toContain("SENTINEL_SECRET");
    expect(projected[0]).toEqual([
      expect.objectContaining({ action: "activate", outcome: "failed" }),
    ]);
  });

  it("records accepted deactivation and subsequent no-op without a second pool side effect", async () => {
    const root = temporaryDirectory("workspace-deactivate-noop");
    const dispose = vi.fn(() => Promise.resolve());
    const service = createManagedLspControlService(serviceOptions({ dispose }));
    await service.mutate({
      action: "activate",
      actorClass: "localHuman",
      expectedRevision: 0,
      idempotencyKey: "deactivate-seed",
      language: "python",
      root,
    });
    await service.mutate({
      action: "deactivate",
      actorClass: "localHuman",
      expectedRevision: 1,
      idempotencyKey: "deactivate-accepted",
      language: "python",
      root,
    });
    const noOp = await service.mutate({
      action: "deactivate",
      actorClass: "localHuman",
      expectedRevision: 2,
      idempotencyKey: "deactivate-no-op",
      language: "python",
      root,
    });

    expect(noOp).toMatchObject({ kind: "ok", changed: false, revision: 2 });
    expect(dispose).toHaveBeenCalledTimes(2);
    const persisted = readFileSync(managedLspActivationRecordPath(service.stateDir, root), "utf8");
    expect(persisted).toContain('"action": "deactivate"');
    expect(persisted).toContain('"outcome": "noOp"');
  });

  it("keeps canonical reviewable evidence when secondary projection is unavailable", async () => {
    const root = temporaryDirectory("workspace-projection-failure");
    const projectEvidence = vi.fn(() => "canonicalOnly" as const);
    const service = createManagedLspControlService(serviceOptions({ projectEvidence }));

    const result = await service.mutate({
      action: "activate",
      actorClass: "localHuman",
      expectedRevision: 0,
      idempotencyKey: "projection-failure",
      language: "python",
      root,
    });

    expect(result.kind).toBe("ok");
    expect(projectEvidence).toHaveBeenCalledTimes(1);
    const stored = readFileSync(managedLspActivationRecordPath(service.stateDir, root), "utf8");
    expect(stored).toContain('"outcome": "accepted"');
    expect(stored).not.toContain("projection-failure");
  });

  it("deduplicates idempotency keys and rejects key reuse with a different action", async () => {
    const root = temporaryDirectory("workspace-idempotency");
    const dispose = vi.fn(() => Promise.resolve());
    const options = serviceOptions({ dispose });
    const service = createManagedLspControlService(options);
    const request = {
      action: "activate" as const,
      actorClass: "localHuman" as const,
      expectedRevision: 0,
      idempotencyKey: "same-request-key",
      language: "python" as const,
      root,
    };

    const first = await service.mutate(request);
    const raw = JSON.parse(
      readFileSync(managedLspActivationRecordPath(service.stateDir, root), "utf8"),
    ) as { evidence: readonly unknown[]; idempotency: readonly unknown[] };
    expect(parseManagedLspEvidence(raw.evidence[0]).ok).toBe(true);
    expect(raw.idempotency[0]).toMatchObject({
      resultKind: "ok",
      revision: 1,
      state: "available",
      reasonCode: "AVAILABLE",
      policyResult: "allowed",
    });
    expect(options.store.load(root).state).toBe("ready");
    const replay = await service.mutate(request);
    const misuse = await service.mutate({ ...request, action: "deactivate" });

    expect(first.kind).toBe("ok");
    expect(replay).toStrictEqual(first);
    expect(misuse.kind).toBe("idempotencyConflict");
    expect(dispose).toHaveBeenCalledTimes(1);
    expect((await service.read(root)).evidenceCount).toBe(1);
  });

  it("resets a language to default-off and records a bounded content-free transition", async () => {
    const root = temporaryDirectory("workspace-reset");
    const service = createManagedLspControlService(serviceOptions());
    await service.mutate({
      action: "activate",
      actorClass: "localHuman",
      expectedRevision: 0,
      idempotencyKey: "reset-activate",
      language: "python",
      root,
    });

    const reset = await service.mutate({
      action: "reset",
      actorClass: "localHuman",
      expectedRevision: 1,
      idempotencyKey: "reset-defaults",
      language: "python",
      root,
    });

    expect(reset.kind).toBe("ok");
    const status = (await service.read(root)).languages.find(
      (entry) => entry.ok && entry.language === "python",
    );
    expect(status).toMatchObject({ state: "disabled", reasonCode: "WORKSPACE_ACTIVATION_UNSET" });
  });

  it("returns a stable status row for every governed language", async () => {
    const root = temporaryDirectory("workspace-all-languages");
    const service = createManagedLspControlService(serviceOptions());

    const snapshot = await service.read(root);

    expect(
      snapshot.languages.map((entry) => (entry.ok ? entry.language : "invalid")),
    ).toStrictEqual(MANAGED_LSP_LANGUAGES);
  });

  it("recovers committed activation after service restart with private atomic state files", async () => {
    const root = temporaryDirectory("workspace-restart");
    const stateDir = temporaryDirectory("managed-lsp-restart-state");
    const first = createManagedLspControlService(serviceOptions({ stateDir }));
    await first.mutate({
      action: "activate",
      actorClass: "localHuman",
      expectedRevision: 0,
      idempotencyKey: "restart-activation",
      language: "python",
      root,
    });

    const restarted = createManagedLspControlService(serviceOptions({ stateDir }));
    const snapshot = await restarted.read(root);
    const path = managedLspActivationRecordPath(stateDir, root);

    expect(snapshot).toMatchObject({ storeState: "ready", revision: 1, evidenceCount: 1 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(stateDir).filter((name) => name.endsWith(".tmp"))).toStrictEqual([]);
  });

  it("treats an unreadable record as unavailable and keeps every language disabled", async () => {
    const root = temporaryDirectory("workspace-unreadable");
    const stateDir = temporaryDirectory("managed-lsp-unreadable-state");
    const writer = createManagedLspControlService(serviceOptions({ stateDir }));
    await writer.mutate({
      action: "activate",
      actorClass: "localHuman",
      expectedRevision: 0,
      idempotencyKey: "unreadable-seed",
      language: "python",
      root,
    });
    const options = serviceOptions({ stateDir });
    const unreadable = createManagedLspControlService({
      ...options,
      store: createManagedLspActivationStore({
        stateDir,
        read: () => {
          throw new Error("permission denied");
        },
      }),
    });

    const snapshot = await unreadable.read(root);

    expect(snapshot.storeState).toBe("unavailable");
    expect(snapshot.languages.every((entry) => entry.state === "disabled")).toBe(true);
  });

  it("refuses a state store located inside the selected workspace", async () => {
    const root = temporaryDirectory("workspace-contained-state");
    const stateDir = join(root, ".keiko-state");
    const service = createManagedLspControlService(serviceOptions({ stateDir }));

    const snapshot = await service.read(root);
    const mutation = await service.mutate({
      action: "activate",
      actorClass: "localHuman",
      expectedRevision: 0,
      idempotencyKey: "contained-state-denied",
      language: "python",
      root,
    });

    expect(snapshot.storeState).toBe("unavailable");
    expect(mutation).toStrictEqual({ kind: "unavailable", code: "STATE_UNAVAILABLE" });
  });

  it("persists safe configuration, restarts the target, and rolls back the prior revision", async () => {
    const root = temporaryDirectory("workspace-configuration");
    const dispose = vi.fn(() => Promise.resolve());
    const service = createManagedLspControlService(serviceOptions({ dispose }));
    const initial = await service.read(root);
    const first = await service.mutate({
      action: "configure",
      actorClass: "localHuman",
      expectedRevision: 0,
      idempotencyKey: "configure-shell-bash",
      language: "shell",
      root,
      configuration: shellConfiguration(0, initial.etag, "bash"),
    });
    expect(first.kind).toBe("ok");
    if (first.kind !== "ok") throw new Error("configuration setup failed");
    const second = await service.mutate({
      action: "configure",
      actorClass: "localHuman",
      expectedRevision: 1,
      idempotencyKey: "configure-shell-posix",
      language: "shell",
      root,
      configuration: shellConfiguration(1, first.etag, "posix"),
    });
    expect(second.kind).toBe("ok");
    const rollback = await service.mutate({
      action: "rollback",
      actorClass: "localHuman",
      expectedRevision: 2,
      idempotencyKey: "rollback-shell",
      language: "shell",
      root,
    });

    expect(rollback.kind).toBe("ok");
    expect(dispose).toHaveBeenCalledTimes(3);
    expect(
      (await service.read(root)).settings.find((entry) => entry.language === "shell"),
    ).toMatchObject({
      workspaceActivation: "enabled",
      configured: true,
      provenance: { runtime: "operatorProvisioning", settings: "workspace" },
    });
    const persisted = JSON.parse(
      readFileSync(managedLspActivationRecordPath(service.stateDir, root), "utf8"),
    ) as { languages: { shell: { configuration: { settings: { dialect: string } } } } };
    expect(persisted.languages.shell.configuration.settings.dialect).toBe("bash");
    expect(await service.readConfiguration(root, "shell")).toMatchObject({
      language: "shell",
      revision: 1,
      settings: { dialect: "bash" },
    });
    expect(await service.readConfiguration(root, "python")).toBeUndefined();
  });

  it("rejects unapproved secret-shaped runtime identities without persistence or response echo", async () => {
    const root = temporaryDirectory("workspace-secret-runtime");
    const service = createManagedLspControlService(serviceOptions());
    const initial = await service.read(root);
    const configuration = {
      ...shellConfiguration(0, initial.etag),
      runtime: { kind: "operatorApproved" as const, runtimeId: "SENTINEL_SECRET_RUNTIME" },
    };

    const result = await service.mutate({
      action: "configure",
      actorClass: "localHuman",
      expectedRevision: 0,
      idempotencyKey: "secret-runtime",
      language: "shell",
      root,
      configuration,
    });

    expect(result).toStrictEqual({ kind: "invalid", code: "INVALID_REQUEST" });
    expect(JSON.stringify(result)).not.toContain("SENTINEL_SECRET");
    expect((await service.read(root)).storeState).toBe("absent");
  });

  it("acknowledges an explicit restart, clears restart impact, and disposes only the target", async () => {
    const root = temporaryDirectory("workspace-restart");
    const dispose = vi.fn(() => Promise.resolve());
    const service = createManagedLspControlService(serviceOptions({ dispose }));
    const initial = await service.read(root);
    await service.mutate({
      action: "configure",
      actorClass: "localHuman",
      expectedRevision: 0,
      idempotencyKey: "restart-configure",
      language: "shell",
      root,
      configuration: shellConfiguration(0, initial.etag),
    });

    const result = await service.mutate({
      action: "restart",
      actorClass: "localHuman",
      expectedRevision: 1,
      idempotencyKey: "restart-explicit",
      language: "shell",
      root,
    });

    expect(result).toMatchObject({ kind: "ok", changed: true, revision: 2 });
    expect(dispose).toHaveBeenLastCalledWith(root, "shell");
    expect(await service.readConfiguration(root, "shell")).toMatchObject({
      revision: 2,
      restartRequired: false,
      restartFields: [],
    });
  });
});
