import {
  nativeFixtureLaunchProfile,
  prepareNativeConfigurationRoot,
  initializeFixtureGitWorkspace,
  removeFixtureRootAfterFailure,
} from "../../../../tests/support/opencode-native-launch.js";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  buildRuntimeGatewaySeatbeltCommand,
  createRuntimeGatewayConfinement,
  nativeToolchainReadRoots,
  resolveDarwinGitExecutable,
} from "@oscharko-dev/keiko-sandbox";
import { buildSandboxEnv } from "@oscharko-dev/keiko-tools";
import { openCodeConfigDirectory } from "./opencodeLaunchProfile.js";
import {
  resolveOpenCodeRipgrep,
  ripgrepLaunchEnvironment,
  ripgrepNativePath,
  type OpenCodeRipgrepResolution,
} from "./opencodeRipgrepLaunch.js";
import { createGeneratedOpenCodeV2Plugins } from "./opencodeRuntimeAdapter.js";
import { OPENCODE_PINNED_VERSION } from "./opencodeRuntimeVersions.js";
import { createOpenCodeV2HttpClient, type OpenCodeV2HttpClient } from "./opencodeV2HttpClient.js";
import { RIPGREP_RUNTIME_MANIFEST } from "./ripgrepRuntime.js";

import {
  writeNativeHttpScriptedTurn,
  startNativeHttpStub as startStub,
  withNativeHttpStub,
} from "../../../../tests/support/opencode-native-http.js";
import {
  nativeChildEndpoint as childEndpoint,
  withNativeChild,
  NATIVE_FIXTURE_DIGESTS,
} from "../../../../tests/support/opencode-native-child.js";

/**
 * Original-runtime proof that the pinned OpenCode finds ripgrep OFFLINE and only where Keiko puts
 * it (#3897). The pinned executable runs under the real native Seatbelt wrapper with the profile
 * `buildOpenCodeLaunchProfile` produces and the child PATH and kernel read allowlist the
 * production launch derives (`resolveOpenCodeRipgrep`, `ripgrepLaunchEnvironment`,
 * `ripgrepNativePath`). Network is loopback-only, so any attempt to download ripgrep cannot
 * succeed, and the runtime's own cache directory is inspected afterwards. Needs the pinned
 * ripgrep provisioned (`npm run provision:ripgrep`) and, like the other real suites,
 * KEIKO_OPENCODE_REAL_BINARY and KEIKO_OPENCODE_REAL_RESOURCE_ROOT; without the latter two it is
 * skipped, and with them a missing provisioned ripgrep FAILS rather than hiding the gap.
 */
const BINARY = process.env.KEIKO_OPENCODE_REAL_BINARY;
const RESOURCE_ROOT = process.env.KEIKO_OPENCODE_REAL_RESOURCE_ROOT;
const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../../..");
const GATEWAY_CAPABILITY = "fixture-gateway-capability";
const FACADE_CAPABILITY = "fixture-facade-capability";
const NEEDLE = "needle-token-for-ripgrep";

interface Recorded {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

interface Stub {
  readonly server: Server;
  port: number;
  readonly requests: Recorded[];
}

interface ScriptedCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

interface GatewayStub extends Stub {
  toolTurns: number;
  call: ScriptedCall;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function startGateway(): Promise<GatewayStub> {
  const stub = await startStub((self, recorded, response) => {
    const gateway = self as GatewayStub;
    writeNativeHttpScriptedTurn(
      gateway,
      recorded,
      response,
      () => `call_ripgrep_${String(self.requests.length)}`,
      "ripgrep-real",
    );
  });
  return Object.assign(stub, { toolTurns: 0, call: { name: "glob", arguments: {} } });
}

async function startFacade(): Promise<Stub> {
  return await startStub((_self, _recorded, response) => {
    response.writeHead(200, { "Content-Type": "application/json" }).end('{"effect":"allow"}');
  });
}

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly state: string;
}

function createFixture(): Fixture {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "keiko-ripgrep-real-"));
  try {
    const root = realpathSync(temporaryRoot);
    const workspace = join(root, "workspace");
    const state = join(root, "state");
    mkdirSync(join(workspace, "src"), { recursive: true });
    mkdirSync(state, { recursive: true, mode: 0o700 });
    writeFileSync(join(workspace, "README.md"), "ripgrep launch fixture\n");
    writeFileSync(join(workspace, "src", "notes.txt"), `alpha\n${NEEDLE} beta\n`);
    initializeFixtureGitWorkspace(workspace, state);
    return { root, workspace, state };
  } catch (error) {
    removeFixtureRootAfterFailure(temporaryRoot, error);
  }
}

