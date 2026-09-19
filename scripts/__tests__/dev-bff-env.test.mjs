// The dev BFF's effective environment and state directory (#3557 review findings 1 and 2): this
// merge/default logic is now a small importable module precisely so it can be pinned directly,
// instead of only indirectly through the slow real-process spawn test
// (`scripts/__tests__/dev-bff-activity-log.test.mjs`).
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyProcessWideEvidenceEnv,
  buildDevBffEnv,
  resolveDevBffStateDir,
} from "../lib/dev-bff-env.mjs";

// NEVER touch the real repository `.env`/`.keiko` — every fixture below is its own temp "repo".
const dirs = [];

function tempRepoRoot() {
  // The macOS tmpdir() sits behind /var -> /private/var; the UI store refuses a symlinked path
  // elsewhere in this stack, so realpathSync here keeps every derived path consistent.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "keiko-dev-bff-env-")));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveDevBffStateDir", () => {
  it("defaults to <repoRoot>/.keiko/dev when KEIKO_STATE_DIR is unset", () => {
    const repoRoot = tempRepoRoot();
    const stateDir = resolveDevBffStateDir({ repoRoot, processEnv: {} });
    expect(stateDir).toBe(join(repoRoot, ".keiko", "dev"));
  });

  it("respects an externally set KEIKO_STATE_DIR instead of the dev default", () => {
    const repoRoot = tempRepoRoot();
    const explicit = join(repoRoot, "elsewhere");
    const stateDir = resolveDevBffStateDir({ repoRoot, processEnv: { KEIKO_STATE_DIR: explicit } });
    expect(stateDir).toBe(explicit);
  });
});

