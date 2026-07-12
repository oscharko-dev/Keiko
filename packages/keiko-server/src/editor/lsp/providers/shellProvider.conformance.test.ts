import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LanguageServiceRequest, WorkspaceInfo } from "@oscharko-dev/keiko-contracts";

import type { LspSpawnFn } from "../lspNodeAdapter.js";
import {
  runHostLanguageOperation,
  shutdownHostLspPool,
  type HostLanguageOperationOptions,
} from "../hostLanguageOperation.js";
import { createFakeLspProcess } from "../testing/fakeLspProcess.js";
import {
  providerConformanceCapabilities,
  providerConformanceRequests,
  providerConformanceResults,
} from "../testing/providerConformanceFixture.js";
import { SHELL_PROVIDER_SPEC } from "./shellProvider.js";

const SENTINEL = "KEIKO_SHELL_ANALYSIS_MUST_NOT_EXECUTE";
let binDir = "";
let root = "";

function writeExecutable(directory: string, name: string): void {
  const path = join(directory, name);
  writeFileSync(path, "#!/bin/sh\nexit 91\n", { mode: 0o755 });
  chmodSync(path, 0o755);
}

function hostileFixture(): string {
  return [
    "#!/workspace/planted-shell",
    `trap 'printf executed > ${SENTINEL}' EXIT`,
    `value="$(printf executed > ${SENTINEL})"`,
    'legacy="`printf executed > ' + SENTINEL + '`"',
    "source ~/.profile",
    ". /etc/profile",
    "cat <<'HOSTILE_HEREDOC'",
    "x".repeat(128 * 1024),
    "HOSTILE_HEREDOC",
    "printf '%s\\n' \"$value$legacy\"",
  ].join("\n");
}

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "keiko-shell-bin-"));
  root = mkdtempSync(join(tmpdir(), "keiko-shell-workspace-"));
  for (const name of ["bash-language-server", "node", "shellcheck", "shfmt", "npm"]) {
    writeExecutable(binDir, name);
  }
  writeFileSync(join(root, "hostile.sh"), hostileFixture(), "utf8");
  writeFileSync(join(root, ".profile"), `printf executed > ${SENTINEL}\n`, "utf8");
  writeExecutable(root, "planted-shell");
  const includeDir = join(root, "scripts", "lib");
  // The configuration containment gate requires every reviewed include path to exist.
  mkdirSync(includeDir, { recursive: true });
});

