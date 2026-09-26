import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable, Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { KEIKO_PRODUCT_VERSION } from "@oscharko-dev/keiko-contracts/runtime/version";

import { CodexAppServerClient, type CodexAppServerTransport } from "./codexAppServerClient.js";
import { CODEX_APP_SERVER_SCHEMA } from "./codexAppServerProtocol.js";

const FUNCTIONAL_ENABLED = process.env.KEIKO_CODEX_FUNCTIONAL === "1";
const FUNCTIONAL_BINARY = process.env.KEIKO_CODEX_APP_SERVER_BINARY;
const FUNCTIONAL_SCHEMA_DIR = process.env.KEIKO_CODEX_SCHEMA_DIR;
const REQUEST_DEADLINE_MS = 10_000;
const MAX_USER_AGENT_BYTES = 64 * 1024;
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, "../..");
const BUNDLE_DIRECTORY = join(PACKAGE_ROOT, "resources", "codex-app-server-schema");
const SCHEMA_VERIFIER = join(REPOSITORY_ROOT, "scripts", "codex-app-server-schema.mjs");

type RealChild = ChildProcessByStdio<Writable, Readable, Readable>;

interface IsolatedEnvironment extends Readonly<Record<string, string>> {
  readonly CODEX_HOME: string;
  readonly HOME: string;
  readonly USERPROFILE: string;
  readonly XDG_CACHE_HOME: string;
  readonly XDG_CONFIG_HOME: string;
  readonly XDG_DATA_HOME: string;
  readonly TMP: string;
  readonly TMPDIR: string;
  readonly TEMP: string;
}

const ISOLATED_ENVIRONMENT_VARIABLES = [
  "CODEX_HOME",
  "HOME",
  "USERPROFILE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "TMP",
  "TMPDIR",
  "TEMP",
] as const satisfies readonly (keyof IsolatedEnvironment)[];

interface SchemaManifest {
  readonly algorithm: string;
  readonly generatedFolderSha256: string;
  readonly officialReleaseAsset: { readonly extractedExecutableSha256: string };
  readonly version: string;
}

interface StdioHarness {
  readonly child: RealChild;
  readonly transport: CodexAppServerTransport;
  readonly stderr: () => string;
  stop(): Promise<void>;
}

function configuredFunctionalRun(): boolean {
  return (
    FUNCTIONAL_ENABLED &&
    absolutePath(FUNCTIONAL_BINARY) !== undefined &&
    absolutePath(FUNCTIONAL_SCHEMA_DIR) !== undefined
  );
}

function absolutePath(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 && isAbsolute(value) ? value : undefined;
}

function requiredPath(name: string, value: string | undefined): string {
  const path = absolutePath(value);
  if (path === undefined) throw new Error(`functional-codex-env-invalid:${name}`);
  return path;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function manifest(): SchemaManifest {
  return JSON.parse(
    readFileSync(join(BUNDLE_DIRECTORY, "manifest.json"), "utf8"),
  ) as SchemaManifest;
}

function isolatedEnvironment(stateRoot: string): IsolatedEnvironment {
  const codexHome = join(stateRoot, "codex-home");
  const environment = {
    CODEX_HOME: codexHome,
    HOME: join(stateRoot, "home"),
    USERPROFILE: join(stateRoot, "userprofile"),
    XDG_CACHE_HOME: join(stateRoot, "xdg-cache"),
    XDG_CONFIG_HOME: join(stateRoot, "xdg-config"),
    XDG_DATA_HOME: join(stateRoot, "xdg-data"),
    TMP: join(stateRoot, "tmp"),
    TMPDIR: join(stateRoot, "tmpdir"),
    TEMP: join(stateRoot, "temp"),
  } satisfies IsolatedEnvironment;
  for (const directory of Object.values(environment))
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  return environment;
}

function assertIsolatedEnvironment(environment: IsolatedEnvironment, stateRoot: string): void {
  expect([...ISOLATED_ENVIRONMENT_VARIABLES].sort()).toEqual([
    "CODEX_HOME",
    "HOME",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
  ]);
  for (const variable of ISOLATED_ENVIRONMENT_VARIABLES)
    expect(within(stateRoot, environment[variable])).toBe(true);
  expect(
    Object.keys(environment).some((name) =>
      /(?:api|auth|credential|key|proxy|secret|token)/iu.test(name),
    ),
  ).toBe(false);
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function isContentFreeAccount(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.keys(value).length === 3 &&
    (value as { readonly authenticated?: unknown }).authenticated === false &&
    (value as { readonly authMode?: unknown }).authMode === null &&
    typeof (value as { readonly requiresOpenaiAuth?: unknown }).requiresOpenaiAuth === "boolean"
  );
}

function isClosedInitializeResult(value: unknown, codexHome: string): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { readonly codexHome?: unknown }).codexHome === codexHome &&
    nonEmptyString((value as { readonly userAgent?: unknown }).userAgent) &&
    Buffer.byteLength((value as { readonly userAgent: string }).userAgent, "utf8") <=
      MAX_USER_AGENT_BYTES &&
    nonEmptyString((value as { readonly platformFamily?: unknown }).platformFamily) &&
    nonEmptyString((value as { readonly platformOs?: unknown }).platformOs)
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