describe("buildDevBffEnv", () => {
  it("pins KEIKO_STATE_DIR to the resolved stateDir, never the generic CLI default", () => {
    const repoRoot = tempRepoRoot();
    const stateDir = resolveDevBffStateDir({ repoRoot, processEnv: {} });
    const env = buildDevBffEnv({ repoRoot, processEnv: {}, stateDir });
    expect(env.KEIKO_STATE_DIR).toBe(stateDir);
    // The generic CLI default (`resolveRuntimeStateDir`'s own fallback) is `<cwd>/.keiko` — a
    // DIFFERENT directory than the dev BFF's own `<repoRoot>/.keiko/dev` default. Pinning
    // `KEIKO_STATE_DIR` explicitly is what keeps every consumer of this `env` (including
    // `resolveRuntimeStateDir`, given this `env`) off that generic default.
    expect(env.KEIKO_STATE_DIR).not.toBe(join(repoRoot, ".keiko"));
  });

  it("derives KEIKO_UI_DATA_DIR and KEIKO_MEMORY_DIR from stateDir when unset", () => {
    const repoRoot = tempRepoRoot();
    const stateDir = join(repoRoot, ".keiko", "dev");
    const env = buildDevBffEnv({ repoRoot, processEnv: {}, stateDir });
    expect(env.KEIKO_UI_DATA_DIR).toBe(join(stateDir, "ui"));
    expect(env.KEIKO_MEMORY_DIR).toBe(join(stateDir, "memory"));
  });

  it("keeps an already-set KEIKO_UI_DATA_DIR/KEIKO_MEMORY_DIR instead of overriding it", () => {
    const repoRoot = tempRepoRoot();
    const stateDir = join(repoRoot, ".keiko", "dev");
    const env = buildDevBffEnv({
      repoRoot,
      processEnv: { KEIKO_UI_DATA_DIR: "/custom/ui", KEIKO_MEMORY_DIR: "/custom/memory" },
      stateDir,
    });
    expect(env.KEIKO_UI_DATA_DIR).toBe("/custom/ui");
    expect(env.KEIKO_MEMORY_DIR).toBe("/custom/memory");
  });

  // This is the exact scenario review finding 2 names: a repo-local `.env` sets KEIKO_LOG_LEVEL,
  // and nothing else (in particular, not `processEnv` / `process.env` itself) carries it.
  it("folds a repo-local .env's KEIKO_LOG_LEVEL into the effective env when processEnv lacks it", () => {
    const repoRoot = tempRepoRoot();
    writeFileSync(join(repoRoot, ".env"), "KEIKO_LOG_LEVEL=silent\n");
    const stateDir = join(repoRoot, ".keiko", "dev");
    const processEnv = {}; // Deliberately empty: KEIKO_LOG_LEVEL is NOT set here.
    const env = buildDevBffEnv({ repoRoot, processEnv, stateDir });
    expect(env.KEIKO_LOG_LEVEL).toBe("silent");
    expect(processEnv.KEIKO_LOG_LEVEL).toBeUndefined();
  });

  it("lets an already-set processEnv key win over the same key in .env", () => {
    const repoRoot = tempRepoRoot();
    writeFileSync(join(repoRoot, ".env"), "KEIKO_LOG_LEVEL=silent\n");
    const stateDir = join(repoRoot, ".keiko", "dev");
    const env = buildDevBffEnv({ repoRoot, processEnv: { KEIKO_LOG_LEVEL: "debug" }, stateDir });
    expect(env.KEIKO_LOG_LEVEL).toBe("debug");
  });

  it("ignores a non-KEIKO, non-allowlisted .env key", () => {
    const repoRoot = tempRepoRoot();
    writeFileSync(join(repoRoot, ".env"), "SOME_OTHER_TOOL_TOKEN=leaked\n");
    const stateDir = join(repoRoot, ".keiko", "dev");
    const env = buildDevBffEnv({ repoRoot, processEnv: {}, stateDir });
    expect(env.SOME_OTHER_TOOL_TOKEN).toBeUndefined();
  });

  it("folds in the allowlisted FIGMA_ACCESS_TOKEN despite the non-KEIKO_ prefix", () => {
    const repoRoot = tempRepoRoot();
    writeFileSync(join(repoRoot, ".env"), "FIGMA_ACCESS_TOKEN=figd_test\n");
    const stateDir = join(repoRoot, ".keiko", "dev");
    const env = buildDevBffEnv({ repoRoot, processEnv: {}, stateDir });
    expect(env.FIGMA_ACCESS_TOKEN).toBe("figd_test");
  });

  it("returns the same env unchanged when no .env file exists", () => {
    const repoRoot = tempRepoRoot();
    const stateDir = join(repoRoot, ".keiko", "dev");
    const env = buildDevBffEnv({ repoRoot, processEnv: { FOO: "bar" }, stateDir });
    expect(env.FOO).toBe("bar");
    expect(env.KEIKO_STATE_DIR).toBe(stateDir);
  });
});

// The process-wide Activity Log writer resolves its directory and level from process.env. Without
// the effective evidence keys there, a dev BFF launched without an external KEIKO_STATE_DIR wrote
// through two different directories, and a `.env`-only KEIKO_LOG_LEVEL reached readiness but
// not the writer (#3557).
describe("applyProcessWideEvidenceEnv", () => {
  it("copies the state directory and every log setting, and nothing else", () => {
    const target = { PATH: "/usr/bin", KEIKO_STATE_DIR: "/elsewhere" };

    applyProcessWideEvidenceEnv(
      {
        KEIKO_STATE_DIR: "/repo/.keiko/dev",
        KEIKO_LOG_LEVEL: "silent",
        KEIKO_LOG_RETENTION_DAYS: "3",
        KEIKO_OPENAI_API_KEY: "sk-test",
        KEIKO_LOG_TOKEN: "log-token-test",
        KEIKO_LOG_API_KEY: "log-key-test",
        FIGMA_ACCESS_TOKEN: "figd-test",
        KEIKO_UI_DATA_DIR: "/repo/.keiko/dev/ui",
        KEIKO_LOG_SEGMENT_BYTES: undefined,
      },
      target,
    );

    expect(target).toEqual({
      PATH: "/usr/bin",
      KEIKO_STATE_DIR: "/repo/.keiko/dev",
      KEIKO_LOG_LEVEL: "silent",
      KEIKO_LOG_RETENTION_DAYS: "3",
    });
  });
});
