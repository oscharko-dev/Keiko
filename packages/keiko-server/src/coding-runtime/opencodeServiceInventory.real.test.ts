import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { buildOpenCodeLaunchProfile } from "./opencodeLaunchProfile.js";
import {
  OPEN_CODE_V2_PINNED_PROTOCOL_SURFACE_SHA256,
  projectOpenCodeV2ProtocolSurface,
} from "./opencodeProtocolSurface.js";
import { OPENCODE_PINNED_VERSION } from "./opencodeRuntimeVersions.js";
import {
  extractOpenCodeServiceOperations,
  parseOpenCodeCliSubcommands,
  parseOpenCodeServiceInventory,
} from "./opencodeServiceInventory.js";
import {
  createOpenCodeV2HttpClient,
  parseOpenCodeV2ChildEndpoint,
} from "./opencodeV2HttpClient.js";

/**
 * Drift detection for the complete service inventory (#3908 AC4, #3899 AC3). The pinned executable
 * serves its OpenAPI document and its `--help` tree; both must equal the committed producer-derived
 * fixture, so a producer that adds, removes or moves an operation or a command fails here before
 * anyone admits it. Run with KEIKO_OPENCODE_REAL_BINARY and KEIKO_OPENCODE_REAL_RESOURCE_ROOT set;
 * otherwise it is skipped. After an upgrade, KEIKO_WRITE_OPENCODE_SERVICE_INVENTORY_FIXTURE=1
 * rewrites the fixture of the running version (format it with prettier); the unit test then names
 * every added operation or command that still needs a disposition.
 */
const BINARY = process.env.KEIKO_OPENCODE_REAL_BINARY;
const RESOURCE_ROOT = process.env.KEIKO_OPENCODE_REAL_RESOURCE_ROOT;
const WRITE_FIXTURE = process.env.KEIKO_WRITE_OPENCODE_SERVICE_INVENTORY_FIXTURE === "1";
const STARTUP_TIMEOUT_MS = 20_000;
const HELP_TIMEOUT_MS = 60_000;

type Child = ChildProcessByStdio<null, Readable, Readable>;

function fixtureUrl(version: string): URL {
  return new URL(`./opencodeServiceInventory.opencode-${version}.fixture.json`, import.meta.url);
}

/** A private HOME and XDG roots, so neither the service nor `--help` writes under the real home. */
function isolatedEnvironment(root: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    NO_COLOR: "1",
    COLUMNS: "200",
  };
}

function prepareIsolatedRoot(root: string): void {
  for (const name of ["home", "config", "data", "state", "cache"])
    mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
}

/** The leaf command paths of the `--help` tree (`auth login`), depth first, ordered. */
function walkCli(binary: string, root: string, prefix: readonly string[] = []): string[] {
  const help = spawnSync(binary, [...prefix, "--help"], {
    cwd: root,
    encoding: "utf8",
    timeout: HELP_TIMEOUT_MS,
    env: isolatedEnvironment(root),
  });
  if (help.status !== 0) throw new Error(`fixture-help-failed:${prefix.join(" ")}`);
  const subcommands = parseOpenCodeCliSubcommands(help.stdout);
  if (subcommands.length === 0) return prefix.length === 0 ? [] : [prefix.join(" ")];
  return subcommands.flatMap((name) => walkCli(binary, root, [...prefix, name]));
}

function launchService(binary: string, root: string): { child: Child; password: string } {
  const state = join(root, "service-state");
  const workspace = join(root, "workspace");
  const profile = buildOpenCodeLaunchProfile({
    executable: binary,
    stateRoot: state,
    contextGeometry: {
      contextWindowTokens: 32_768,
      maxInputTokens: 24_000,
      maxOutputTokens: 4_096,
    },
  });
  if (!profile.ok) throw new Error("fixture-profile-invalid");
  for (const path of [join(state, "config", "opencode"), join(state, "home"), join(state, "state")])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  mkdirSync(join(state, "tmp"), { recursive: true, mode: 0o700 });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(state, "config", "opencode", "opencode.json"), profile.config, {
    mode: 0o600,
  });
  const password = profile.env.OPENCODE_SERVER_PASSWORD;
  if (password === undefined) throw new Error("fixture-password-missing");
  // No model call is made: the gateway binding only has to resolve, so it points at a closed port.
  const child = spawn(binary, [...profile.args], {
    cwd: workspace,
    env: {
      ...profile.env,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      KEIKO_MODEL_GATEWAY_URL: "http://127.0.0.1:9/v1",
      KEIKO_MODEL_GATEWAY_CAPABILITY: "fixture-only",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { child, password };
}

async function childEndpoint(child: Child): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("fixture-startup-timeout"));
    }, STARTUP_TIMEOUT_MS);
    const onData = (bytes: Buffer): void => {
      for (const line of bytes.toString("utf8").split("\n")) {
        const endpoint = parseOpenCodeV2ChildEndpoint(`${line}\n`);
        if (endpoint === undefined) continue;
        clearTimeout(timeout);
        resolve(endpoint);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("fixture-startup-failed"));
    });
    child.once("exit", () => {
      clearTimeout(timeout);
      reject(new Error("fixture-child-exited"));
    });
  });
}

async function stopChild(child: Child): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => {
      resolve();
    });
    child.kill("SIGKILL");
  });
}

describe("pinned OpenCode complete service inventory", () => {
  it.skipIf(BINARY === undefined || RESOURCE_ROOT === undefined)(
    "serves exactly the operations and commands of the committed producer-derived inventory",
    async () => {
      if (BINARY === undefined || RESOURCE_ROOT === undefined)
        throw new Error("fixture-binary-missing");
      const binary = realpathSync(BINARY);
      expect(binary.startsWith(realpathSync(RESOURCE_ROOT))).toBe(true);
      const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-service-inventory-")));
      prepareIsolatedRoot(root);
      const launched = launchService(binary, root);
      try {
        const client = createOpenCodeV2HttpClient({
          endpoint: await childEndpoint(launched.child),
          password: launched.password,
        });
        const version = (await client.info()).version;
        expect(version).toBe(OPENCODE_PINNED_VERSION);
        const document = await client.document();
        const live = {
          version: OPENCODE_PINNED_VERSION,
          operations: extractOpenCodeServiceOperations(document),
          cliCommands: walkCli(binary, root).sort(),
        };
        if (WRITE_FIXTURE)
          writeFileSync(fixtureUrl(live.version), `${JSON.stringify(live, null, 2)}\n`);
        const committed = parseOpenCodeServiceInventory(
          readFileSync(fixtureUrl(live.version), "utf8"),
        );
        expect(live.operations).toEqual(committed.operations);
        expect(live.cliCommands).toEqual(committed.cliCommands);
        // The admitted subset of the same live document still projects to the pinned digest.
        expect(projectOpenCodeV2ProtocolSurface(document).digest).toBe(
          OPEN_CODE_V2_PINNED_PROTOCOL_SURFACE_SHA256,
        );
      } finally {
        await stopChild(launched.child);
        rmSync(root, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
