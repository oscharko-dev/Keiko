// The recall trace against the real product (#4205), offline: a real chat turn and a real
// `POST /api/memory/context` answer from a server the lab starts itself, scripted model, no network.
// Pins that a needed memory the route ranks at position 7 to 12 behind a full chat block is
// `admitted-not-supplied`, with the route's position recorded as a fact, and that nothing claims
// `refused-by-chat`, `beyond-limit` or `moved-down`: the route's order does not predict the chat's
// (the chat ranks its admitted memories among themselves under the strict floor, the route ranks one
// window under the lenient floor). This relocates the pin that once asserted `beyond-limit`; it does
// not relax it.
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

  it("names a needed memory behind a full chat block admitted-not-supplied and claims no chat cut", async () => {
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
    // The chat's limit is the product's own constant (the trace itself no longer reads it).
    const handlers = readFileSync(
      join(REPO_ROOT, "packages", "keiko-server", "src", "chat-handlers.ts"),
      "utf8",
    );
    const limit = Number(/export const CHAT_MAX_RETRIEVED_MEMORIES = (\d+);/u.exec(handlers)?.[1]);
    expect(limit).toBeGreaterThan(0);
    expect(trace.chatRetrievedCount).toBe(limit);
    // Beyond the chat's limit in the route's order: listed past it, or omitted by the route's own limit
    // (past its position 12). Either way it is a recorded fact, and only a fact.
    const behind = trace.needed.filter(
      (entry) =>
        !entry.suppliedByChat &&
        ((entry.position !== null && entry.position > limit) ||
          entry.omittedReason === "max-included-exceeded"),
    );
    // Not vacuous: often-used records of equal relevance put the needed memory behind the limit.
    expect(behind.length).toBeGreaterThan(0);
    for (const entry of behind) {
      expect(entry.stage).toBe("admitted-not-supplied");
      expect(entry.position === null ? entry.omittedReason : entry.position).toSatisfy(
        (where) => where === "max-included-exceeded" || where > limit,
      );
    }
    expect(JSON.stringify(trace)).not.toMatch(
      /refused-by-chat|beyond-limit|moved-down|orderPremise|chatLimit/u,
    );
    expect(
      JSON.parse(readFileSync(join(root, "run", "manifest.json"), "utf8")).metadata,
    ).toMatchObject({ recallTrace: "on" });
  }, 300_000);
});
