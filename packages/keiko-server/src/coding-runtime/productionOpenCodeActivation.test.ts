import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import type { ServerLogEvent } from "../observability/index.js";
import { makeOwnerPrivateDirectory } from "../test-support/owner-private-fixture.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import * as backendModule from "./productionOpenCodeBackend.js";
import {
  productionOpenCodeLoopbackEndpoints,
  resolveProductionOpenCodeActivation,
} from "./productionOpenCodeActivation.js";
import type { SecureWorkspaceTextReadPort } from "./secureWorkspaceTextRead.js";
import { stageDevLaneFixture, type DevLaneFixture } from "./devLaneFixture/_support.js";
import type { DevLaneOpenCodeTarget } from "./devLanePortableCodingRuntime.js";
import { OPENCODE_PINNED_VERSION } from "./opencodeRuntimeVersions.js";

const secureRead: SecureWorkspaceTextReadPort = {
  readText: () => Promise.resolve({ ok: false, reason: "denied" }),
};

const roots: string[] = [];

function devLaneFixture(target?: DevLaneOpenCodeTarget): DevLaneFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-activation-")));
  roots.push(root);
  return stageDevLaneFixture(root, target);
}

interface ActivationOverrides {
  readonly withSecureRead?: boolean;
  readonly withWorkspaceRoot?: boolean;
  readonly stateDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly activity?: ServerLogEvent[];
}

