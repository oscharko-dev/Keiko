import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  buildRuntimeGatewaySeatbeltCommand,
  createRuntimeGatewayConfinement,
  nativeToolchainReadRoots,
  resolveDarwinGitExecutable,
} from "@oscharko-dev/keiko-sandbox";
import { buildOpenCodeLaunchProfile, openCodeConfigDirectory } from "./opencodeLaunchProfile.js";
import { readProjectConfigDocuments } from "./opencodeConfigDocuments.js";
import { openCodeNativeEgress } from "./opencodeNativeEgress.js";
import { createGeneratedOpenCodeV2Plugins } from "./opencodeRuntimeAdapter.js";
import { OPENCODE_PINNED_VERSION } from "./opencodeRuntimeVersions.js";
import { createOpenCodeV2HttpClient, type OpenCodeV2HttpClient } from "./opencodeV2HttpClient.js";

import {
  startNativeHttpByteListener,
  parseNativeHttpJson,
  closeNativeHttpStub as closeStub,
  withNativeHttpStub,
} from "../../../../tests/support/opencode-native-http.js";
import {
  nativeChildEndpoint as childEndpoint,
  withNativeChild,
} from "../../../../tests/support/opencode-native-child.js";

/**
 * Original-runtime proof for the built-in formatter governance (#3897, parity row C07). The pinned
 * 2.1.4 producer runs a built-in formatter after its own `edit` and `write` tools as a plain child
 * process, consulting no permission, and runs none unless the configuration says `formatter: true`.
 * Keiko therefore sets the setting explicitly per launch mode (`openCodeNativeFormatterDisposition`).
 * The pinned executable runs under the real native Seatbelt wrapper with the profile
 * `buildOpenCodeLaunchProfile` produces. The formatter is the producer's `gofmt` built-in, which
 * needs only an executable of that name on the launcher's PATH, so a stand-in keeps the proof
 * hermetic; a repository that ships the real prettier is the control for the package-manager
 * formatters. Run with KEIKO_OPENCODE_REAL_BINARY and KEIKO_OPENCODE_REAL_RESOURCE_ROOT set;
 * otherwise it is skipped.
 */
const BINARY = process.env.KEIKO_OPENCODE_REAL_BINARY;
const RESOURCE_ROOT = process.env.KEIKO_OPENCODE_REAL_RESOURCE_ROOT;
const GATEWAY_CAPABILITY = "fixture-gateway-capability";
const FACADE_CAPABILITY = "fixture-facade-capability";

// The fixture `gofmt` collapses runs of spaces; prettier would also add the semicolon and braces.
const MIS_FORMATTED = "package   main\n";
const FORMATTED = "package main\n";
const EDIT_FORMATTED = "package renamed pkg\n";
const MIS_FORMATTED_JS = "const answer   =   {value:42}\n";
const FORMATTED_JS = "const answer = { value: 42 };\n";

interface Recorded {
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

type Mode = "governed-assist" | "supervised-coding" | "autonomous-delivery";

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly state: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function frame(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

async function startStub(
  respond: (stub: Stub, recorded: Recorded, response: ServerResponse) => void,
): Promise<Stub> {
  const requests: Recorded[] = [];
  const stub: Stub = { port: 0, requests, server: createServer() };
  await startNativeHttpByteListener(stub, (_request, bytes, response) => {
    const recorded = {
      body: parseNativeHttpJson(bytes.toString("utf8")),
    };
    requests.push(recorded);
    respond(stub, recorded, response);
  });
  return stub;
}

function lastRole(body: unknown): unknown {
  const messages = object(body)?.messages;
  return Array.isArray(messages) ? object(messages.at(-1))?.role : undefined;
}

function streamedTurn(response: ServerResponse, delta: unknown, finish: string): void {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = (payload: unknown, reason: string | null): string =>
    frame({
      id: "native-formatter",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: payload, finish_reason: reason }],
    });
  response.write(chunk(delta, null));
  response.end(
    frame({
      id: "native-formatter",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    }) + "data: [DONE]\n\n",
  );
}

