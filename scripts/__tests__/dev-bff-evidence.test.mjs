// #3557 review finding 2: the dev BFF's 60-second heartbeat previously called
// `refreshActivityLogReadiness({ stateDir })` without `env`, so it silently fell back to bare
// `process.env` — which never carries a repo-local `.env`'s KEIKO_LOG_LEVEL (that key only reaches
// the process through the dev BFF's own merged `env`, built by `buildDevBffEnv` in
// `dev-bff-env.mjs`). A heartbeat refresh under that bug recorded a false `ready` transition even
// though the log was actually silenced, so `/api/health` told support the evidence stream was
// complete when it was not. This exercises the REAL `checkActivityLogReadiness` /
// `refreshActivityLogReadiness` from the built keiko-server dist (the same module dev-bff.mjs
// itself imports), never a fake, so the proof is about the dev BFF's own call site, not a
// reimplementation of it.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkActivityLogReadiness } from "../../packages/keiko-server/dist/index.js";
import { refreshDevBffEvidence } from "../lib/dev-bff-evidence.mjs";

describe("refreshDevBffEvidence", () => {
  let stateDir;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (stateDir !== undefined) {
      rmSync(stateDir, { recursive: true, force: true });
      stateDir = undefined;
    }
  });

  it("records degraded/level-silent from the effective env, never a non-silent process.env", () => {
    // The UI store refuses a symlinked path; macOS tmpdir() sits behind /var -> /private/var.
    stateDir = realpathSync(mkdtempSync(join(tmpdir(), "keiko-dev-bff-evidence-")));
    vi.stubEnv("KEIKO_STATE_DIR", stateDir);
    // Pinned to a concrete NON-silent value so this test can tell "read from the effective env"
    // apart from "coincidentally read the right value from process.env too".
    vi.stubEnv("KEIKO_LOG_LEVEL", "info");
    expect(process.env.KEIKO_LOG_LEVEL).toBe("info");

    // The dev BFF's own effective env: KEIKO_LOG_LEVEL=silent as only a repo-local `.env` would set
    // it — deliberately NOT present in process.env itself.
    const effectiveEnv = { ...process.env, KEIKO_STATE_DIR: stateDir, KEIKO_LOG_LEVEL: "silent" };

    // Mirrors the dev BFF's own startup call (`dev-bff.mjs`), wiring the process-wide writer to
    // `stateDir` before the heartbeat ever runs.
    const startup = checkActivityLogReadiness({ stateDir, env: effectiveEnv });
    expect(startup).toMatchObject({ readiness: "degraded", reasons: ["level-silent"] });

    const refreshed = refreshDevBffEvidence({ stateDir, env: effectiveEnv });
    expect(refreshed).toMatchObject({ readiness: "degraded", reasons: ["level-silent"] });
    expect(refreshed.readiness).not.toBe("ready");
  });
});
