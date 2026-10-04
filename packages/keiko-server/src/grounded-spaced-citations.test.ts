import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGroundedExploration } from "./grounded-orchestrator.js";
import {
  buildPackCitationIndex,
  reconcileInlineCitations,
  segmentCitedClaims,
} from "./grounded-faithfulness.js";
import { buildQuery } from "./grounded-qa.js";

const SOURCES = [
  ["handbooks/material/service/archive/current/chapters/conveyor.html", 1193],
  ["handbooks/metrology/service/archive/current/chapters/calibration.html", 1687],
  ["handbooks/monitoring/service/archive/current/chapters/controller.html", 428],
  ["handbooks/water/service/archive/current/chapters/pump.html", 731],
] as const;
let root = "";
beforeEach((): void => {
  root = mkdtempSync(join(tmpdir(), "keiko-spaced-citations-"));
  for (const [path, hours] of SOURCES) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(
      join(root, path),
      `${"<!-- handbook -->\n".repeat(181)}<p>Service interval ${String(hours)} hours.</p>\n`,
    );
  }
});
afterEach((): void => {
  rmSync(root, { recursive: true, force: true });
});

function actualTableAnswer(): string {
  return [
    "| Machine | Interval | Source |",
    "|---|---|---|",
    ...SOURCES.map(
      ([path, hours], index) =>
        `| Machine ${String(index)} | ${String(hours)} hours | ${path}\u202f:\u202f182 |`,
    ),
  ].join("\n");
}

describe("actual spaced table citations in grounded answers", () => {
  it("retains physical line182 citations without an uncited-answer warning", async (): Promise<void> => {
    const answer = actualTableAnswer();
    const result = await runGroundedExploration(
      {
        workspaceRoot: root,
        scope: {
          schemaVersion: "1",
          scopeId: "spaced-citations",
          workspaceRoot: root,
          kind: "workspace-root",
          relativePaths: [],
          explicitConnection: true,
          conversationId: "chat",
          connectedAtMs: 1,
        },
        query: buildQuery(
          "Explain the documented maintenance intervals for every machine.",
          () => 1,
        ),
      },
      {
        nowMs: () => 1,
        correlationId: undefined,
        answerer: { answer: () => Promise.resolve(answer) },
      },
    );
    expect(result.pack.files).toHaveLength(4);
    expect(
      result.pack.uncertainty.some(
        (marker) => marker.kind === "uncited-answer" || marker.kind === "unsupported-citation",
      ),
    ).toBe(false);
    expect([
      ...reconcileInlineCitations(result.assistantContent, buildPackCitationIndex([result.pack]))
        .citedScopePaths,
    ]).toEqual(SOURCES.map(([path]) => path));
    expect(segmentCitedClaims(result.assistantContent)).toHaveLength(4);
  });
});