function activationInput(
  env: NodeJS.ProcessEnv,
  overrides: ActivationOverrides = {},
): Parameters<typeof resolveProductionOpenCodeActivation>[0] {
  return {
    env,
    // Deterministic host identity: these cases exercise supported dev lanes on every CI host.
    platform: overrides.platform ?? "darwin",
    arch: overrides.arch ?? "arm64",
    runtimeStateDir: overrides.stateDir ?? join(tmpdir(), "keiko-runtime-state"),
    runtimeEvidence: { observe: () => undefined },
    gatewayReadiness: {
      bindContinuationRoute: () => undefined,
      waitForObservedRequest: () => Promise.resolve(false),
      verifyObserved: () => undefined,
      clear: () => undefined,
    },
    activityLog: {
      write: (event: ServerLogEvent): void => {
        overrides.activity?.push(event);
      },
    },
    ...(overrides.withSecureRead === true ? { secureWorkspaceTextRead: secureRead } : {}),
    ...(overrides.withWorkspaceRoot === false
      ? {}
      : { resolveWorkspaceRoot: () => "/tmp/keiko-workspace" }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("production OpenCode activation", () => {
  it("honors the explicitly selected verified dev lane when an npm runtime is also installed", () => {
    const staged = devLaneFixture();
    const npmRoot = join(
      staged.root,
      "node_modules",
      "@oscharko-dev",
      "keiko-coding-runtime-darwin-arm64",
    );
    mkdirSync(npmRoot, { recursive: true });
    writeFileSync(
      join(npmRoot, "package.json"),
      JSON.stringify({ name: "@oscharko-dev/keiko-coding-runtime-darwin-arm64" }),
    );
    const activity: ServerLogEvent[] = [];
    const result = resolveProductionOpenCodeActivation(
      activationInput({ ...staged.env, KEIKO_UI_PORT: "1983" }, { activity }),
    );
    expect(result.unavailableReason).toBeUndefined();
    expect(result.ports?.secureWorkspaceTextRead).toBeDefined();
    expect(activity[0]?.extra?.lane).toBe("dev-checkout");
    const normal = resolveProductionOpenCodeActivation(
      activationInput({ ...staged.env, KEIKO_CODING_RUNTIME_DEV_LANE: "0", KEIKO_UI_PORT: "1983" }),
    );
    expect(normal.unavailableReason).toBe("payload-missing");
    expect(normal.ports).toBeUndefined();
  });

  it("derives the model gateway and tool facade from one production loopback origin", () => {
    const endpoints = productionOpenCodeLoopbackEndpoints({ KEIKO_UI_PORT: "1983" });
    expect(endpoints).toEqual({
      gatewayUrl: "http://127.0.0.1:1983/api/coding-sidecar/gateway",
      toolFacadeUrl: "http://127.0.0.1:1983/api/coding-sidecar/tool",
    });
    if (endpoints === undefined) throw new Error("expected production loopback endpoints");
    expect(new URL(endpoints.gatewayUrl).origin).toBe(new URL(endpoints.toolFacadeUrl).origin);
  });

  it("names platform-unqualified without a discoverable runtime on this platform", () => {
    const result = resolveProductionOpenCodeActivation(
      activationInput(
        { KEIKO_UI_PORT: "1983", KEIKO_CLI_BIN_PATH: "/nonexistent/entry.js" },
        {
          withSecureRead: true,
        },
      ),
    );
    expect(result.ports).toBeUndefined();
    expect(result.unavailableReason).toBe("platform-unqualified");
    expect(result.runtimeVersion).toBeUndefined();
  });

  it("keeps the install-the-runtime answer for a macOS installation without a runtime package", () => {
    const result = resolveProductionOpenCodeActivation(
      activationInput(
        { KEIKO_UI_PORT: "1983", KEIKO_CLI_BIN_PATH: "/nonexistent/entry.js" },
        { withSecureRead: true, platform: "darwin", arch: "x64" },
      ),
    );
    expect(result.unavailableReason).toBe("platform-unqualified");
  });

  it("fails closed with runtime-disabled when the kill switch is set, before discovery", () => {
    const staged = devLaneFixture();
    for (const token of ["1", "true", "on", "YES", "enabled"]) {
      const result = resolveProductionOpenCodeActivation(
        activationInput({
          ...staged.env,
          KEIKO_UI_PORT: "1983",
          KEIKO_CODING_SIDECAR_DISABLED: token,
        }),
      );
      expect(result.ports).toBeUndefined();
      expect(result.unavailableReason).toBe("runtime-disabled");
    }
  });

  it("names loopback-unavailable when the runtime resolves but KEIKO_UI_PORT is invalid", () => {
    const staged = devLaneFixture();
    for (const port of [undefined, "", "0", "-1", "65536", "not-a-port"]) {
      const env = { ...staged.env };
      if (port !== undefined) env.KEIKO_UI_PORT = port;
      const result = resolveProductionOpenCodeActivation(activationInput(env));
      expect(result.ports).toBeUndefined();
      expect(result.unavailableReason).toBe("loopback-unavailable");
    }
  });

  it("maps dev-lane structural refusals onto the content-free dev-lane-refused reason", () => {
    const staged = devLaneFixture();
    unlinkSync(join(staged.root, "tsconfig.packages.json"));
    const result = resolveProductionOpenCodeActivation(
      activationInput({ ...staged.env, KEIKO_UI_PORT: "1983" }),
    );
    expect(result.unavailableReason).toBe("dev-lane-refused");
  });

  it("surfaces precise payload reasons from dev-lane discovery", () => {
    const staged = devLaneFixture();
    unlinkSync(staged.paths.executable);
    const result = resolveProductionOpenCodeActivation(
      activationInput({ ...staged.env, KEIKO_UI_PORT: "1983" }),
    );
    expect(result.unavailableReason).toBe("payload-missing");
  });

  it("records body-free dev-lane refusal evidence", () => {
    const staged = devLaneFixture();
    const activity: ServerLogEvent[] = [];
    unlinkSync(staged.paths.executable);

    const result = resolveProductionOpenCodeActivation(
      activationInput({ ...staged.env, KEIKO_UI_PORT: "1983" }, { activity }),
    );

    expect(result.unavailableReason).toBe("payload-missing");
    expect(activity).toEqual([
      {
        category: "process",
        op: "coding-runtime.dev-lane.refused",
        correlationId: UNKNOWN_CORRELATION_ID,
        level: "warn",
        errorKind: "unavailable",
        extra: {
          completeness: "complete",
          loss: "none",
          lane: "dev-checkout",
          reason: "payload-missing",
        },
      },
    ]);
    const refusedProof = expectActivityLogProof(
      "coding-runtime.dev-lane.refused.emitted-line",
      formatActivityLogProofLine(activity[0] ?? {}),
    );
    expect(refusedProof).toMatchObject({
      correlationId: UNKNOWN_CORRELATION_ID,
      lane: "dev-checkout",
      reason: "payload-missing",
    });
  });

  // #3577: an npm installation activates its coding runtime from a runtime package installed next
  // to Keiko. A package that is present and fails verification decides the outcome with its own
  // reason; falling through to the dev lane would answer `platform-unqualified` and hide it.
  it("lets an installed npm runtime package decide, and names the lane in its refusal", () => {
    const prefix = realpathSync(mkdtempSync(join(tmpdir(), "keiko-activation-npm-")));
    roots.push(prefix);
    const scope = join(prefix, "lib", "node_modules", "@oscharko-dev");
    const keikoRoot = join(scope, "keiko");
    const runtimePackage = join(scope, "keiko-coding-runtime-darwin-arm64");
    mkdirSync(join(keikoRoot, "dist", "cli"), { recursive: true });
    mkdirSync(join(runtimePackage, "runtime"), { recursive: true });
    writeFileSync(join(keikoRoot, "package.json"), '{"name":"@oscharko-dev/keiko"}');
    writeFileSync(join(keikoRoot, "dist", "cli", "index.js"), "");
    writeFileSync(join(runtimePackage, "package.json"), "{}");
    const activity: ServerLogEvent[] = [];

    const result = resolveProductionOpenCodeActivation(
      activationInput(
        { KEIKO_CLI_BIN_PATH: join(keikoRoot, "dist", "cli", "index.js"), KEIKO_UI_PORT: "1983" },
        { activity },
      ),
    );

    expect(result.unavailableReason).toBe("payload-missing");
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      op: "coding-runtime.dev-lane.refused",
      level: "warn",
      errorKind: "unavailable",
      extra: { lane: "npm-runtime-package", reason: "payload-missing" },
    });
  });

  // #4068: an npm installation on Windows has no runtime package (none is published yet), and the
  // Workbench told the person only that no supported runtime exists. The reason now names the
  // installation kind, so the sentence names the one step: the desktop package.
  it("names an npm installation that lacks this computer's runtime package", () => {
    const prefix = realpathSync(mkdtempSync(join(tmpdir(), "keiko-activation-npm-win-")));
    roots.push(prefix);
    const keikoRoot = join(prefix, "node_modules", "@oscharko-dev", "keiko");
    mkdirSync(join(keikoRoot, "dist", "cli"), { recursive: true });
    writeFileSync(join(keikoRoot, "package.json"), '{"name":"@oscharko-dev/keiko"}');
    writeFileSync(join(keikoRoot, "dist", "cli", "index.js"), "");
    const activity: ServerLogEvent[] = [];

    const result = resolveProductionOpenCodeActivation(
      activationInput(
        { KEIKO_CLI_BIN_PATH: join(keikoRoot, "dist", "cli", "index.js"), KEIKO_UI_PORT: "1983" },
        { activity, platform: "win32", arch: "x64" },
      ),
    );

    expect(result.unavailableReason).toBe("npm-runtime-package-missing");
    expect(
      expectActivityLogProof(
        "coding-runtime.install.unqualified.emitted-line",
        formatActivityLogProofLine(activity.at(-1) ?? {}),
      ),
    ).toMatchObject({
      correlationId: UNKNOWN_CORRELATION_ID,
      level: "warn",
      errorKind: "unavailable",
      reason: "npm-runtime-package-missing",
    });
  });

  // Walk of 1.5.3: the npm folder package exists for workplaces where nothing may be installed, and
  // declares itself managed outside the app. Telling it to install the desktop package is advice it
  // cannot follow, so the reason is a distinct closed one; an ordinary npm installation keeps its own.
  it.each([
    ["organization-managed", "managed-runtime-package-missing"],
    ["machine-managed", "managed-runtime-package-missing"],
    ["user-local", "npm-runtime-package-missing"],
  ] as const)(
    "names a folder installation managed as %s without a runtime package as %s",
    (management, expected) => {
      const prefix = realpathSync(mkdtempSync(join(tmpdir(), "keiko-activation-npm-folder-")));
      roots.push(prefix);
      const keikoRoot = join(prefix, "node_modules", "@oscharko-dev", "keiko");
      mkdirSync(join(keikoRoot, "dist", "cli"), { recursive: true });
      writeFileSync(join(keikoRoot, "package.json"), '{"name":"@oscharko-dev/keiko"}');
      writeFileSync(join(keikoRoot, "dist", "cli", "index.js"), "");
      const activity: ServerLogEvent[] = [];

      const result = resolveProductionOpenCodeActivation(
        activationInput(
          {
            KEIKO_CLI_BIN_PATH: join(keikoRoot, "dist", "cli", "index.js"),
            KEIKO_UI_PORT: "1983",
            KEIKO_PORTABLE_MANAGEMENT: management,
          },
          { activity, platform: "win32", arch: "x64" },
        ),
      );

      expect(result.unavailableReason).toBe(expected);
      expect(
        expectActivityLogProof(
          "coding-runtime.install.unqualified.emitted-line",
          formatActivityLogProofLine(activity.at(-1) ?? {}),
        ),
      ).toMatchObject({
        correlationId: UNKNOWN_CORRELATION_ID,
        level: "warn",
        errorKind: "unavailable",
        reason: expected,
      });
    },
  );

  // A desktop installation is told to update or download again. A folder package or an IT-managed
  // deployment declares itself managed outside the app: it offers no in-app update and the person
  // installs nothing there (security software that removed a runtime file is the usual cause), so
  // it has its own closed reason and is pointed to its administrator.
  it.each([
    [undefined, "portable-runtime-unverified"],
    ["user-local", "portable-runtime-unverified"],
    ["organization-managed", "managed-runtime-unverified"],
    ["machine-managed", "managed-runtime-unverified"],
  ] as const)(
    "names an installation managed as %s whose bundled runtime did not verify as %s",
    (management, expected) => {
      const resourceRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-activation-portable-")));
      roots.push(resourceRoot);
      const appRoot = join(resourceRoot, "app");
      mkdirSync(join(appRoot, "dist", "cli"), { recursive: true });
      writeFileSync(join(appRoot, "package.json"), '{"name":"@oscharko-dev/keiko"}');
      writeFileSync(join(appRoot, "dist", "cli", "index.js"), "");
      const activity: ServerLogEvent[] = [];

      const result = resolveProductionOpenCodeActivation(
        activationInput(
          {
            KEIKO_CLI_BIN_PATH: join(appRoot, "dist", "cli", "index.js"),
            KEIKO_UI_PORT: "1983",
            ...(management === undefined ? {} : { KEIKO_PORTABLE_MANAGEMENT: management }),
          },
          { activity, platform: "linux", arch: "x64" },
        ),
      );

      expect(result.unavailableReason).toBe(expected);
      expect(activity.at(-1)).toMatchObject({
        op: "coding-runtime.install.unqualified",
        errorKind: "unavailable",
        extra: { reason: expected },
      });
    },
  );

  it("classifies a tampered dev-lane payload separately from routine unavailability", () => {
    const staged = devLaneFixture();
    const activity: ServerLogEvent[] = [];
    writeFileSync(staged.paths.executable, "tampered");

    resolveProductionOpenCodeActivation(
      activationInput({ ...staged.env, KEIKO_UI_PORT: "1983" }, { activity }),
    );

    expect(activity.at(-1)).toMatchObject({
      errorKind: "validation-failed",
      extra: { reason: "payload-tampered" },
    });
  });

  it("names secure-read-unavailable when workspace-root resolution is not composed", () => {
    const staged = devLaneFixture();
    const result = resolveProductionOpenCodeActivation(
      activationInput({ ...staged.env, KEIKO_UI_PORT: "1983" }, { withWorkspaceRoot: false }),
    );
    expect(result.ports).toBeUndefined();
    expect(result.unavailableReason).toBe("secure-read-unavailable");
  });

  it("activates the staged dev lane through production discovery with all prerequisites", () => {
    const staged = devLaneFixture();
    const stateDir = join(staged.root, "runtime-state");
    const result = resolveProductionOpenCodeActivation(
      activationInput({ ...staged.env, KEIKO_UI_PORT: "1983" }, { stateDir }),
    );
    expect(result.unavailableReason).toBeUndefined();
    expect(result.ports).toBeDefined();
    expect(result.ports?.backend).toBeDefined();
    expect(result.ports?.secureWorkspaceTextRead).toBeDefined();
    expect(result.ports?.editorAgentClient).toBeDefined();
    // #3904 AC4: the version the verified sidecar metadata names, not one this build assumes.
    expect(result.runtimeVersion).toEqual({
      opencode: OPENCODE_PINNED_VERSION,
      pinned: OPENCODE_PINNED_VERSION,
      origin: "dev-checkout",
    });
  });

  // #3903: the backend reads a native run's repository items through this same host read port, and
  // the operator's switch reaches it as a decision, never as the raw value.
  it.each([
    [undefined, true],
    ["true", true],
    [" TRUE ", true],
    ["false", false],
    ["maybe", false],
    ["", false],
  ])("hands the backend the repository items switch %j as %s", (value, expected) => {
    const staged = devLaneFixture();
    const create = vi.spyOn(backendModule, "createProductionOpenCodeBackend");
    const result = resolveProductionOpenCodeActivation(
      activationInput({
        ...staged.env,
        KEIKO_UI_PORT: "1983",
        ...(value === undefined ? {} : { KEIKO_CODING_REPOSITORY_ITEMS_ENABLED: value }),
      }),
    );

    expect(result.ports).toBeDefined();
    const backendInput = create.mock.calls.at(-1)?.[0];
    expect(backendInput?.repositoryItemsEnabled).toBe(expected);
    expect(backendInput?.secureWorkspaceTextRead).toBe(result.ports?.secureWorkspaceTextRead);
  });

  // #3903 AC2: the operator's plugin registry is read from Keiko's own state directory, at each
  // native run's prepare, never from the workspace.
  it("hands the backend the operator plugin registry of the runtime state directory", () => {
    const staged = devLaneFixture();
    const stateDir = join(staged.root, "runtime-state");
    mkdirSync(stateDir, { recursive: true });
    makeOwnerPrivateDirectory(stateDir);
    const create = vi.spyOn(backendModule, "createProductionOpenCodeBackend");
    resolveProductionOpenCodeActivation(
      activationInput({ ...staged.env, KEIKO_UI_PORT: "1983" }, { stateDir }),
    );
    const registry = create.mock.calls.at(-1)?.[0].operatorPluginRegistry;
    expect(registry?.()).toEqual({ state: "absent", plugins: [] });
    writeFileSync(join(stateDir, "opencode-plugins.json"), '{"schemaVersion":1,"plugins":[]}', {
      mode: 0o600,
    });
    expect(registry?.()).toEqual({ state: "loaded", plugins: [] });
  });

  it("activates the staged Windows dev lane through the production composition", () => {
    const staged = devLaneFixture("windows-x64");
    const stateDir = join(staged.root, "runtime-state");
    const activity: ServerLogEvent[] = [];
    const result = resolveProductionOpenCodeActivation(
      activationInput(
        { ...staged.env, KEIKO_UI_PORT: "1983" },
        { platform: "win32", arch: "x64", stateDir, activity },
      ),
    );

    expect(result.unavailableReason).toBeUndefined();
    expect(result.ports?.backend).toBeDefined();
    expect(result.ports?.secureWorkspaceTextRead).toBeDefined();
    expect(activity).toHaveLength(1);
    const [event] = activity;
    if (event === undefined) throw new Error("dev-lane-activation-log-missing");
    expect(event).toMatchObject({
      category: "process",
      op: "coding-runtime.dev-lane.activated",
      correlationId: UNKNOWN_CORRELATION_ID,
      extra: { lane: "dev-checkout", target: "windows-x64" },
    });
    expect(event.extra?.runtimeSupervisorSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(event.extra?.secureReadByteCap).toBe(1_048_576);
    expect(event.extra?.secureReadHelperSha256).toMatch(/^[a-f0-9]{64}$/u);
    const activatedProof = expectActivityLogProof(
      "coding-runtime.dev-lane.activated.emitted-line",
      formatActivityLogProofLine(event),
    );
    expect(activatedProof).toMatchObject({
      correlationId: UNKNOWN_CORRELATION_ID,
      lane: "dev-checkout",
      target: "windows-x64",
      evidenceClass: "functional-not-platform-qualified",
    });
  });

  // #4068 (ADR-0043 D21): the verified supervisor confines a Windows run itself, as the signed-in
  // user, so readiness asks no installed service and offers Coding without elevation, whoever
  // manages the installation. The standalone folder package (managed outside the app, ADR-0121 D9)
  // used to read `gateway-service-managed-outside` here and could never start a run.
  it.each([undefined, "user-local", "organization-managed", "machine-managed", "not-a-known-mode"])(
    "needs no installed service for a staged Windows dev lane (management %s)",
    (management) => {
      const staged = devLaneFixture("windows-x64");
      const result = resolveProductionOpenCodeActivation(
        activationInput(
          {
            ...staged.env,
            KEIKO_UI_PORT: "1983",
            ...(management === undefined ? {} : { KEIKO_PORTABLE_MANAGEMENT: management }),
          },
          { platform: "win32", arch: "x64", stateDir: join(staged.root, "runtime-state") },
        ),
      );

      expect(result.unavailableReason).toBeUndefined();
    },
  );

  it("has no Windows refusal for a macOS dev lane", () => {
    const staged = devLaneFixture();
    const result = resolveProductionOpenCodeActivation(
      activationInput(
        { ...staged.env, KEIKO_UI_PORT: "1983" },
        { stateDir: join(staged.root, "runtime-state") },
      ),
    );

    expect(result.unavailableReason).toBeUndefined();
  });

  it("prefers an injected secure-read port over dev-lane construction", () => {
    const staged = devLaneFixture();
    const result = resolveProductionOpenCodeActivation(
      activationInput({ ...staged.env, KEIKO_UI_PORT: "1983" }, { withSecureRead: true }),
    );
    expect(result.ports?.secureWorkspaceTextRead).toBe(secureRead);
  });
});