async function startGateway(): Promise<GatewayStub> {
  const stub = await startStub((self, recorded, response) => {
    const gateway = self as GatewayStub;
    if (gateway.toolTurns > 0 && lastRole(recorded.body) === "user") {
      gateway.toolTurns -= 1;
      const call = {
        index: 0,
        id: `call_formatter_${String(self.requests.length)}`,
        type: "function",
        function: { name: gateway.call.name, arguments: JSON.stringify(gateway.call.arguments) },
      };
      streamedTurn(response, { tool_calls: [call] }, "tool_calls");
      return;
    }
    streamedTurn(response, { content: "Fixture turn completed." }, "stop");
  });
  const call: ScriptedCall = { name: "read", arguments: {} };
  return Object.assign(stub, { toolTurns: 0, call });
}

/** Allows every action the generated policy plugin asks about, as Full access would. */
async function startFacade(): Promise<Stub> {
  return await startStub((_self, _recorded, response) => {
    response.writeHead(200, { "Content-Type": "application/json" }).end('{"effect":"allow"}');
  });
}

/**
 * The host toolchain directory of the fixture launcher: a `gofmt` that collapses runs of spaces in
 * the file it is given, standing in for the host's real formatter so the proof is hermetic. The
 * producer's `gofmt` built-in needs nothing but an executable of that name on the launcher's PATH
 * (`gofmt -w $FILE`), which is how every PATH-resolved built-in finds its tool.
 */
function writeHostToolchain(state: string): string {
  const bin = join(state, "toolchain", "bin");
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  // A custom formatter a project configures by command (#3900 AC4): upper-cases the file.
  writeFileSync(
    join(bin, "keiko-upper"),
    [
      "#!/bin/sh",
      'tmp="$1.upper.$$"',
      '/usr/bin/tr a-z A-Z < "$1" > "$tmp" && /bin/mv "$tmp" "$1"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "gofmt"),
    [
      "#!/bin/sh",
      '[ "$1" = "-w" ] || exit 2',
      'tmp="$2.gofmt.$$"',
      '/usr/bin/sed -e "s/  */ /g" "$2" > "$tmp" && /bin/mv "$tmp" "$2"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return bin;
}

/**
 * A repository that ships its own prettier: the package declares the dependency (the producer's
 * detection rule for it) and `node_modules/.bin/prettier` is the real executable from this checkout.
 */
function installRepositoryPrettier(workspace: string): void {
  mkdirSync(join(workspace, "node_modules", ".bin"), { recursive: true });
  writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify({
      name: "formatter-fixture",
      private: true,
      devDependencies: { prettier: "*" },
    }),
  );
  const prettier = dirname(createRequire(import.meta.url).resolve("prettier/package.json"));
  cpSync(prettier, join(workspace, "node_modules", "prettier"), { recursive: true });
  symlinkSync("../prettier/bin/prettier.cjs", join(workspace, "node_modules", ".bin", "prettier"));
}

/**
 * A loopback npm registry that serves one package named `prettier`: a stand-in whose executable
 * rewrites the file it is given to `FORMATTED_JS`. The producer resolves its package-manager
 * formatters by installing them into its own cache from the registry npm is configured with, as in
 * standalone OpenCode; this fixture is that registry, so the proof stays hermetic.
 */
async function startPrettierRegistry(root: string): Promise<Stub & { readonly url: string }> {
  const source = join(root, "registry-source", "package");
  mkdirSync(join(source, "bin"), { recursive: true });
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({ name: "prettier", version: "3.0.0", bin: { prettier: "bin/prettier.cjs" } }),
  );
  writeFileSync(
    join(source, "bin", "prettier.cjs"),
    [
      "#!/usr/bin/env node",
      'const file = process.argv.find((arg) => !arg.startsWith("-") && arg !== process.argv[0] && arg !== process.argv[1]);',
      `require("node:fs").writeFileSync(file, ${JSON.stringify(FORMATTED_JS)});`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const tarball = join(root, "prettier-3.0.0.tgz");
  const packed = spawnSync("/usr/bin/tar", ["-czf", tarball, "-C", dirname(source), "package"]);
  if (packed.status !== 0) throw new Error("fixture-tarball-failed");
  const bytes = readFileSync(tarball);
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const shasum = createHash("sha1").update(bytes).digest("hex");
  const registry = await startStub((self, _recorded, response) => {
    const url = `http://127.0.0.1:${String(self.port)}`;
    const path = (response.req.url ?? "").split("?")[0];
    if (path === "/prettier") {
      response.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          name: "prettier",
          "dist-tags": { latest: "3.0.0" },
          versions: {
            "3.0.0": {
              name: "prettier",
              version: "3.0.0",
              bin: { prettier: "bin/prettier.cjs" },
              dist: { tarball: `${url}/prettier/-/prettier-3.0.0.tgz`, integrity, shasum },
            },
          },
        }),
      );
      return;
    }
    if (path === "/prettier/-/prettier-3.0.0.tgz") {
      response.writeHead(200, { "Content-Type": "application/octet-stream" }).end(bytes);
      return;
    }
    response.writeHead(404).end();
  });
  return Object.assign(registry, { url: `http://127.0.0.1:${String(registry.port)}/` });
}

