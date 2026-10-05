import { afterEach, describe, expect, it, vi } from "vitest";
import * as workflows from "@oscharko-dev/keiko-workflows";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";
import { retrieveConnectedContextPack } from "./grounded-orchestrator.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

afterEach(() => vi.restoreAllMocks());

async function retrieve(
  text = "Where is `dispatchWorkUnit` defined, and what does it do?",
): Promise<ReturnType<typeof createBufferedServerLogSink>> {
  const root = "/private/definition-provenance";
  const activityLog = createBufferedServerLogSink();
  await retrieveConnectedContextPack(
    {
      workspaceRoot: root,
      scope: {
        schemaVersion: "1",
        scopeId: "definition-provenance",
        workspaceRoot: root,
        kind: "workspace-root",
        relativePaths: [],
        explicitConnection: true,
        conversationId: undefined,
        connectedAtMs: 0,
      },
      query: {
        kind: "natural-language",
        text,
        maxResults: 40,
        caseSensitive: false,
        emittedAtMs: 0,
      },
    },
    {
      fs: memFs(root, {
        "src/worker.ts": "export function dispatchWorkUnit() { return 42; }\n",
        "src/caller.ts":
          "import { dispatchWorkUnit } from './worker';\nexport const answer = dispatchWorkUnit();\n",
      }),
      nowMs: () => 0,
      correlationId: "definition-provenance",
      activityLog,
      answerer: { answer: () => Promise.reject(new TypeError("No model call permitted")) },
    },
  );
  return activityLog;
}

describe("definition-discovery provenance identity", () => {
  it.each([
    { text: "Where is `dispatchWorkUnit` defined, and what does it do?", reused: 2 },
    {
      text: "Where are `dispatchWorkUnit` and MissingWorkerProbe defined? Explain their context.",
      reused: 6,
    },
  ])("does not count reused lexical atoms twice: $text", async ({ text, reused }) => {
    const rank = vi.spyOn(workflows, "rankCandidates");
    const assemble = vi.spyOn(workflows, "assembleContextPack");
    const log = await retrieve(text);
    expect(rank).toHaveBeenCalledOnce();
    expect(assemble).toHaveBeenCalledOnce();
    const atoms = rank.mock.calls[0]?.[0].atoms ?? [];
    expect(atoms.some((atom) => atom.provenance.tool === "repo.searchText")).toBe(true);
    expect(atoms.some((atom) => atom.provenance.tool === "discovered-symbol-definition")).toBe(
      true,
    );
    expect(atoms.map((atom) => atom.stableId)).toEqual([
      ...new Set(atoms.map((atom) => atom.stableId)),
    ]);
    const assembled = assemble.mock.calls[0]?.[0].atoms ?? [];
    expect(assembled.length).toBeGreaterThan(0);
    expect(assembled.map((atom) => atom.stableId)).toEqual([
      ...new Set(assembled.map((atom) => atom.stableId)),
    ]);
    expect(
      log.events.find((event) => event.op === "search.connected-context.source-details")?.extra,
    ).toMatchObject({ reusedEvidenceAtomCount: reused });
    expect(log.events.some((event) => event.op === "search.connected-context.completed")).toBe(
      true,
    );
  });
});

describe("canonical definition reuse evidence", () => {
  it("persists only the actual reuse count under the request correlation", async () => {
    const log = await retrieve();
    const detail = log.events.find(
      (event) => event.op === "search.connected-context.source-details",
    );
    const line = expectActivityLogProof(
      "search.connected-context.source-details.line",
      formatActivityLogProofLine(detail ?? {}),
    );
    expect(line).toMatchObject({
      correlationId: "definition-provenance",
      reusedEvidenceAtomCount: 2,
    });
    expect(JSON.stringify(line)).not.toContain("dispatchWorkUnit");
    expect(JSON.stringify(line)).not.toContain("worker.ts");
  });
});