afterEach(async () => {
  await shutdownHostLspPool();
  rmSync(binDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function workspace(): WorkspaceInfo {
  return {
    root,
    name: undefined,
    version: undefined,
    testFramework: "unknown" as const,
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

function protocolConfiguration(): NonNullable<
  HostLanguageOperationOptions["protocolConfiguration"]
> {
  return {
    revision: 3,
    settings: {
      bashIde: {
        backgroundAnalysisMaxFiles: 0,
        explainshellEndpoint: "",
        shellcheckExternalSources: false,
        shellcheckPath: "shellcheck",
        shfmt: { path: "" },
      },
    },
    initializationOptions: {},
  };
}

function options(
  spawn: LspSpawnFn,
  signal = new AbortController().signal,
): HostLanguageOperationOptions {
  return {
    workspace: workspace(),
    processEnv: {
      PATH: `${binDir}${delimiter}${root}`,
      HOME: root,
      ENV: join(root, ".profile"),
      BASH_ENV: join(root, ".profile"),
      KEIKO_SENTINEL: SENTINEL,
    },
    commandRules: [
      { executable: "bash-language-server" },
      { executable: "node" },
      { executable: "shellcheck" },
    ],
    overlayAbsolutePath: join(root, "hostile.sh"),
    signal,
    spawn,
    activationAuthorized: true,
    protocolConfiguration: protocolConfiguration(),
  };
}

function shellRequests(): readonly LanguageServiceRequest[] {
  return providerConformanceRequests({
    root,
    path: "hostile.sh",
    languageId: "shell",
    text: readFileSync(join(root, "hostile.sh"), "utf8"),
    includeFormatting: false,
  }).filter((request) => SHELL_PROVIDER_SPEC.operations.includes(request.operation));
}

function firstShellRequest(): LanguageServiceRequest {
  const request = shellRequests()[0];
  if (request === undefined) throw new Error("shell conformance fixture is empty");
  return request;
}

describe("Bash Language Server fake-protocol security conformance", () => {
  it("serves only negotiated read-only operations without executing hostile workspace content", async () => {
    const original = readFileSync(join(root, "hostile.sh"), "utf8");
    const controller = createFakeLspProcess({
      initializeResult: providerConformanceCapabilities(false),
      results: providerConformanceResults(join(root, "hostile.sh"), false),
    });
    let childEnvironment: Readonly<Record<string, string>> | undefined;
    const spawn: LspSpawnFn = (_executable, _args, env) => {
      childEnvironment = env;
      return controller.handle;
    };

    for (const request of shellRequests()) {
      const outcome = await runHostLanguageOperation(request, options(spawn));
      expect(outcome, request.operation).toMatchObject({ kind: request.operation });
    }

    expect(childEnvironment).toBeDefined();
    const childPath = childEnvironment?.PATH ?? "";
    expect(readdirSync(childPath).sort()).toEqual(["node", "shellcheck"]);
    expect(realpathSync(join(childPath, "node"))).toBe(realpathSync(join(binDir, "node")));
    expect(realpathSync(join(childPath, "shellcheck"))).toBe(
      realpathSync(join(binDir, "shellcheck")),
    );
    expect(childEnvironment).not.toHaveProperty("HOME");
    expect(childEnvironment).not.toHaveProperty("BASH_ENV");
    expect(childEnvironment).not.toHaveProperty("ENV");
    expect(childEnvironment).not.toHaveProperty("KEIKO_SENTINEL");
    expect(readFileSync(join(root, "hostile.sh"), "utf8")).toBe(original);
    expect(existsSync(join(root, SENTINEL))).toBe(false);
  });

  it("fails closed when ShellCheck is shadowed by a planted workspace executable", async () => {
    writeExecutable(root, "shellcheck");
    let spawnCount = 0;
    const spawn: LspSpawnFn = () => {
      spawnCount += 1;
      return createFakeLspProcess().handle;
    };
    const request = firstShellRequest();

    const outcome = await runHostLanguageOperation(request, {
      ...options(spawn),
      processEnv: { PATH: `${root}${delimiter}${binDir}` },
    });

    expect(outcome).toBeUndefined();
    expect(spawnCount).toBe(0);
    expect(existsSync(join(root, SENTINEL))).toBe(false);
  });

  it("fails closed when the primary bash-language-server executable is shadowed by a planted workspace executable", async () => {
    writeExecutable(root, "bash-language-server");
    let spawnCount = 0;
    const spawn: LspSpawnFn = () => {
      spawnCount += 1;
      return createFakeLspProcess().handle;
    };
    const request = firstShellRequest();

    const outcome = await runHostLanguageOperation(request, {
      ...options(spawn),
      processEnv: { PATH: `${root}${delimiter}${binDir}` },
    });

    expect(outcome).toBeUndefined();
    expect(spawnCount).toBe(0);
    expect(existsSync(join(root, SENTINEL))).toBe(false);
  });

  it("cancels promptly without exposing content in the outcome", async () => {
    const controller = new AbortController();
    controller.abort();
    const request = firstShellRequest();

    const outcome = await runHostLanguageOperation(
      request,
      options(() => createFakeLspProcess().handle, controller.signal),
    );

    expect(outcome).toEqual({
      kind: "error",
      code: "CANCELLED",
      message: "The request was cancelled.",
    });
    expect(JSON.stringify(outcome)).not.toContain(SENTINEL);
  });

  it("bounds a diagnostics storm from a large document", async () => {
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
    const diagnostics = Array.from({ length: 700 }, (_, index) => ({
      range,
      severity: 2,
      code: `SC${String(1000 + (index % 9000))}`,
      source: "shellcheck",
      message: `bounded diagnostic ${String(index)}`,
    }));
    const fake = createFakeLspProcess({
      initializeResult: providerConformanceCapabilities(false),
      results: { "textDocument/diagnostic": { kind: "full", items: diagnostics } },
    });
    const request = firstShellRequest();
    const outcome = await runHostLanguageOperation(
      request,
      options(() => fake.handle),
    );

    if (outcome?.kind !== "diagnostics") throw new Error("expected diagnostics outcome");
    expect(outcome.result.diagnostics).toHaveLength(512);
    expect(outcome.result.truncated).toBe(true);
  });

  it("recovers through a fresh isolated process after a crash", async () => {
    const controllers = [createFakeLspProcess(), createFakeLspProcess()];
    const paths: string[] = [];
    let spawnCount = 0;
    const spawn: LspSpawnFn = (_executable, _args, env) => {
      paths.push(env.PATH ?? "");
      const controller = controllers[spawnCount];
      spawnCount += 1;
      if (controller === undefined) throw new Error("unexpected extra shell provider restart");
      return controller.handle;
    };
    const request = shellRequests().find((candidate) => candidate.operation === "hover");
    if (request === undefined) throw new Error("hover fixture is missing");
    await runHostLanguageOperation(request, options(spawn));
    const firstPath = paths[0] ?? "";

    controllers[0]?.crash();
    const outcome = await runHostLanguageOperation(request, options(spawn));

    expect(outcome).toMatchObject({ kind: "hover" });
    expect(spawnCount).toBe(2);
    expect(existsSync(firstPath)).toBe(false);
    expect(paths[1]).not.toBe(firstPath);
  });
});
