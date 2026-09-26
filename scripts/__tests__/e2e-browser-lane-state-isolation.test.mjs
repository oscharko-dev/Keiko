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
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONFIG = "../../tests/e2e/config/playwright.config.ts";
const LANES = ["test:e2e:smoke", "test:e2e:smoke:firefox", "test:e2e:smoke:webkit"];

function scripts() {
  return JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")).scripts;
}

function projectOf(command) {
  return /--project=(\S+)/u.exec(command)?.[1];
}

function configStateDir(config) {
  const servers = config.webServer;
  const last = Array.isArray(servers) ? servers.at(-1) : servers;
  return last?.env?.KEIKO_STATE_DIR;
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
async function stateDirFor(projectArgument, form = "equals") {
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
    return configStateDir(config);
  } finally {
    process.argv = argv;
    restoreEnvironment("KEIKO_E2E_STATE_DIR", override);
    restoreEnvironment("KEIKO_E2E_VALIDATED_PROJECT", validatedProject);
    restoreEnvironment("KEIKO_E2E_VALIDATED_STATE_ID", validatedStateId);
  }
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