async function verifySchemaCli(schemaDirectory: string, expected: SchemaManifest): Promise<void> {
  const verifier = spawn(process.execPath, [SCHEMA_VERIFIER, "--generated-dir", schemaDirectory], {
    cwd: REPOSITORY_ROOT,
    env: {},
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  verifier.stdout.setEncoding("utf8");
  verifier.stderr.setEncoding("utf8");
  verifier.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  verifier.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const code = await waitForExit(verifier, REQUEST_DEADLINE_MS);
  if (code !== 0)
    throw new Error(
      `functional-codex-schema-verification-failed:code=${String(code)}:stderr=${stderr}`,
    );
  expect(stdout).toContain(expected.generatedFolderSha256);
}

function startAppServer(
  executable: string,
  cwd: string,
  environment: IsolatedEnvironment,
): StdioHarness {
  const child = spawn(executable, [], {
    cwd,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const listeners = new Set<(chunk: string) => void>();
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    for (const listener of listeners) listener(chunk);
  });
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length);
  });
  return {
    child,
    transport: {
      write: (chunk: string): Promise<void> =>
        new Promise((resolveWrite, rejectWrite) => {
          child.stdin.write(chunk, (error?: Error | null) => {
            if (error === undefined || error === null) resolveWrite();
            else rejectWrite(error);
          });
        }),
      onData: (listener): (() => void) => {
        listeners.add(listener);
        return (): void => {
          listeners.delete(listener);
        };
      },
    },
    stderr: (): string => stderr,
    stop: async (): Promise<void> => {
      child.stdin.end();
      if (!child.killed) child.kill("SIGTERM");
      const code = await waitForExit(child, 5_000);
      if (code !== undefined) return;
      child.kill("SIGKILL");
      const forced = await waitForExit(child, 5_000);
      if (forced === undefined) throw new Error("functional-codex-child-not-reaped");
    },
  };
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null | undefined> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      resolveExit(undefined);
    }, timeoutMs);
    timer.unref();
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolveExit(undefined);
    });
  });
}

describe("[functional-only] real Codex app-server", () => {
  it.skipIf(!configuredFunctionalRun())(
    "uses only the explicit pinned artifact with isolated state and closed initialization",
    async () => {
      const executable = requiredPath("KEIKO_CODEX_APP_SERVER_BINARY", FUNCTIONAL_BINARY);
      const schemaDirectory = requiredPath("KEIKO_CODEX_SCHEMA_DIR", FUNCTIONAL_SCHEMA_DIR);
      const expected = manifest();
      expect(existsSync(executable)).toBe(true);
      expect(statSync(executable).isFile()).toBe(true);
      expect(existsSync(schemaDirectory)).toBe(true);
      expect(statSync(schemaDirectory).isDirectory()).toBe(true);
      expect(expected).toMatchObject({
        algorithm: CODEX_APP_SERVER_SCHEMA.algorithm,
        generatedFolderSha256: CODEX_APP_SERVER_SCHEMA.digest,
        version: CODEX_APP_SERVER_SCHEMA.version,
      });
      expect(sha256(executable)).toBe(expected.officialReleaseAsset.extractedExecutableSha256);
      await verifySchemaCli(schemaDirectory, expected);

      const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-codex-functional-")));
      const workspace = join(root, "workspace");
      const state = join(root, "state");
      const outsideStateSentinel = join(root, "outside-state.sentinel");
      mkdirSync(workspace, { recursive: true, mode: 0o700 });
      mkdirSync(state, { recursive: true, mode: 0o700 });
      writeFileSync(outsideStateSentinel, "outside-state-must-not-change\n", { mode: 0o600 });
      const sentinelBefore = readFileSync(outsideStateSentinel);
      const environment = isolatedEnvironment(state);
      assertIsolatedEnvironment(environment, state);
      const harness = startAppServer(executable, workspace, environment);
      const client = new CodexAppServerClient({
        transport: harness.transport,
        requestDeadlineMs: REQUEST_DEADLINE_MS,
      });
      try {
        expect(harness.child.spawnfile).toBe(executable);
        expect(harness.child.spawnargs).toEqual([executable]);
        const initialized = await client.request("initialize", {
          clientInfo: { name: "keiko", version: KEIKO_PRODUCT_VERSION },
          capabilities: {
            experimentalApi: false,
            requestAttestation: false,
            mcpServerOpenaiFormElicitation: false,
            optOutNotificationMethods: [],
          },
        });
        expect(isClosedInitializeResult(initialized, environment.CODEX_HOME)).toBe(true);
        await client.notify("initialized");
        expect(isContentFreeAccount(await client.request("account/read", {}))).toBe(true);
      } catch (error) {
        throw new Error(
          `functional-codex-app-server-failed:${error instanceof Error ? error.message : String(error)}:stderr=${harness.stderr()}`,
          { cause: error },
        );
      } finally {
        client.close();
        await harness.stop();
        expect(readFileSync(outsideStateSentinel)).toEqual(sentinelBefore);
        rmSync(root, { recursive: true, force: true });
      }
    },
    25_000,
  );
});