function materializePrivateConfiguration(state: string, config: string): void {
  const configRoot = prepareNativeConfigurationRoot(state, config);
  for (const [name, source] of Object.entries(createGeneratedOpenCodeV2Plugins("native")))
    writeFileSync(join(configRoot, "plugins", `${name}.ts`), source, { mode: 0o600 });
}

/** `child-path` is production: the kernel opens what the child PATH names. The other is a control. */
type KernelAllowlist = "child-path" | "launcher-path-only";

interface Stubs {
  readonly gateway: Stub;
  readonly facade: Stub;
}

interface Launched {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly password: string;
  readonly environment: Readonly<Record<string, string>>;
}

/** The launcher's own PATH: the toolchain a standalone shell would see, with no ripgrep on it. */
function launcherPath(): string {
  return [dirname(resolveDarwinGitExecutable().path), "/usr/bin", "/bin"].join(delimiter);
}

function launch(
  fixture: Fixture,
  binary: string,
  runtimeRoot: string,
  stubs: Stubs,
  resolution: OpenCodeRipgrepResolution,
  allowlist: KernelAllowlist,
): Launched {
  const profile = nativeFixtureLaunchProfile(binary, fixture.state);
  materializePrivateConfiguration(fixture.state, profile.config);
  const git = resolveDarwinGitExecutable();
  const launcher = launcherPath();
  // The production derivation: the same PATH string feeds the child and the kernel allowlist.
  const inherited = ripgrepLaunchEnvironment({ PATH: launcher }, resolution, true);
  const childPath = buildSandboxEnv(inherited ?? {}, ["PATH"]).PATH;
  if (childPath === undefined) throw new Error("fixture-path-missing");
  const policy = createRuntimeGatewayConfinement({
    gatewayUrl: `http://127.0.0.1:${String(stubs.gateway.port)}/v1`,
    runId: "run-ripgrep-real",
    ...NATIVE_FIXTURE_DIGESTS,
    profile: "keiko-native",
    filesystem: {
      workspaceRoot: fixture.workspace,
      workspaceAccess: "read-write",
      privateStateRoot: fixture.state,
      runtimeReadRoot: runtimeRoot,
      toolchainReadRoots: nativeToolchainReadRoots(
        allowlist === "child-path"
          ? (ripgrepNativePath(launcher, resolution) ?? launcher)
          : launcher,
        homedir(),
      ),
      protectedWriteRoots: [openCodeConfigDirectory(fixture.state)],
    },
  });
  const command = buildRuntimeGatewaySeatbeltCommand(policy, binary, profile.args, git.path);
  const password = profile.env.OPENCODE_SERVER_PASSWORD;
  if (password === undefined) throw new Error("fixture-password-missing");
  const environment: Record<string, string> = {
    ...profile.env,
    PATH: childPath,
    KEIKO_MODEL_GATEWAY_URL: `http://127.0.0.1:${String(stubs.gateway.port)}/v1`,
    KEIKO_MODEL_GATEWAY_CAPABILITY: GATEWAY_CAPABILITY,
    KEIKO_TOOL_FACADE_URL: `http://127.0.0.1:${String(stubs.facade.port)}/native-policy`,
    KEIKO_TOOL_FACADE_CAPABILITY: FACADE_CAPABILITY,
    KEIKO_CODING_RUN_ID: "run-ripgrep-real",
    KEIKO_CODING_MODE: "governed-assist",
  };
  return {
    password,
    environment,
    child: spawn(command.command, [...command.args], {
      cwd: fixture.workspace,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  };
}

/** What the runtime sent back to the model as the result of the scripted tool call. */
function lastToolResult(gateway: Stub): string {
  const messages = object(gateway.requests.at(-1)?.body)?.messages;
  if (!Array.isArray(messages)) return "";
  const result = messages
    .map(object)
    .filter((message) => message?.role === "tool")
    .at(-1);
  return typeof result?.content === "string" ? result.content : "";
}

interface Run {
  readonly fixture: Fixture;
  readonly gateway: GatewayStub;
  readonly client: OpenCodeV2HttpClient;
  readonly sessionId: string;
}

async function scriptedTurn(run: Run, call: ScriptedCall): Promise<string> {
  const before = run.gateway.requests.length;
  run.gateway.call = call;
  run.gateway.toolTurns = 1;
  await run.client.prompt(run.sessionId, "Run the scripted search.");
  await expect
    .poll(() => run.gateway.requests.length, { timeout: 60_000 })
    .toBeGreaterThanOrEqual(before + 2);
  return lastToolResult(run.gateway);
}

/** The pinned ripgrep, verified exactly as the production launch verifies it. */
function provisionedResolution(): OpenCodeRipgrepResolution {
  const resolution = resolveOpenCodeRipgrep({
    target: "macos-arm64",
    location: { kind: "checkout", checkoutRoot: REPOSITORY_ROOT },
    env: {},
  });
  if (resolution.outcome !== "verified")
    throw new Error(
      `fixture-ripgrep-not-provisioned:${resolution.reason}; run npm run provision:ripgrep`,
    );
  return resolution;
}

/** A tampered copy at the provisioned location of a throwaway checkout: never verified. */
function tamperedResolution(root: string): OpenCodeRipgrepResolution {
  const directory = join(root, ".ripgrep", RIPGREP_RUNTIME_MANIFEST.version, "darwin-arm64");
  mkdirSync(directory, { recursive: true, mode: 0o755 });
  writeFileSync(join(directory, "rg"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  const resolution = resolveOpenCodeRipgrep({
    target: "macos-arm64",
    location: { kind: "checkout", checkoutRoot: root },
    env: {},
  });
  if (resolution.outcome !== "unverified") throw new Error("fixture-tampered-ripgrep-verified");
  return resolution;
}

async function withRun(
  resolution: () => OpenCodeRipgrepResolution,
  body: (run: Run, launched: Launched) => Promise<void>,
  allowlist: KernelAllowlist = "child-path",
): Promise<void> {
  if (BINARY === undefined || RESOURCE_ROOT === undefined)
    throw new Error("fixture-binary-missing");
  expect(process.platform).toBe("darwin");
  const binary = BINARY;
  const resourceRoot = RESOURCE_ROOT;
  const fixture = createFixture();
  try {
    const gateway = await startGateway();
    await withNativeHttpStub(gateway, async (): Promise<void> => {
      const facade = await startFacade();
      await withNativeHttpStub(facade, async (): Promise<void> => {
        const stubs = { gateway, facade };
        const launched = launch(
          fixture,
          realpathSync(binary),
          realpathSync(resourceRoot),
          stubs,
          resolution(),
          allowlist,
        );
        await withNativeChild(launched.child, async (): Promise<void> => {
          const endpoint = await childEndpoint(launched.child);
          const client = createOpenCodeV2HttpClient({ endpoint, password: launched.password });
          expect((await client.info()).version).toBe(OPENCODE_PINNED_VERSION);
          const session = await client.createSession(fixture.workspace);
          if (typeof session.id !== "string") throw new Error("fixture-session-invalid");
          await body({ fixture, gateway: stubs.gateway, client, sessionId: session.id }, launched);
        });
      });
    });
  } catch (error) {
    try {
      rmSync(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "fixture-root-cleanup-failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
  rmSync(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

/**
 * What sits in the runtime's own binary cache, the one place it downloads ripgrep to when it finds
 * none. The runtime creates the directory itself; a download would leave an executable in it.
 */
function downloadedBinaries(fixture: Fixture): readonly string[] {
  const cache = join(fixture.state, "home", ".cache", "opencode", "bin");
  return existsSync(cache) ? readdirSync(cache) : [];
}

describe("pinned native OpenCode and the verified ripgrep", () => {
  const skip = BINARY === undefined || RESOURCE_ROOT === undefined;

  it.skipIf(skip)(
    "finds files and text with no network and ripgrep only from the verified directory",
    async () => {
      const resolution = provisionedResolution();
      await withRun(
        () => resolution,
        async (run, launched) => {
          const directory = resolution.outcome === "verified" ? resolution.directory : "";
          // The child sees the verified directory first and no other ripgrep anywhere on its PATH.
          const entries = (launched.environment.PATH ?? "").split(delimiter);
          expect(entries[0]).toBe(directory);
          for (const entry of entries.slice(1)) expect(existsSync(join(entry, "rg"))).toBe(false);

          const files = await scriptedTurn(run, { name: "glob", arguments: { pattern: "*.md" } });
          expect(files.split("\n").some((line) => line.trim().endsWith("README.md"))).toBe(true);

          const text = await scriptedTurn(run, { name: "grep", arguments: { pattern: NEEDLE } });
          expect(text).toContain("notes.txt");
          expect(text).toContain(NEEDLE);

          // Resolved through PATH, never fetched: the runtime's own download target stays empty.
          expect(downloadedBinaries(run.fixture)).toEqual([]);
        },
      );
    },
    180_000,
  );

  // #3900 AC1: the original Read paging and the Glob/Grep parameters keep their own semantics.
  it.skipIf(skip)(
    "pages a file, narrows and limits glob, and searches by regex, literal, case, include and root",
    async () => {
      const resolution = provisionedResolution();
      await withRun(
        () => resolution,
        async (run) => {
          const at = (name: string): string => join(run.fixture.workspace, name);
          const notes = Array.from({ length: 30 }, (_, index) => `line ${String(index + 1)}`);
          writeFileSync(at("paged.txt"), `${notes.join("\n")}\n`);
          for (const [name, content] of [
            ["src/app.ts", "export const APP_NAME = 'Keiko';\n"],
            ["src/nested/deep.ts", "export const deep = 'needle';\n"],
            ["docs/guide.md", "# Guide\nA NEEDLE in the docs.\n"],
            [".hidden/tool.ts", "export const hidden = 'needle';\n"],
          ] as const) {
            mkdirSync(dirname(at(name)), { recursive: true });
            writeFileSync(at(name), content);
          }
          const call = (name: string, args: Readonly<Record<string, unknown>>): Promise<string> =>
            scriptedTurn(run, { name, arguments: args });

          const page = await call("read", { path: "paged.txt", offset: 10, limit: 3 });
          expect(page).toMatch(/line 10\b/u);
          expect(page).toMatch(/line 12\b/u);
          expect(page).not.toMatch(/line 9\b/u);
          expect(page).not.toMatch(/line 13\b/u);

          const all = await call("glob", { pattern: "**/*.ts" });
          expect(all).toContain("src/app.ts");
          expect(all).toContain("src/nested/deep.ts");
          expect(await call("glob", { pattern: "**/*.ts", hidden: true })).toContain(
            ".hidden/tool.ts",
          );
          const narrowed = await call("glob", { pattern: "*.ts", path: "src/nested" });
          expect(narrowed).toContain("deep.ts");
          expect(narrowed).not.toContain("app.ts");
          const limited = await call("glob", { pattern: "**/*.ts", limit: 1 });
          expect(limited.split("\n").filter((line) => line.trim().endsWith(".ts"))).toHaveLength(1);

          expect(await call("grep", { pattern: "need.e" })).toContain("deep.ts");
          expect(await call("grep", { pattern: "need.e", literal: true })).not.toContain("deep.ts");
          const caseless = await call("grep", {
            pattern: "needle",
            caseSensitive: false,
            include: "*.md",
          });
          expect(caseless).toContain("guide.md");
          expect(caseless).not.toContain("deep.ts");
          const rooted = await call("grep", { pattern: "needle", path: "src" });
          expect(rooted).toContain("deep.ts");
          expect(rooted).not.toContain("guide.md");
          expect(downloadedBinaries(run.fixture)).toEqual([]);
        },
      );
    },
    240_000,
  );

  // #3900 AC2: the verified search finds everything in a large, deep repository, while the kernel
  // keeps a credential file and a link to a file outside the workspace unreadable to the same
  // tools. The policy stub here allows every action, so the denials are the kernel's own.
  it.skipIf(skip)(
    "discovers a large, deep repository completely and never reads a credential or an outside file",
    async () => {
      const resolution = provisionedResolution();
      await withRun(
        () => resolution,
        async (run) => {
          const at = (name: string): string => join(run.fixture.workspace, name);
          // 2,000 files over 25 packages, and one file 40 directories deep.
          for (let pkg = 0; pkg < 25; pkg += 1) {
            mkdirSync(at(`packages/p${String(pkg)}/src`), { recursive: true });
            for (let file = 0; file < 80; file += 1)
              writeFileSync(
                at(`packages/p${String(pkg)}/src/f${String(file)}.ts`),
                `export const v${String(file)} = ${String(file)};\n`,
              );
          }
          const deep = Array.from({ length: 40 }, (_, index) => `d${String(index)}`).join("/");
          mkdirSync(at(deep), { recursive: true });
          writeFileSync(at(`${deep}/deepest.ts`), "export const DEEP_NEEDLE = 'found';\n");
          writeFileSync(at(".env"), "DEEP_NEEDLE=credential-canary\n");
          const outside = join(run.fixture.root, "outside.ts");
          writeFileSync(outside, "export const DEEP_NEEDLE = 'outside-canary';\n");
          symlinkSync(outside, at("linked.ts"));
          const call = (name: string, args: Readonly<Record<string, unknown>>): Promise<string> =>
            scriptedTurn(run, { name, arguments: args });

          expect(await call("glob", { pattern: "**/deepest.ts" })).toContain(`${deep}/deepest.ts`);
          const listed = await call("glob", { pattern: "packages/p24/src/*.ts" });
          expect(listed.split("\n").filter((line) => line.trim().endsWith(".ts"))).toHaveLength(80);
          const found = await call("grep", { pattern: "DEEP_NEEDLE" });
          expect(found).toContain("deepest.ts");
          expect(found).not.toContain("credential-canary");
          expect(found).not.toContain("outside-canary");
          expect(await call("grep", { pattern: "export const v79", include: "*.ts" })).toContain(
            "packages/p24/src/f79.ts",
          );
          const linked = await call("read", { path: "linked.ts" });
          expect(linked).not.toContain("outside-canary");
          expect(await call("read", { path: ".env" })).not.toContain("credential-canary");
          expect(downloadedBinaries(run.fixture)).toEqual([]);
        },
      );
    },
    300_000,
  );

  it.skipIf(skip)(
    "control: without a verified ripgrep the run starts, search degrades and nothing is downloaded",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-ripgrep-real-checkout-")));
      try {
        const resolution = tamperedResolution(root);
        expect(resolution).toMatchObject({ outcome: "unverified", reason: "digest-mismatch" });
        await withRun(
          () => resolution,
          async (run, launched) => {
            // Nothing was put in front of the launcher's PATH.
            expect(launched.environment.PATH).toBe(launcherPath());

            const files = await scriptedTurn(run, { name: "glob", arguments: { pattern: "*.md" } });
            expect(files.split("\n").some((line) => line.trim().endsWith("README.md"))).toBe(false);
            expect(downloadedBinaries(run.fixture)).toEqual([]);
          },
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    180_000,
  );

  // Not production: the same verified directory on the child PATH, but the kernel read allowlist
  // derived from the launcher PATH alone. The kernel then refuses to run it, which is why the
  // production launch derives the allowlist from the very PATH the child receives.
  it.skipIf(skip)(
    "control: a verified directory on the PATH that the kernel does not open is still unusable",
    async () => {
      const resolution = provisionedResolution();
      await withRun(
        () => resolution,
        async (run) => {
          const files = await scriptedTurn(run, { name: "glob", arguments: { pattern: "*.md" } });
          expect(files.split("\n").some((line) => line.trim().endsWith("README.md"))).toBe(false);
        },
        "launcher-path-only",
      );
    },
    180_000,
  );
});
