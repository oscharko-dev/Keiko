import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import {
  buildRuntimeGatewaySeatbeltCommand,
  createRuntimeGatewayConfinement,
  resolveDarwinGitExecutable,
} from "@oscharko-dev/keiko-sandbox";
import {
  buildOpenCodeLaunchProfile,
  openCodeConfigDirectory,
} from "../../packages/keiko-server/src/coding-runtime/opencodeLaunchProfile.js";
import { createGeneratedOpenCodeV2Plugins } from "../../packages/keiko-server/src/coding-runtime/opencodeRuntimeAdapter.js";
import { expect } from "vitest";
import { OPENCODE_PINNED_VERSION } from "../../packages/keiko-server/src/coding-runtime/opencodeRuntimeVersions.js";
import {
  NATIVE_FIXTURE_DIGESTS,
  nativeChildEndpoint,
  withNativeChild,
} from "./opencode-native-child.js";
import { nativeServiceAt, type NativeService } from "./opencode-native-http.js";

// Launch plumbing the real-binary suites share: each still launches the pinned executable under
// the real native Seatbelt wrapper with the profile `buildOpenCodeLaunchProfile` produces.

type LaunchProfileInput = Parameters<typeof buildOpenCodeLaunchProfile>[0];
type NativeLaunchProfile = Extract<ReturnType<typeof buildOpenCodeLaunchProfile>, { ok: true }>;

/** The native launch profile for a fixture state root; a refused profile fails the fixture. */
export function nativeFixtureLaunchProfile(
  executable: string,
  stateRoot: string,
  extra: Partial<Pick<LaunchProfileInput, "mcp" | "agentModels">> = {},
): NativeLaunchProfile {
  const profile = buildOpenCodeLaunchProfile({
    executable,
    stateRoot,
    toolProfile: "native",
    ...extra,
    contextGeometry: {
      contextWindowTokens: 32_768,
      maxInputTokens: 24_000,
      maxOutputTokens: 4_096,
    },
  });
  if (!profile.ok) throw new Error("fixture-profile-invalid");
  return profile;
}

/** Creates the run's private state directories and writes its configuration; returns its root. */
export function prepareNativeConfigurationRoot(state: string, config: string): string {
  const configRoot = join(state, "config", "opencode");
  for (const path of [
    join(configRoot, "plugins"),
    join(state, "home"),
    join(state, "state"),
    join(state, "tmp"),
  ])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(configRoot, "opencode.json"), config, { mode: 0o600 });
  return configRoot;
}

/** The private configuration with every generated native plugin, as a production run has it. */
export function materializeNativeConfiguration(state: string, config: string): void {
  const configRoot = prepareNativeConfigurationRoot(state, config);
  for (const [name, source] of Object.entries(createGeneratedOpenCodeV2Plugins("native")))
    writeFileSync(join(configRoot, "plugins", `${name}.ts`), source, { mode: 0o600 });
}

export interface NativeFixturePolicyInput {
  readonly gatewayUrl: string;
  readonly runId: string;
  readonly workspace: string;
  readonly state: string;
  readonly runtimeRoot: string;
}

/** The production confinement of a read-write native run over the fixture's own roots. */
export function nativeFixturePolicy(
  input: NativeFixturePolicyInput,
): ReturnType<typeof createRuntimeGatewayConfinement> {
  return createRuntimeGatewayConfinement({
    gatewayUrl: input.gatewayUrl,
    runId: input.runId,
    ...NATIVE_FIXTURE_DIGESTS,
    profile: "keiko-native",
    filesystem: {
      workspaceRoot: input.workspace,
      workspaceAccess: "read-write",
      privateStateRoot: input.state,
      runtimeReadRoot: input.runtimeRoot,
      protectedWriteRoots: [openCodeConfigDirectory(input.state)],
    },
  });
}

export interface NativeChildBinding {
  readonly path: string;
  readonly gatewayUrl: string;
  readonly gatewayCapability: string;
  readonly facadeUrl: string;
  readonly facadeCapability: string;
  readonly runId: string;
  readonly mode: string;
}

/** The launch profile's environment with the Keiko gateway, facade and run binding added. */
export function nativeChildEnvironment(
  profileEnv: Readonly<Record<string, string>>,
  binding: NativeChildBinding,
): Record<string, string> {
  return {
    ...profileEnv,
    PATH: binding.path,
    KEIKO_MODEL_GATEWAY_URL: binding.gatewayUrl,
    KEIKO_MODEL_GATEWAY_CAPABILITY: binding.gatewayCapability,
    KEIKO_TOOL_FACADE_URL: binding.facadeUrl,
    KEIKO_TOOL_FACADE_CAPABILITY: binding.facadeCapability,
    KEIKO_CODING_RUN_ID: binding.runId,
    KEIKO_CODING_MODE: binding.mode,
  };
}

export interface ConfinedNativeChild {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly password: string;
}

export interface ConfinedNativeLaunch
  extends NativeFixturePolicyInput, Omit<NativeChildBinding, "path" | "gatewayUrl"> {
  readonly binary: string;
  readonly profile: NativeLaunchProfile;
  readonly gitPath: string;
}

/**
 * Spawns the pinned executable in the fixture workspace under the real native Seatbelt wrapper,
 * with the production read-write policy and the Git directory ahead of the system path.
 */
export function spawnConfinedNativeChild(launch: ConfinedNativeLaunch): ConfinedNativeChild {
  const policy = nativeFixturePolicy(launch);
  const command = buildRuntimeGatewaySeatbeltCommand(
    policy,
    launch.binary,
    launch.profile.args,
    launch.gitPath,
  );
  const password = launch.profile.env.OPENCODE_SERVER_PASSWORD;
  if (password === undefined) throw new Error("fixture-password-missing");
  return {
    password,
    child: spawn(command.command, [...command.args], {
      cwd: launch.workspace,
      env: nativeChildEnvironment(launch.profile.env, {
        ...launch,
        path: `${dirname(launch.gitPath)}:/usr/bin:/bin`,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    }),
  };
}

/**
 * Holds the launched child for `body`: its service must report the pinned version and open a
 * session over the fixture workspace before `body` runs.
 */
export async function withPinnedNativeSession(
  launched: ConfinedNativeChild,
  workspace: string,
  body: (service: NativeService, sessionId: string) => Promise<void>,
): Promise<void> {
  await withNativeChild(launched.child, async (): Promise<void> => {
    const service = nativeServiceAt(await nativeChildEndpoint(launched.child), launched.password);
    expect((await service.client.info()).version).toBe(OPENCODE_PINNED_VERSION);
    const session = await service.client.createSession(workspace);
    if (typeof session.id !== "string") throw new Error("fixture-session-invalid");
    await body(service, session.id);
  });
}

/** Initializes `workspace` as a Git repository with no system or user configuration in effect. */
export function initializeFixtureGitWorkspace(workspace: string, state: string): void {
  const git = resolveDarwinGitExecutable();
  const initialized = spawnSync(git.path, ["init", "-q", workspace], {
    env: {
      HOME: state,
      PATH: dirname(git.path),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  if (initialized.status !== 0) throw new Error("fixture-git-initialization-failed");
}

/** Removes a fixture root whose creation failed, then rethrows; a failed removal joins the error. */
export function removeFixtureRootAfterFailure(temporaryRoot: string, error: unknown): never {
  try {
    rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], "fixture-root-cleanup-failed", {
      cause: cleanupError,
    });
  }
  throw error;
}
