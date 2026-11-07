// The release-smoke lanes run the SAME @smoke journeys on three engines, back to back, in one CI
// job. Before this pin, `playwright.config.ts` derived its state identity from `GITHUB_RUN_ID`
// alone — one value for every step — so later engines started against Chromium's already-mutated
// SQLite, memory and evidence stores (PR #3355 review, P1).
//
// That is not theoretical. `memory-journal.smoke.spec.ts` ends with a persisted content-free Refused
// row, and the next run of the same journey opens by expecting an empty Journal: the Gecko lane
// either failed on Chromium's residue or was masked by it, and which one you got depended on step
// order. Reproduced locally at the time — shared state dir gave `firefox 1 failed` with the exact CI
// error; isolated dirs passed both.
//
// The isolation is now derived from `--project=`, which is already how the lanes differ, so it
// cannot be forgotten the way a separate env var can. This file pins that derivation end to end:
// the scripts still pass distinct projects, and the config still turns them into distinct state
// directories. Either half alone is insufficient — the flags could diverge while the config ignores
// them, or the config could split while a lane stops passing a project.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDevBffEnv, resolveDevBffStateDir } from "../lib/dev-bff-env.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONFIG = "../../tests/e2e/config/playwright.config.ts";
const LANES = ["test:e2e:smoke", "test:e2e:smoke:firefox", "test:e2e:smoke:webkit"];

function scripts() {
  return JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")).scripts;
}

function projectOf(command) {
  return /--project=(\S+)/u.exec(command)?.[1];
}

function configServerEnv(config) {
  const servers = config.webServer;
  const last = Array.isArray(servers) ? servers.at(-1) : servers;
  return last?.env;
}

function configStateDir(config) {
  return configServerEnv(config)?.KEIKO_STATE_DIR;
}

// The durable stores the BFF opens besides its state directory. Each falls back to a location
// outside the run when nothing places it; the evidence store's fallback is `./.keiko/evidence` in
// the checkout, so a dev-runner BFF without `KEIKO_EVIDENCE_DIR` shared its memory audit, and with it
// the Journal's content-free Refused rows, with every engine and suite (#4212).
const DURABLE_STORE_VARIABLES = ["KEIKO_UI_DATA_DIR", "KEIKO_MEMORY_DIR", "KEIKO_EVIDENCE_DIR"];