function createFixture(prettier: boolean): Fixture {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "keiko-native-formatter-"));
  try {
    const root = realpathSync(temporaryRoot);
    const workspace = join(root, "workspace");
    const state = join(root, "state");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(state, { recursive: true, mode: 0o700 });
    if (prettier) installRepositoryPrettier(workspace);
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
    return { root, workspace, state };
  } catch (error) {
    try {
      rmSync(temporaryRoot, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "fixture-root-cleanup-failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}

interface Launched {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly password: string;
}

interface LaunchOptions {
  readonly mode: Mode;
  /** Narrows the kernel egress below the mode's own, so a fixture never reaches a registry. */
  readonly egress?: "loopback-only";
  /** The repository ships its own prettier (the control for the package-manager formatters). */
  readonly repositoryPrettier?: true;
  /** `absent` is the control: the binding says nothing about formatters, so the producer decides. */
  readonly formatterKey: "bound" | "absent";
  /** The workspace's own `opencode.json`, read as production reads it (#3900 AC4). */
  readonly projectConfig?: Readonly<Record<string, unknown>>;
  /** The registry the producer's package manager resolves its package formatters from. */
  readonly npmRegistry?: string;
}

/** The project's configuration documents, through production's reader over the fixture workspace. */
async function projectDocuments(
  fixture: Fixture,
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const read = await readProjectConfigDocuments({
    readText: ({ relativePath }) => {
      try {
        return Promise.resolve({
          ok: true,
          text: readFileSync(join(fixture.workspace, relativePath), "utf8"),
        });
      } catch {
        return Promise.resolve({ ok: false, reason: "not-found" });
      }
    },
  });
  return read.documents;
}

/** The production profile for a mode, optionally without the formatter key (the control only). */
function profileFor(
  fixture: Fixture,
  binary: string,
  options: LaunchOptions,
  formatterDocuments: readonly Readonly<Record<string, unknown>>[],
): { readonly config: string; readonly env: Record<string, string>; readonly args: string[] } {
  const profile = buildOpenCodeLaunchProfile({
    executable: binary,
    stateRoot: fixture.state,
    toolProfile: "native",
    mode: options.mode,
    formatterDocuments,
    contextGeometry: {
      contextWindowTokens: 32_768,
      maxInputTokens: 24_000,
      maxOutputTokens: 4_096,
    },
  });
  if (!profile.ok) throw new Error("fixture-profile-invalid");
  const strip = (json: string): string => {
    const value = JSON.parse(json) as Record<string, unknown>;
    delete value.formatter;
    return JSON.stringify(value);
  };
  if (options.formatterKey === "bound")
    return { config: profile.config, env: { ...profile.env }, args: [...profile.args] };
  return {
    config: strip(profile.config),
    env: {
      ...profile.env,
      OPENCODE_CONFIG_CONTENT: strip(profile.env.OPENCODE_CONFIG_CONTENT ?? ""),
    },
    args: [...profile.args],
  };
}

function materializePrivateConfiguration(state: string, config: string): void {
  const configRoot = join(state, "config", "opencode");
  for (const path of [
    join(configRoot, "plugins"),
    join(state, "home"),
    join(state, "state"),
    join(state, "tmp"),
  ])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(configRoot, "opencode.json"), config, { mode: 0o600 });
  for (const [name, source] of Object.entries(createGeneratedOpenCodeV2Plugins("native")))
    writeFileSync(join(configRoot, "plugins", `${name}.ts`), source, { mode: 0o600 });
}

function launch(
  fixture: Fixture,
  binary: string,
  runtimeRoot: string,
  stubs: { readonly gateway: Stub; readonly facade: Stub },
  options: LaunchOptions,
  formatterDocuments: readonly Readonly<Record<string, unknown>>[],
): Launched {
  const profile = profileFor(fixture, binary, options, formatterDocuments);
  materializePrivateConfiguration(fixture.state, profile.config);
  const git = resolveDarwinGitExecutable();
  // The production derivation: the launcher's PATH feeds the child and the kernel read allowlist.
  // It carries the host toolchain and the interpreter running this suite, which a repository's
  // prettier would need if the producer ever ran it.
  const toolchain = writeHostToolchain(fixture.state);
  const path = `${toolchain}:${dirname(process.execPath)}:${dirname(git.path)}:/usr/bin:/bin`;
  const policy = createRuntimeGatewayConfinement({
    gatewayUrl: `http://127.0.0.1:${String(stubs.gateway.port)}/v1`,
    runId: "run-native-formatter",
    treeBindingId: "a".repeat(64),
    envelopeDigest: "b".repeat(64),
    runtimeArtifactDigest: "c".repeat(64),
    modelProfileDigest: "d".repeat(64),
    profile: "keiko-native",
    egress: options.egress ?? openCodeNativeEgress(options.mode),
    filesystem: {
      workspaceRoot: fixture.workspace,
      workspaceAccess: "read-write",
      privateStateRoot: fixture.state,
      runtimeReadRoot: runtimeRoot,
      toolchainReadRoots: nativeToolchainReadRoots(path, homedir()),
      protectedWriteRoots: [openCodeConfigDirectory(fixture.state)],
    },
  });
  const command = buildRuntimeGatewaySeatbeltCommand(policy, binary, profile.args, git.path);
  const password = profile.env.OPENCODE_SERVER_PASSWORD;
  if (password === undefined) throw new Error("fixture-password-missing");
  return {
    password,
    child: spawn(command.command, [...command.args], {
      cwd: fixture.workspace,
      env: {
        ...profile.env,
        PATH: path,
        KEIKO_MODEL_GATEWAY_URL: `http://127.0.0.1:${String(stubs.gateway.port)}/v1`,
        KEIKO_MODEL_GATEWAY_CAPABILITY: GATEWAY_CAPABILITY,
        KEIKO_TOOL_FACADE_URL: `http://127.0.0.1:${String(stubs.facade.port)}/native-policy`,
        KEIKO_TOOL_FACADE_CAPABILITY: FACADE_CAPABILITY,
        KEIKO_CODING_RUN_ID: "run-native-formatter",
        KEIKO_CODING_MODE: options.mode,
        ...(options.npmRegistry === undefined ? {} : { npm_config_registry: options.npmRegistry }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  };
}

interface Run {
  readonly fixture: Fixture;
  readonly gateway: GatewayStub;
  readonly facade: Stub;
  readonly client: OpenCodeV2HttpClient;
  readonly sessionId: string;
}

async function withRun(options: LaunchOptions, body: (run: Run) => Promise<void>): Promise<void> {
  if (BINARY === undefined || RESOURCE_ROOT === undefined)
    throw new Error("fixture-binary-missing");
  expect(process.platform).toBe("darwin");
  const binary = BINARY;
  const resourceRoot = RESOURCE_ROOT;
  const fixture = createFixture(options.repositoryPrettier === true);
  try {
    if (options.projectConfig !== undefined)
      writeFileSync(
        join(fixture.workspace, "opencode.json"),
        JSON.stringify(options.projectConfig),
      );
    const gateway = await startGateway();
    await withNativeHttpStub(gateway, async (): Promise<void> => {
      const facade = await startFacade();
      await withNativeHttpStub(facade, async (): Promise<void> => {
        const launched = launch(
          fixture,
          realpathSync(binary),
          realpathSync(resourceRoot),
          { gateway, facade },
          options,
          await projectDocuments(fixture),
        );
        await withNativeChild(launched.child, async (): Promise<void> => {
          const client = createOpenCodeV2HttpClient({
            endpoint: await childEndpoint(launched.child),
            password: launched.password,
          });
          expect((await client.info()).version).toBe(OPENCODE_PINNED_VERSION);
          const session = await client.createSession(fixture.workspace);
          if (typeof session.id !== "string") throw new Error("fixture-session-invalid");
          await body({ fixture, gateway, facade, client, sessionId: session.id });
        });
      });
    });
  } catch (error) {
    try {
      rmSync(fixture.root, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "fixture-root-cleanup-failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
  rmSync(fixture.root, { recursive: true, force: true });
}

/** Runs one scripted native tool call and waits for the follow-up request that carries its result. */
async function scriptedTurn(run: Run, call: ScriptedCall): Promise<void> {
  const before = run.gateway.requests.length;
  run.gateway.call = call;
  run.gateway.toolTurns = 1;
  await run.client.prompt(run.sessionId, "Run the scripted call.");
  await expect
    .poll(() => run.gateway.requests.length, { timeout: 60_000 })
    .toBeGreaterThanOrEqual(before + 2);
}

function read(run: Run, name: string): string {
  return readFileSync(join(run.fixture.workspace, name), "utf8");
}

/** Every permission the generated policy plugin asked the server-owned policy about, in order. */
function askedPermissions(run: Run): readonly unknown[] {
  return run.facade.requests.map((recorded) => object(recorded.body)?.permission);
}

function writeCall(name: string, content: string): ScriptedCall {
  return { name: "write", arguments: { path: name, content } };
}

function editCall(name: string, oldString: string, newString: string): ScriptedCall {
  return { name: "edit", arguments: { path: name, oldString, newString } };
}

describe("pinned native OpenCode built-in formatter governance", () => {
  const skip = BINARY === undefined || RESOURCE_ROOT === undefined;

  it.skipIf(skip)(
    "Full access: runs the PATH-resolved built-in after a native write and a native edit, asking no permission for it",
    async () => {
      await withRun({ mode: "autonomous-delivery", formatterKey: "bound" }, async (run) => {
        await scriptedTurn(run, writeCall("main.go", MIS_FORMATTED));
        expect(read(run, "main.go")).toBe(FORMATTED);
        await scriptedTurn(run, editCall("main.go", "main", "renamed   pkg"));
        expect(read(run, "main.go")).toBe(EDIT_FORMATTED);
        // The hook was asked about the edits and nothing else: the formatter is a plain child
        // process of the runtime that no permission sees, which is why the mode must decide.
        expect(new Set(askedPermissions(run))).toEqual(new Set(["edit"]));
      });
    },
    180_000,
  );

  it.skipIf(skip)(
    "Ask for approval and Supervised workspace: the same write and edit land verbatim, no formatter runs",
    async () => {
      for (const mode of ["governed-assist", "supervised-coding"] as const) {
        await withRun({ mode, formatterKey: "bound" }, async (run) => {
          await scriptedTurn(run, writeCall("main.go", MIS_FORMATTED));
          expect(read(run, "main.go")).toBe(MIS_FORMATTED);
          await scriptedTurn(run, editCall("main.go", "main", "renamed   pkg"));
          expect(read(run, "main.go")).toBe("package   renamed   pkg\n");
        });
      }
    },
    240_000,
  );

  // The control shows the producer's own default, and that the binding is what turns it on: without
  // the key even a Full access tree runs no formatter, so the positive proof above cannot be an
  // accident of the fixture, and the negative proof cannot be a fixture that never formats.
  it.skipIf(skip)(
    "control: without the formatter setting the producer runs no formatter, even in Full access",
    async () => {
      await withRun({ mode: "autonomous-delivery", formatterKey: "absent" }, async (run) => {
        await scriptedTurn(run, writeCall("main.go", MIS_FORMATTED));
        expect(read(run, "main.go")).toBe(MIS_FORMATTED);
      });
    },
    120_000,
  );

  // The producer resolves prettier (like oxfmt and biome) through its own package manager and
  // package cache, not through the repository's `node_modules/.bin`, and Keiko keeps that package
  // manager offline. With the formatter enabled and the real prettier installed in the repository,
  // the file is therefore left alone: a repository's own executable is never what a built-in
  // formatter runs. This pins that fact; if a producer release changed it, a repository could run
  // code without any permission, and the mode rule above would no longer be enough.
  it.skipIf(skip)(
    "control: a repository's own prettier is never run, even with the formatter enabled",
    async () => {
      const options = {
        mode: "autonomous-delivery",
        formatterKey: "bound",
        egress: "loopback-only",
        repositoryPrettier: true,
      } as const;
      await withRun(options, async (run) => {
        await scriptedTurn(run, writeCall("module.js", MIS_FORMATTED_JS));
        expect(read(run, "module.js")).toBe(MIS_FORMATTED_JS);
        // The positive control: the repository's prettier works, so it was left unused.
        const prettier = join(run.fixture.workspace, "node_modules", ".bin", "prettier");
        const file = join(run.fixture.workspace, "module.js");
        expect(spawnSync(process.execPath, [prettier, "--write", file]).status).toBe(0);
        expect(read(run, "module.js")).toBe(FORMATTED_JS);
      });
    },
    120_000,
  );

  // #3900 AC4: in Full access the project's own `formatter` configuration selects, disables and
  // adds formatters exactly as in standalone OpenCode; every other mode runs none of them.
  const configured = {
    formatter: {
      gofmt: { disabled: true },
      upper: { command: ["keiko-upper", "$FILE"], extensions: [".txt"] },
    },
  };

  it.skipIf(skip)(
    "Full access: runs a custom formatter the project configures and honors a disabled built-in",
    async () => {
      await withRun(
        { mode: "autonomous-delivery", formatterKey: "bound", projectConfig: configured },
        async (run) => {
          await scriptedTurn(run, writeCall("notes.txt", "hello formatter\n"));
          expect(read(run, "notes.txt")).toBe("HELLO FORMATTER\n");
          await scriptedTurn(run, writeCall("main.go", MIS_FORMATTED));
          expect(read(run, "main.go")).toBe(MIS_FORMATTED);
        },
      );
    },
    180_000,
  );

  it.skipIf(skip)(
    "Ask for approval and Supervised workspace: the configured custom formatter never runs",
    async () => {
      for (const mode of ["governed-assist", "supervised-coding"] as const) {
        await withRun({ mode, formatterKey: "bound", projectConfig: configured }, async (run) => {
          await scriptedTurn(run, writeCall("notes.txt", "hello formatter\n"));
          expect(read(run, "notes.txt")).toBe("hello formatter\n");
        });
      }
    },
    240_000,
  );

  // The package formatters (prettier, oxfmt, biome) are installed by the producer's own package
  // manager into its cache, as in standalone OpenCode. In Full access that package manager reaches
  // its registry; here the registry is a loopback fixture serving a stand-in prettier.
  it.skipIf(skip)(
    "Full access: the producer's package manager installs prettier from the registry and runs it",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-formatter-registry-")));
      const registry = await startPrettierRegistry(root);
      try {
        await withRun(
          {
            mode: "autonomous-delivery",
            formatterKey: "bound",
            npmRegistry: registry.url,
            projectConfig: {},
          },
          async (run) => {
            writeFileSync(
              join(run.fixture.workspace, "package.json"),
              JSON.stringify({
                name: "fixture",
                private: true,
                devDependencies: { prettier: "*" },
              }),
            );
            await scriptedTurn(run, writeCall("module.js", MIS_FORMATTED_JS));
            await expect.poll(() => read(run, "module.js"), { timeout: 60_000 }).toBe(FORMATTED_JS);
          },
        );
      } finally {
        await closeStub(registry);
        rmSync(root, { recursive: true, force: true });
      }
    },
    240_000,
  );
});
