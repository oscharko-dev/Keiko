// The two release-smoke lanes run the SAME @smoke journeys on two engines, back to back, in one CI
// job. Before this pin, `playwright.config.ts` derived its state identity from `GITHUB_RUN_ID`
// alone — one value for both steps — so Firefox started against Chromium's already-mutated SQLite,
// memory and evidence stores (PR #3355 review, P1).
//
// That is not theoretical. `memory-journal.smoke.spec.ts` ends with a persisted content-free Refused
// row, and the next run of the same journey opens by expecting an empty Journal: the Gecko lane
// either failed on Chromium's residue or was masked by it, and which one you got depended on step
// order. Reproduced locally at the time — shared state dir gave `firefox 1 failed` with the exact CI
// error; isolated dirs passed both.
//
// The isolation is now derived from `--project=`, which is already how the two lanes differ, so it
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
const LANES = ["test:e2e:smoke", "test:e2e:smoke:firefox"];

function scripts() {
  return JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")).scripts;
}

function projectOf(command) {
  return /--project=(\S+)/u.exec(command)?.[1];
}

// Import the real config under a chosen `--project=` and report the state directory it hands the
// product. `KEIKO_STATE_DIR` on the last web server is the value every store in the run is keyed on,
// so comparing it compares the actual isolation rather than a re-derivation of the formula.
async function stateDirFor(projectArgument) {
  vi.resetModules();
  const argv = process.argv;
  const override = process.env.KEIKO_E2E_STATE_DIR;
  process.argv = [...argv.slice(0, 2), `--project=${projectArgument}`];
  delete process.env.KEIKO_E2E_STATE_DIR;
  try {
    const { default: config } = await import(CONFIG);
    const servers = config.webServer;
    const last = Array.isArray(servers) ? servers.at(-1) : servers;
    return last?.env?.KEIKO_STATE_DIR;
  } finally {
    process.argv = argv;
    if (override !== undefined) process.env.KEIKO_E2E_STATE_DIR = override;
  }
}

describe("the two release-smoke browser lanes cannot share durable state", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("each smoke lane still pins a project, and the two differ", () => {
    const commands = LANES.map((lane) => scripts()[lane]);
    for (const [index, command] of commands.entries()) {
      expect(command, `${LANES[index]} is missing from package.json`).toBeDefined();
      expect(projectOf(command), `${LANES[index]} must pin --project=`).toBeDefined();
    }
    const projects = commands.map(projectOf);
    expect(new Set(projects).size, `both lanes run --project=${projects[0]}`).toBe(2);
  });

  it("resolves a DIFFERENT state directory for each engine", async () => {
    // Sequential on purpose: both calls mutate the shared `process.argv` around a dynamic import,
    // so running them concurrently races and each reads the other's flag — which is how this test
    // first failed against a config that isolates correctly.
    const chromium = await stateDirFor("chromium");
    const firefox = await stateDirFor("firefox");
    expect(chromium).toBeTruthy();
    expect(firefox).toBeTruthy();
    expect(firefox, "the two engines share one state directory").not.toBe(chromium);
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
});