// The effective environment of the dev BFF a config's web server starts, derived by the BFF's own
// builder. The repository root is an empty directory, so a developer's `.env` cannot decide it.
function bffEnvironmentOf(env) {
  const repoRoot = mkdtempSync(join(tmpdir(), "keiko-lane-isolation-"));
  try {
    const stateDir = resolveDevBffStateDir({ repoRoot, processEnv: env });
    return buildDevBffEnv({ repoRoot, processEnv: env, stateDir });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

// Every e2e web server that runs the product places its evidence store inside its state:
// - `keiko ui` (`dist/cli/index.js ui`) and the dev BFF the dev runner starts derive it from the
//   state directory when none is configured;
// - the built `tests/e2e/servers/*-server` entries reach the shared coding-runtime server, which
//   passes `buildUiHandlerDeps` an explicit evidence directory under its state root, or pass
//   `keiko ui` an `--evidence-dir` inside their state;
// - a support or fixture server passes one of its own or starts the dev runner.
const SHARED_SERVER = "coding-runtime-server-shared";
const SHARED_SERVER_EVIDENCE = 'evidenceDir: join(bffStateRoot, "evidence")';
const CLI_SOURCE = "packages/keiko-cli/src/ui.ts";
const CLI_EVIDENCE_DEFAULT = 'next.KEIKO_EVIDENCE_DIR = join(stateDir, "evidence");';
const CLI_ENTRY = "node dist/cli/index.js ui";
const DEV_RUNNER_ENTRY = "scripts/dev-runner.mjs";
// A built entry is named on its own ("x-server.mjs") or at the end of its dist path.
const BUILT_SERVER_ENTRY = /\b([a-z0-9-]+-server)\.mjs"/gu;
const CLI_EVIDENCE_ARGUMENT = /"--evidence-dir",\s*resolve\(stateDir, "evidence"\)/u;
const SUPPORT_SERVER_ENTRY =
  /node (tests\/e2e\/(?:support|fixtures)\/[a-z0-9-]+(?:-server)?\.m?js)/u;
const BASE_CONFIG_IMPORT = 'from "./playwright.config.js"';

// Comments that start a line only: a `/*` inside a glob string such as "**/*.spec.ts" is no
// comment.
function withoutComments(source) {
  return source.replaceAll(/^\s*\/\*[\s\S]*?\*\//gmu, "").replaceAll(/^\s*\/\/.*$/gmu, "");
}

function sourceOf(path) {
  return withoutComments(readFileSync(resolve(repoRoot, path), "utf8"));
}

function importsServer(source, name) {
  return source.includes(`from "./${name}.mjs"`);
}

// Direct import of the shared server, through the delivery server that imports it, or its own
// `keiko ui` launch with an evidence directory inside its state.
function ownsEvidenceInState(name) {
  const source = sourceOf(`tests/e2e/servers/${name}.mts`);
  if (importsServer(source, SHARED_SERVER) || CLI_EVIDENCE_ARGUMENT.test(source)) return true;
  const delivery = "coding-issue-delivery-server";
  return name !== delivery && importsServer(source, delivery) && ownsEvidenceInState(delivery);
}

function supportServerOwnsEvidence(path) {
  const source = sourceOf(path);
  return /evidenceDir: join\(/u.test(source) || source.includes(`"${DEV_RUNNER_ENTRY}"`);
}

// A config's own web-server command that places the evidence store, in the order they are tried.
const COMMAND_EVIDENCE_OWNERS = [
  ["environment", (source) => source.includes("KEIKO_EVIDENCE_DIR:")],
  ["base-config", (source) => source.includes(BASE_CONFIG_IMPORT)],
  ["cli", (source) => source.includes(CLI_ENTRY)],
  ["dev-runner", (source) => source.includes(`node ${DEV_RUNNER_ENTRY}`)],
];

// The built product servers a config names; a model mock or other helper is no product server.
function builtServersOf(source) {
  return [...source.matchAll(BUILT_SERVER_ENTRY)]
    .map((match) => match[1])
    .filter((name) => existsSync(resolve(repoRoot, "tests/e2e/servers", `${name}.mts`)));
}

function serverEvidenceOwner(source) {
  const built = builtServersOf(source);
  if (built.length > 0) {
    return built.every((name) => ownsEvidenceInState(name)) ? "built-server" : "missing";
  }
  const support = SUPPORT_SERVER_ENTRY.exec(source)?.[1];
  return support !== undefined && supportServerOwnsEvidence(support) ? "support-server" : "missing";
}

// Where the evidence store of a config's product server lives, or `missing`.
function evidenceOwner(file) {
  const source = sourceOf(file);
  if (!source.includes("webServer")) return "no-server";
  const owner = COMMAND_EVIDENCE_OWNERS.find(([, places]) => places(source));
  return owner === undefined ? serverEvidenceOwner(source) : owner[0];
}

function e2eConfigFiles() {
  const configDir = resolve(repoRoot, "tests/e2e/config");
  const e2eDir = resolve(repoRoot, "tests/e2e");
  return [
    ...readdirSync(configDir)
      .filter((name) => name.endsWith(".config.ts"))
      .map((name) => join(configDir, name)),
    ...readdirSync(e2eDir)
      .filter((name) => name.endsWith(".config.ts"))
      .map((name) => join(e2eDir, name)),
  ];
}

function restoreEnvironment(name, value) {
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
}

// Import the real config under a chosen `--project=` and report the state directory it hands the
// product. `KEIKO_STATE_DIR` on the last web server is the value every store in the run is keyed on,
// so comparing it compares the actual isolation rather than a re-derivation of the formula.
//
// `form` selects which of Playwright's two equivalent CLI spellings to simulate: the `equals` form
// (`--project=firefox`, one argv element) that every script in this repo uses today, and the `space`
// form (`--project firefox`, two argv elements) that a developer invoking `playwright test` by hand
// is just as entitled to use. Both must resolve to the same isolated state directory.
async function serverEnvFor(projectArgument, form = "equals") {
  vi.resetModules();
  const argv = process.argv;
  const override = process.env.KEIKO_E2E_STATE_DIR;
  const validatedProject = process.env.KEIKO_E2E_VALIDATED_PROJECT;
  const validatedStateId = process.env.KEIKO_E2E_VALIDATED_STATE_ID;
  process.argv =
    form === "space"
      ? [...argv.slice(0, 2), "--project", projectArgument]
      : [...argv.slice(0, 2), `--project=${projectArgument}`];
  delete process.env.KEIKO_E2E_STATE_DIR;
  try {
    const { default: config } = await import(CONFIG);
    return configServerEnv(config);
  } finally {
    process.argv = argv;
    restoreEnvironment("KEIKO_E2E_STATE_DIR", override);
    restoreEnvironment("KEIKO_E2E_VALIDATED_PROJECT", validatedProject);
    restoreEnvironment("KEIKO_E2E_VALIDATED_STATE_ID", validatedStateId);
  }
}

async function stateDirFor(projectArgument, form = "equals") {
  return (await serverEnvFor(projectArgument, form))?.KEIKO_STATE_DIR;
}

async function parentAndWorkerStateDirs(project) {
  vi.resetModules();
  const argv = process.argv;
  const workerIndex = process.env.TEST_WORKER_INDEX;
  const validatedProject = process.env.KEIKO_E2E_VALIDATED_PROJECT;
  const validatedStateId = process.env.KEIKO_E2E_VALIDATED_STATE_ID;
  delete process.env.TEST_WORKER_INDEX;
  delete process.env.KEIKO_E2E_VALIDATED_PROJECT;
  delete process.env.KEIKO_E2E_VALIDATED_STATE_ID;
  try {
    process.argv = [...argv.slice(0, 2), `--project=${project}`];
    const { default: parentConfig } = await import(CONFIG);
    process.argv = argv.slice(0, 2);
    process.env.TEST_WORKER_INDEX = "0";
    vi.resetModules();
    const { default: workerConfig } = await import(CONFIG);
    return [configStateDir(parentConfig), configStateDir(workerConfig)];
  } finally {
    process.argv = argv;
    restoreEnvironment("TEST_WORKER_INDEX", workerIndex);
    restoreEnvironment("KEIKO_E2E_VALIDATED_PROJECT", validatedProject);
    restoreEnvironment("KEIKO_E2E_VALIDATED_STATE_ID", validatedStateId);
  }
}

async function configImportWith(projectArguments) {
  vi.resetModules();
  const argv = process.argv;
  process.argv = [...argv.slice(0, 2), ...projectArguments];
  try {
    return await import(CONFIG);
  } finally {
    process.argv = argv;
  }
}

describe("the release-smoke browser lanes cannot share durable state", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("each smoke lane pins a distinct project", () => {
    const commands = LANES.map((lane) => scripts()[lane]);
    for (const [index, command] of commands.entries()) {
      expect(command, `${LANES[index]} is missing from package.json`).toBeDefined();
      expect(projectOf(command), `${LANES[index]} must pin --project=`).toBeDefined();
    }
    const projects = commands.map(projectOf);
    expect(new Set(projects).size, "two smoke lanes select the same project").toBe(LANES.length);
  });

  it("resolves a DIFFERENT state directory for each engine", async () => {
    // Sequential on purpose: both calls mutate the shared `process.argv` around a dynamic import,
    // so running them concurrently races and each reads the other's flag — which is how this test
    // first failed against a config that isolates correctly.
    const chromium = await stateDirFor("chromium");
    const firefox = await stateDirFor("firefox");
    const webkit = await stateDirFor("webkit");
    const stateDirs = [chromium, firefox, webkit];
    expect(stateDirs.every(Boolean)).toBe(true);
    expect(new Set(stateDirs).size, "two engines share one state directory").toBe(stateDirs.length);
  });

  // Guards the half a shared-prefix check would miss: the engine must be in the identity, not merely
  // some difference. Without it a future refactor could split on a random id per import and pass
  // this file while two runs of the SAME lane stopped sharing state, which is a different bug.
  it("keys the directory on the engine, so the same lane is stable across imports", async () => {
    const first = await stateDirFor("firefox");
    const second = await stateDirFor("firefox");
    expect(second).toBe(first);
    expect(first).toContain("firefox");
  });

  it("reuses the validated parent state directory when Playwright reloads config in a worker", async () => {
    const [parent, worker] = await parentAndWorkerStateDirs("firefox");
    expect(parent).toBeTruthy();
    expect(worker).toBe(parent);
  });

  // Playwright's own CLI accepts `--project <name>` (two argv elements) as well as
  // `--project=<name>` (one). Before this pin the config only recognized the `=` form, so a
  // developer running the space form got a stateId with no project suffix — silently un-isolated
  // (PR #3355 review, IDX57).
  it("resolves the SAME state directory for the space-separated --project form as for --project=", async () => {
    const equalsForm = await stateDirFor("firefox", "equals");
    const spaceForm = await stateDirFor("firefox", "space");
    expect(spaceForm).toBeTruthy();
    expect(spaceForm).toContain("firefox");
    expect(spaceForm).toBe(equalsForm);
  });

  it.each([
    ["an absent selector", []],
    ["repeated selectors", ["--project=chromium", "--project=firefox"]],
    ["multiple space-separated values", ["--project", "chromium", "firefox"]],
  ])("fails closed for %s instead of sharing one server state", async (_label, projectArgs) => {
    await expect(configImportWith(projectArgs)).rejects.toThrow(
      "requires exactly one concrete --project",
    );
  });
});

describe("every e2e BFF keeps its durable stores inside its own state", () => {
  it("places each store of an engine under that engine's state directory", async () => {
    // Sequential for the same reason as the state-directory test: each import rewrites `process.argv`.
    const chromium = await serverEnvFor("chromium");
    const firefox = await serverEnvFor("firefox");
    const webkit = await serverEnvFor("webkit");
    const environments = [chromium, firefox, webkit].map((env) => bffEnvironmentOf(env ?? {}));
    for (const variable of DURABLE_STORE_VARIABLES) {
      const directories = environments.map((env) => env?.[variable]);
      expect(
        directories.every((directory) => Boolean(directory)),
        `${variable} is not set for every engine`,
      ).toBe(true);
      expect(new Set(directories).size, `two engines share ${variable}`).toBe(directories.length);
      for (const [index, directory] of directories.entries()) {
        const fromState = relative(environments[index].KEIKO_STATE_DIR, directory);
        expect(fromState.startsWith(".."), `${variable} lies outside the state directory`).toBe(
          false,
        );
      }
    }
  });

  it("gives every e2e config an evidence store inside its own state", () => {
    const owners = e2eConfigFiles().map((file) => [relative(repoRoot, file), evidenceOwner(file)]);
    expect(owners.length).toBeGreaterThan(50);
    const missing = owners.filter(([, owner]) => owner === "missing").map(([file]) => file);
    expect(missing).toEqual([]);
    const kinds = new Set(owners.map(([, owner]) => owner));
    for (const kind of ["cli", "dev-runner", "base-config", "built-server", "support-server"]) {
      expect(kinds.has(kind), `no config exercises the ${kind} rule`).toBe(true);
    }
  });

  it("keeps the explicit evidence directories of the CLI and the coding-runtime server", () => {
    expect(sourceOf(CLI_SOURCE)).toContain(CLI_EVIDENCE_DEFAULT);
    expect(sourceOf(`tests/e2e/servers/${SHARED_SERVER}.mts`)).toContain(SHARED_SERVER_EVIDENCE);
  });
});
