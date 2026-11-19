// The recall trace against the real product (#4205), offline: a real chat turn and a real
// `POST /api/memory/context` answer from a server the lab starts itself, scripted model, no network.
// Pins that a needed memory the route ranks at position 7 to 12 behind a full chat block reads
// `beyond-limit` and never anything that suggests it was close.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../testing/coding-workbench-lab/lab-common.mjs";
import { normalizeOptions, runLab } from "../testing/memory-lab/run.mjs";

const SCENARIO_DIR = join(REPO_ROOT, "scripts", "testing", "memory-lab", "scenarios-next");

// The shipped scenario plus eight often-used records that share every informative word of the
// question with the needed one, so the needed memory is behind the chat's limit by the product's
// own ranking (equal relevance, the others used far more often), not by a defect the product may
// lose. Ranked among the admitted memories since #4228, the shipped scenario alone supplies it.
function crowdedScenario() {
  const scenario = JSON.parse(
    readFileSync(join(SCENARIO_DIR, "long-horizon-oft-genutzt-en.json"), "utf8"),
  );
  const crowd = Array.from({ length: 8 }, (_, index) => ({
    key: `crowd-${String(index + 1)}`,
    body: `Note ${String(index + 1)} on the caterer search for the team offsite: quote requested.`,
    type: "semantic-fact",
    scope: "project",
    status: "accepted",
    ageDays: 20 + index,
    accessCount: 9,
    lastAccessDays: 1,
  }));
  return { ...scenario, seed: { ...scenario.seed, records: [...scenario.seed.records, ...crowd] } };
}

describe("the recall trace of a real offline run", () => {
  let root;
  beforeAll(() => {
    if (!existsSync(join(REPO_ROOT, "packages", "keiko-server", "dist", "index.js")))
      throw new Error("memory lab needs built packages; run npm run build:packages");
    root = mkdtempSync(join(tmpdir(), "memory-lab-trace-offline-"));
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("reads a needed memory behind a full chat block as beyond the limit", async () => {
    const scenarios = join(root, "scenarios");
    mkdirSync(scenarios, { recursive: true });
    writeFileSync(
      join(scenarios, "long-horizon-oft-genutzt-en.json"),
      JSON.stringify(crowdedScenario()),
    );
    await runLab(
      normalizeOptions({
        mode: "offline",
        out: join(root, "run"),
        scenarios,
        arms: "product",
        repetitions: "1",
        "generated-at": "0",
        "quiet-ms": "400",
        "max-wait-ms": "30000",
        "turn-timeout-ms": "60000",
      }),
      () => undefined,
    );
    const unit = JSON.parse(
      readFileSync(
        join(root, "run", "runs", "long-horizon-oft-genutzt-en.product.r0.json"),
        "utf8",
      ),
    );
    const trace = unit.probes.find((probe) => probe.id === "caterer").recallTrace;
    // The limit is the product's own, read from its build.
    expect(trace.chatLimit).toBeGreaterThan(0);
    expect(trace.limitFailure).toBeUndefined();
    expect(trace.chatRetrievedCount).toBe(trace.chatLimit);
    const behind = trace.needed.filter(
      (entry) =>
        !entry.suppliedByChat &&
        entry.position !== null &&
        entry.position > trace.chatLimit &&
        entry.position <= 12,
    );
    // Not vacuous: often-used records of equal relevance push the needed memory behind the limit.
    expect(behind.length).toBeGreaterThan(0);
    for (const entry of behind) {
      expect(entry.stage).toBe("beyond-limit");
      expect(entry.scoreRank).toBeGreaterThan(trace.chatLimit);
    }
    expect(JSON.stringify(trace)).not.toMatch(/refused-by-chat|moved-down/u);
    expect(
      JSON.parse(readFileSync(join(root, "run", "manifest.json"), "utf8")).metadata,
    ).toMatchObject({ recallTrace: "on" });
  }, 300_000);
});
