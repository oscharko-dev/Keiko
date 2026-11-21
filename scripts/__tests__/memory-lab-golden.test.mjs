// Golden identity of the existing corpus (#4207): the scorecard of three curated scenarios, in every
// arm, is pinned by digest. A lab change that moves an existing score fails here, loudly; a change
// that only extends the manifest, the summary or the failure-class keys does not. The full
// `scenarios` set (21 scenarios, 63 units) is too slow for the suite: its scorecard has the
// SHA-256 recorded in docs/qa/memoria-viva-lab.md, re-proved by the CLI run described there.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../testing/coding-workbench-lab/lab-common.mjs";
import { DEFAULT_SCENARIO_DIR, normalizeOptions, runLab } from "../testing/memory-lab/run.mjs";

const SCENARIOS = ["preference-tables-de", "reversal-spaces-en", "hypothetical-en"];
// SHA-256 of scorecard.json of the three scenarios, arms off, product and oracle, offline.
const GOLDEN_SCORECARD_SHA256 = "d0036f2c2fe6f4f91bb34d9fcb84f218a5c80ec45027b2ca0850ad0dc178b087";

describe("the scorecard of the existing corpus", () => {
  let root;
  beforeAll(() => {
    if (!existsSync(join(REPO_ROOT, "packages", "keiko-server", "dist", "index.js")))
      throw new Error("memory lab needs built packages; run npm run build:packages");
    root = mkdtempSync(join(tmpdir(), "memory-lab-golden-"));
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("is unchanged: its values hash to the recorded digest", async () => {
    const scenarios = join(root, "scenarios");
    mkdirSync(scenarios, { recursive: true });
    for (const id of SCENARIOS)
      copyFileSync(join(DEFAULT_SCENARIO_DIR, `${id}.json`), join(scenarios, `${id}.json`));
    await runLab(
      normalizeOptions({
        mode: "offline",
        out: join(root, "run"),
        scenarios,
        arms: "off,product,oracle",
        repetitions: "1",
        "generated-at": "0",
        "quiet-ms": "400",
        "max-wait-ms": "30000",
        "turn-timeout-ms": "60000",
      }),
      () => undefined,
    );
    const bytes = readFileSync(join(root, "run", "scorecard.json"));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(GOLDEN_SCORECARD_SHA256);
  }, 300_000);
});
