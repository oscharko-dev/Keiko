import { describe, expect, it } from "vitest";
import type { ChatToolBatchProgress } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  runJiraDraftBatch,
  type DraftBatchGeneration,
  type DraftBatchInput,
  type DraftBatchObservation,
  type DraftBatchPorts,
  type DraftBatchResult,
  type DraftBatchStageOutcome,
} from "./jiraDraftBatch.js";
import type { DraftBatchMessage, DraftBatchRequirement } from "./jiraDraftBatchPrompt.js";

const SECTIONS = ["Context", "Acceptance"];

function requirements(count: number): DraftBatchRequirement[] {
  return Array.from({ length: count }, (_, index) => ({
    ref: `doc:R${String(index + 1)}`,
    title: `Title ${String(index + 1)}`,
    section: "S",
    text: `Statement ${String(index + 1)}`,
  }));
}

function refOf(item: CatalogJsonObject): string {
  const { ref } = item;
  if (typeof ref !== "string") throw new TypeError("staged item without ref");
  return ref;
}

function userText(messages: readonly DraftBatchMessage[]): string {
  return messages[1]?.content ?? "";
}

function keysOf(messages: readonly DraftBatchMessage[]): string[] {
  const line = /^Keys: (.*)$/m.exec(userText(messages))?.[1] ?? "";
  return line.length === 0 ? [] : line.split(", ");
}

function outlineRefs(messages: readonly DraftBatchMessage[]): string[] {
  const listed = userText(messages).split("Requirements:\n")[1] ?? "";
  return listed.split("\n").map((line) => line.split(" | ")[0] ?? "");
}

function fillAnswer(keys: readonly string[], omit: ReadonlySet<string> = new Set()): string {
  const items = keys
    .filter((key) => !omit.has(key))
    .map((key) => ({
      key,
      summary: `Summary ${key}`,
      sections: { Context: `c ${key}`, Acceptance: `a ${key}` },
      requirementIds: ["model:invented"],
      projectId: "evil",
    }));
  return JSON.stringify({ items });
}

interface Harness {
  readonly ports: DraftBatchPorts;
  readonly fillCalls: DraftBatchMessage[][];
  readonly outlineCalls: DraftBatchMessage[][];
  readonly stageCalls: { refs: string[]; draftId: string | undefined }[];
  readonly staged: CatalogJsonObject[];
  readonly progress: ChatToolBatchProgress[];
  readonly observations: DraftBatchObservation[];
}

interface Behavior {
  readonly fill?: (
    keys: string[],
    messages: readonly DraftBatchMessage[],
    call: number,
  ) => DraftBatchGeneration | undefined;
  readonly outline?: (refs: string[], call: number) => DraftBatchGeneration | undefined;
  readonly stage?: (
    refs: string[],
    call: number,
    items: readonly CatalogJsonObject[],
  ) => DraftBatchStageOutcome | undefined;
  readonly completionPerKey?: number | undefined;
  readonly signal?: AbortSignal;
  readonly onGenerate?: () => void;
  /** Throws instead of answering when it returns an error. */
  readonly failGenerate?: (purpose: "outline" | "fill", call: number) => Error | undefined;
  readonly failStage?: (call: number) => Error | undefined;
}

function groupsAnswer(refs: readonly string[], size: number): string {
  const groups: { summary: string; requirements: string[] }[] = [];
  for (let at = 0; at < refs.length; at += size)
    groups.push({
      summary: `Group ${String(groups.length + 1)}`,
      requirements: refs.slice(at, at + size),
    });
  return JSON.stringify({ groups });
}

function harness(behavior: Behavior = {}): Harness {
  const h: Harness = {
    fillCalls: [],
    outlineCalls: [],
    stageCalls: [],
    staged: [],
    progress: [],
    observations: [],
    ports: undefined as unknown as DraftBatchPorts,
  };
  let pageCount = 0;
  let generateCalls = 0;
  let stageAttempts = 0;
  const completionPerKey = "completionPerKey" in behavior ? behavior.completionPerKey : 100;
  const ports: DraftBatchPorts = {
    generate: (messages, purpose) => {
      behavior.onGenerate?.();
      generateCalls += 1;
      const failure = behavior.failGenerate?.(purpose, generateCalls);
      if (failure !== undefined) return Promise.reject(failure);
      if (purpose === "outline") {
        h.outlineCalls.push([...messages]);
        const refs = outlineRefs(messages);
        const custom = behavior.outline?.(refs, h.outlineCalls.length);
        return Promise.resolve(
          custom ?? { kind: "text", text: groupsAnswer(refs, 3), completionTokens: 50 },
        );
      }
      h.fillCalls.push([...messages]);
      const keys = keysOf(messages);
      const custom = behavior.fill?.(keys, messages, h.fillCalls.length);
      return Promise.resolve(
        custom ?? {
          kind: "text",
          text: fillAnswer(keys),
          completionTokens:
            completionPerKey === undefined ? undefined : keys.length * completionPerKey,
        },
      );
    },
    stage: (items, draftId) => {
      stageAttempts += 1;
      const failure = behavior.failStage?.(stageAttempts);
      if (failure !== undefined) return Promise.reject(failure);
      const refs = items.map((item) => refOf(item));
      h.stageCalls.push({ refs, draftId });
      const custom = behavior.stage?.(refs, h.stageCalls.length, items);
      if (custom !== undefined) return Promise.resolve(custom);
      h.staged.push(...items);
      pageCount += 1;
      return Promise.resolve({
        kind: "staged",
        draftId: "draft-1",
        draftDigest: `digest-${String(pageCount)}`,
        itemCount: h.staged.length,
        pageCount,
      });
    },
    progress: (value) => h.progress.push(value),
    observe: (value) => h.observations.push(value),
    signal: behavior.signal ?? new AbortController().signal,
  };
  return { ...h, ports };
}

function input(count: number, overrides: Partial<DraftBatchInput> = {}): DraftBatchInput {
  return {
    requirements: requirements(count),
    granularity: "per-requirement",
    instructions: { rules: "{}", requiredSections: SECTIONS, requiredFields: [] },
    placement: {
      projectId: "P1",
      issueTypeId: "T1",
      requiredLabels: ["keiko"],
      parent: { key: "EPIC-1" },
    },
    maxOutputTokens: 8192,
    refPrefix: "D",
    ...overrides,
  };
}

function stagedRefs(h: Harness): string[] {
  return h.staged.map((item) => refOf(item));
}

function coveredRefs(h: Harness): string[] {
  return h.staged.flatMap((item) => item.requirementIds as string[]);
}

function expectComplete(result: DraftBatchResult, count: number, h: Harness): void {
  expect(result.progress).toEqual({
    phase: "complete",
    draftedCount: count,
    plannedCount: count,
    coveredRequirementCount: count,
    requirementCount: count,
    failedCount: 0,
  });
  expect(result.failedRequirementRefs).toEqual([]);
  expect(result.itemCount).toBe(count);
  expect(new Set(stagedRefs(h)).size).toBe(count);
}

function expectMonotonic(progress: readonly ChatToolBatchProgress[]): void {
  for (let at = 1; at < progress.length; at += 1) {
    const before = progress[at - 1];
    const now = progress[at];
    expect(now?.draftedCount).toBeGreaterThanOrEqual(before?.draftedCount ?? 0);
    expect(now?.coveredRequirementCount).toBeGreaterThanOrEqual(
      before?.coveredRequirementCount ?? 0,
    );
  }
}

describe("runJiraDraftBatch per requirement", () => {
  it("drafts 131 requirements exactly once each with Keiko's own mapping", async () => {
    const h = harness();
    const result = await runJiraDraftBatch(input(131), h.ports);
    expectComplete(result, 131, h);
    expect(stagedRefs(h)).toHaveLength(131);
    expect(coveredRefs(h)).toEqual(requirements(131).map((item) => item.ref));
    expect(new Set(coveredRefs(h)).size).toBe(131);
    for (const item of h.staged) {
      expect(item).toMatchObject({ projectId: "P1", issueTypeId: "T1", parent: { key: "EPIC-1" } });
      expect((item.fields as { labels: string[] }).labels).toEqual(["keiko"]);
    }
    expect(result.draftId).toBe("draft-1");
    expect(result.stopReason).toBeUndefined();
  });

  it("reports monotonic progress from outlining to complete", async () => {
    const h = harness();
    const result = await runJiraDraftBatch(input(131), h.ports);
    expect(h.progress[0]?.phase).toBe("outlining");
    expect(h.progress.at(-1)).toEqual(result.progress);
    expect(h.progress.at(-1)?.phase).toBe("complete");
    expectMonotonic(h.progress);
    expect(h.progress.at(-1)?.draftedCount).toBe(131);
  });

  it("sizes the next page from the measured completion tokens", async () => {
    const h = harness({ completionPerKey: 100 });
    await runJiraDraftBatch(input(131), h.ports);
    const sizes = h.fillCalls.map((messages) => keysOf(messages).length);
    // 440 planned tokens per issue: floor(8192 * 0.55 / 440) = 10; measured 100 * 1.25: 36.
    expect(sizes).toEqual([10, 36, 36, 36, 13]);
  });

  it("keeps the planned size when the provider reports no usage", async () => {
    const h = harness({ completionPerKey: undefined });
    const result = await runJiraDraftBatch(input(131), h.ports);
    expectComplete(result, 131, h);
    expect(h.fillCalls.map((messages) => keysOf(messages).length).slice(0, 3)).toEqual([
      10, 10, 10,
    ]);
  });

  it("drafts 300 requirements in pages, not one call per issue", async () => {
    const h = harness();
    const result = await runJiraDraftBatch(input(300), h.ports);
    expectComplete(result, 300, h);
    expect(h.fillCalls.length).toBeLessThanOrEqual(12);
    expect(h.fillCalls.length).toBeGreaterThan(1);
    expect(h.outlineCalls).toHaveLength(0);
  });

  it("starts with a fresh prefix and appends to an existing draft", async () => {
    const h = harness();
    await runJiraDraftBatch(input(3, { refPrefix: "B2-", draftId: "draft-9" }), h.ports);
    expect(stagedRefs(h)).toEqual(["B2-1", "B2-2", "B2-3"]);
    expect(h.stageCalls[0]?.draftId).toBe("draft-9");
  });

  it("passes the draft id of the first staged page on to later pages", async () => {
    const h = harness({ completionPerKey: undefined });
    await runJiraDraftBatch(input(25), h.ports);
    expect(h.stageCalls[0]?.draftId).toBeUndefined();
    expect(h.stageCalls[1]?.draftId).toBe("draft-1");
  });

  it("returns the latest draft digest and counts from the stage port", async () => {
    const h = harness({ completionPerKey: undefined });
    const result = await runJiraDraftBatch(input(25), h.ports);
    expect(result.pageCount).toBe(3);
    expect(result.draftDigest).toBe("digest-3");
  });

  it("writes Markdown descriptions in template order", async () => {
    const h = harness();
    await runJiraDraftBatch(input(1), h.ports);
    const fields = h.staged[0]?.fields as { description: { format: string; text: string } };
    expect(fields.description).toEqual({
      format: "markdown",
      text: "## Context\n\nc D1\n\n## Acceptance\n\na D1",
    });
  });

  it("returns no-requirements without calling any port", async () => {
    const h = harness();
    const result = await runJiraDraftBatch(input(0), h.ports);
    expect(result.stopReason).toBe("no-requirements");
    expect(result.progress).toMatchObject({ phase: "complete", draftedCount: 0, plannedCount: 0 });
    expect(h.fillCalls).toHaveLength(0);
    expect(h.stageCalls).toHaveLength(0);
  });
});

describe("runJiraDraftBatch recovery", () => {
  it("splits an exhausted page in halves until everything is drafted", async () => {
    const h = harness({
      fill: (keys) => (keys.length > 3 ? { kind: "exhausted" } : undefined),
    });
    const result = await runJiraDraftBatch(input(40), h.ports);
    expectComplete(result, 40, h);
    expect(h.observations.some((o) => o.kind === "page" && o.outcome === "split")).toBe(true);
    expect(Math.max(...h.stageCalls.map((call) => call.refs.length))).toBeLessThanOrEqual(3);
  });

  it("plans later pages with a higher cost after an exhausted page", async () => {
    const h = harness({
      fill: (keys) => (keys.length > 3 ? { kind: "exhausted" } : undefined),
    });
    await runJiraDraftBatch(input(40), h.ports);
    const sizes = h.fillCalls.map((messages) => keysOf(messages).length);
    expect(sizes[0]).toBe(10);
    expect(sizes.slice(1, 3)).toEqual([5, 3]);
  });

  it("reports an item that always exhausts, and drafts the others", async () => {
    const h = harness({
      fill: (keys) => (keys.includes("D7") ? { kind: "exhausted" } : undefined),
    });
    const result = await runJiraDraftBatch(input(20), h.ports);
    expect(result.failedRequirementRefs).toEqual(["doc:R7"]);
    expect(result.progress).toMatchObject({
      phase: "complete",
      draftedCount: 19,
      plannedCount: 20,
      coveredRequirementCount: 19,
      failedCount: 1,
    });
    expect(stagedRefs(h)).not.toContain("D7");
    expect(stagedRefs(h)).toHaveLength(19);
  });

  it("corrects invalid JSON once and names the problem", async () => {
    const h = harness({
      fill: (_keys, _messages, call) =>
        call === 1 ? { kind: "text", text: "not json" } : undefined,
    });
    const result = await runJiraDraftBatch(input(3), h.ports);
    expectComplete(result, 3, h);
    expect(h.fillCalls).toHaveLength(2);
    expect(h.fillCalls[1]).toHaveLength(3);
    expect(h.fillCalls[1]?.[2]?.content).toContain("Answer with one JSON object");
    expect(h.observations.some((o) => o.kind === "page" && o.outcome === "corrected")).toBe(true);
  });

  it("corrects an omitted key and an omitted section", async () => {
    const h = harness({
      fill: (keys, _messages, call) => {
        if (call === 1) return { kind: "text", text: fillAnswer(keys, new Set(["D2"])) };
        if (call === 2)
          return {
            kind: "text",
            text: JSON.stringify({
              items: keys.map((key) => ({ key, summary: "S", sections: { Context: "c" } })),
            }),
          };
        return undefined;
      },
    });
    const result = await runJiraDraftBatch(input(3, { maxOutputTokens: 100_000 }), h.ports);
    expect(h.fillCalls[1]?.[2]?.content).toContain("Missing keys or summaries: D2.");
    expect(h.fillCalls.length).toBeGreaterThanOrEqual(2);
    expect(result.failedRequirementRefs).toEqual([]);
    expect(h.staged).toHaveLength(3);
  });

  it("ignores requirement ids and project ids the model returns", async () => {
    const h = harness();
    await runJiraDraftBatch(input(2), h.ports);
    expect(h.staged.map((item) => item.requirementIds)).toEqual([["doc:R1"], ["doc:R2"]]);
    expect(h.staged.every((item) => item.projectId === "P1")).toBe(true);
  });

  it("corrects a page the stage rejects once, with the guidance", async () => {
    let rejected = false;
    const h = harness({
      stage: (refs) => {
        if (!rejected && refs.includes("D2")) {
          rejected = true;
          return { kind: "rejected", guidance: "Summary too long." };
        }
        return undefined;
      },
    });
    const result = await runJiraDraftBatch(input(3), h.ports);
    expectComplete(result, 3, h);
    expect(h.fillCalls).toHaveLength(2);
    expect(h.fillCalls[1]?.[2]?.content).toContain("Summary too long.");
    expect(h.observations.some((o) => o.kind === "page" && o.outcome === "refused")).toBe(true);
  });

  it("stops instead of splitting an unchanged model-owned stage rejection", async () => {
    const h = harness({
      stage: (refs) => (refs.includes("D3") ? { kind: "rejected", guidance: "Nope." } : undefined),
    });
    const result = await runJiraDraftBatch(input(10), h.ports);
    expect(result.stopReason).toBe("stage-rejection-unchanged");
    expect(result.failedRequirementRefs).toEqual(requirements(10).map((item) => item.ref));
    expect(result.progress).toMatchObject({
      draftedCount: 0,
      coveredRequirementCount: 0,
    });
    expect(stagedRefs(h)).toEqual([]);
    expect(h.fillCalls).toHaveLength(2);
    expect(h.stageCalls).toHaveLength(2);
    expect(h.observations.some((item) => item.kind === "page" && item.outcome === "split")).toBe(
      false,
    );
  });

  it("stops on a fatal stage outcome and reports the undrafted requirements", async () => {
    const h = harness({
      completionPerKey: undefined,
      stage: (_refs, call) => (call === 2 ? { kind: "fatal", reason: "changed" } : undefined),
    });
    const result = await runJiraDraftBatch(input(25), h.ports);
    expect(result.stopReason).toBe("stage-failed");
    expect(h.stageCalls).toHaveLength(2);
    expect(stagedRefs(h)).toHaveLength(10);
    expect(result.failedRequirementRefs).toEqual(
      requirements(25)
        .slice(10)
        .map((item) => item.ref),
    );
    expect(result.progress.phase).toBe("complete");
    expect(result.progress.draftedCount).toBe(10);
  });

  it("terminates when the model always answers invalid JSON and reports every failure", async () => {
    const h = harness({ fill: () => ({ kind: "text", text: "garbage" }) });
    const result = await runJiraDraftBatch(input(12), h.ports);
    expect(result.failedRequirementRefs).toEqual(requirements(12).map((item) => item.ref));
    expect(result.progress).toMatchObject({ draftedCount: 0, failedCount: 12 });
    expect(h.fillCalls.length).toBeLessThanOrEqual(16 + 4 * 12);
    expect(h.stageCalls).toHaveLength(0);
  });
});

describe("runJiraDraftBatch grouped", () => {
  it("plans one issue per outline group covering every requirement once", async () => {
    const h = harness();
    const result = await runJiraDraftBatch(input(10, { granularity: "grouped" }), h.ports);
    expect(result.progress).toMatchObject({
      phase: "complete",
      plannedCount: 4,
      draftedCount: 4,
      coveredRequirementCount: 10,
      requirementCount: 10,
      failedCount: 0,
    });
    expect(h.outlineCalls).toHaveLength(1);
    expect(h.progress[0]?.phase).toBe("outlining");
    expect(coveredRefs(h).sort()).toEqual(
      requirements(10)
        .map((item) => item.ref)
        .sort(),
    );
    expect(h.staged.map((item) => (item.requirementIds as string[]).length)).toEqual([3, 3, 3, 1]);
    expect(h.fillCalls[0]?.[1]?.content).toContain("Summary hint: Group 1");
  });

  it("asks once more for requirements the outline left out", async () => {
    const h = harness({
      outline: (refs, call) => {
        if (call === 1)
          return {
            kind: "text",
            text: groupsAnswer(
              refs.filter((ref) => ref !== "doc:R4" && ref !== "doc:R5"),
              3,
            ),
          };
        return undefined;
      },
    });
    const result = await runJiraDraftBatch(input(6, { granularity: "grouped" }), h.ports);
    expect(h.outlineCalls).toHaveLength(2);
    expect(outlineRefs(h.outlineCalls[1] ?? [])).toEqual(["doc:R4", "doc:R5"]);
    expect(result.progress.coveredRequirementCount).toBe(6);
    expect(result.failedRequirementRefs).toEqual([]);
    expect(new Set(coveredRefs(h)).size).toBe(6);
    expect(coveredRefs(h)).toHaveLength(6);
  });

  it("makes single issues of requirements two answers in a row grouped nothing for", async () => {
    const h = harness({
      outline: (refs, call) =>
        call === 1
          ? {
              kind: "text",
              text: groupsAnswer(
                refs.filter((ref) => ref !== "doc:R4" && ref !== "doc:R5"),
                3,
              ),
            }
          : { kind: "text", text: JSON.stringify({ groups: [] }) },
    });
    const result = await runJiraDraftBatch(input(6, { granularity: "grouped" }), h.ports);
    expect(h.outlineCalls).toHaveLength(3);
    expect(result.progress.plannedCount).toBe(4);
    expect(result.progress.coveredRequirementCount).toBe(6);
    const lone = h.staged.filter((item) => (item.requirementIds as string[]).length === 1);
    expect(lone.map((item) => item.requirementIds)).toEqual([["doc:R6"], ["doc:R4"], ["doc:R5"]]);
  });

  it("halves a chunk whose outline runs out of output", async () => {
    const h = harness({
      outline: (refs) => (refs.length > 6 ? { kind: "exhausted" } : undefined),
    });
    const result = await runJiraDraftBatch(input(12, { granularity: "grouped" }), h.ports);
    expect(h.outlineCalls.map((call) => outlineRefs(call).length)).toEqual([12, 6, 6]);
    expect(result.progress.coveredRequirementCount).toBe(12);
    expect(result.progress.failedCount).toBe(0);
    expect(h.observations.some((o) => o.kind === "outline" && o.outcome === "exhausted")).toBe(
      true,
    );
  });

  it("plans a lone requirement alone when its outline is exhausted", async () => {
    const h = harness({ outline: () => ({ kind: "exhausted" }) });
    const result = await runJiraDraftBatch(input(1, { granularity: "grouped" }), h.ports);
    expect(result.progress).toMatchObject({ plannedCount: 1, draftedCount: 1 });
  });

  it("ignores unknown and repeated references in the outline answer", async () => {
    const h = harness({
      outline: () => ({
        kind: "text",
        text: JSON.stringify({
          groups: [
            { summary: "A", requirements: ["doc:R1", "doc:GHOST", "doc:R1"] },
            { summary: "B", requirements: ["doc:R1", "doc:R2", "doc:R3"] },
          ],
        }),
      }),
    });
    const result = await runJiraDraftBatch(input(3, { granularity: "grouped" }), h.ports);
    expect(h.staged.map((item) => item.requirementIds)).toEqual([["doc:R1"], ["doc:R2", "doc:R3"]]);
    expect(result.progress.coveredRequirementCount).toBe(3);
  });

  it("halves an outline that always runs out of output down to single issues", async () => {
    const h = harness({ outline: () => ({ kind: "exhausted" }) });
    const result = await runJiraDraftBatch(input(40, { granularity: "grouped" }), h.ports);
    expect(result.stopReason).toBeUndefined();
    expect(h.outlineCalls.length).toBeLessThanOrEqual(2 * 40);
    expect(result.progress).toMatchObject({ plannedCount: 40, coveredRequirementCount: 40 });
  });

  it("groups 300 requirements even when every outline above 40 runs out of output", async () => {
    const h = harness({
      outline: (refs) =>
        refs.length > 40
          ? { kind: "exhausted" }
          : {
              kind: "text",
              text: JSON.stringify({ groups: [{ summary: "G", requirements: refs }] }),
            },
    });
    const result = await runJiraDraftBatch(input(300, { granularity: "grouped" }), h.ports);
    expect(result.stopReason).toBeUndefined();
    expect(result.progress.plannedCount).toBeLessThanOrEqual(45);
    expect(result.progress.coveredRequirementCount).toBe(300);
    expect(
      Math.max(
        ...h.staged.map((item) =>
          Array.isArray(item.requirementIds) ? item.requirementIds.length : 0,
        ),
      ),
    ).toBe(8);
  });

  it("asks again while each answer groups something and plans the rest alone after an empty one", async () => {
    const h = harness({
      outline: (refs, calls) => {
        const first = refs[0];
        return calls <= 2 && first !== undefined
          ? {
              kind: "text",
              text: JSON.stringify({ groups: [{ summary: "G", requirements: [first] }] }),
            }
          : { kind: "text", text: JSON.stringify({ groups: [] }) };
      },
    });
    const result = await runJiraDraftBatch(input(5, { granularity: "grouped" }), h.ports);
    expect(h.outlineCalls).toHaveLength(4);
    expect(result.progress).toMatchObject({ plannedCount: 5, coveredRequirementCount: 5 });
  });
});

describe("runJiraDraftBatch cancellation", () => {
  it("rejects when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    const h = harness({ signal: controller.signal });
    await expect(runJiraDraftBatch(input(5), h.ports)).rejects.toThrow("stopped");
    expect(h.fillCalls).toHaveLength(0);
  });

  it("rejects when the signal aborts between pages and drafts no further page", async () => {
    const controller = new AbortController();
    const h = harness({
      completionPerKey: undefined,
      signal: controller.signal,
      onGenerate: () => {
        controller.abort(new Error("user stop"));
      },
    });
    await expect(runJiraDraftBatch(input(30), h.ports)).rejects.toThrow("user stop");
    expect(h.stageCalls).toHaveLength(1);
  });

  it("rejects during grouping", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    const h = harness({ signal: controller.signal });
    await expect(runJiraDraftBatch(input(5, { granularity: "grouped" }), h.ports)).rejects.toThrow(
      "stopped",
    );
    expect(h.outlineCalls).toHaveLength(0);
  });
});

describe("runJiraDraftBatch without template sections", () => {
  it("drafts the free description text", async () => {
    const h = harness({
      fill: (keys) => ({
        kind: "text",
        text: JSON.stringify({
          items: keys.map((key) => ({
            key,
            summary: `S ${key}`,
            sections: { description: `Text ${key}` },
          })),
        }),
      }),
    });
    const result = await runJiraDraftBatch(
      input(2, { instructions: { rules: "{}", requiredSections: [], requiredFields: [] } }),
      h.ports,
    );
    expectComplete(result, 2, h);
    const fields = h.staged[0]?.fields as { description: { text: string } };
    expect(fields.description.text).toBe("Text D1");
  });
});

describe("runJiraDraftBatch deadline", () => {
  /** Every model call takes 100 s on a fake clock. */
  function clocked(deadlineAtMs: number): { h: Harness; ports: DraftBatchPorts } {
    let now = 0;
    const h = harness({
      completionPerKey: undefined,
      onGenerate: () => {
        now += 100_000;
      },
    });
    return { h, ports: { ...h.ports, budget: { nowMs: () => now, deadlineAtMs } } };
  }

  it("stops before a page that cannot fit and keeps the staged draft", async () => {
    const { h, ports } = clocked(300_000);
    const result = await runJiraDraftBatch(input(25), ports);
    expect(result.stopReason).toBe("deadline");
    expect(h.fillCalls).toHaveLength(2);
    expect(result.progress.draftedCount).toBe(20);
    expect(result.draftId).toBe("draft-1");
    const rest = requirements(25)
      .slice(20)
      .map((item) => item.ref);
    expect(result.deferredRequirementRefs).toEqual(rest);
    expect(result.failedRequirementRefs).toEqual(rest);
  });

  it("pauses before the first page when the budget cannot hold it, naming every requirement", async () => {
    const { h, ports } = clocked(1);
    const result = await runJiraDraftBatch(input(25), ports);
    expect(h.fillCalls).toHaveLength(0);
    expect(h.stageCalls).toHaveLength(0);
    expect(result.stopReason).toBe("deadline");
    expect(result.draftId).toBeUndefined();
    expect(result.deferredRequirementRefs).toEqual(requirements(25).map((item) => item.ref));
  });

  it("pauses between outline chunks and drafts nothing it has no time for", async () => {
    let now = 0;
    const h = harness({
      outline: (refs, call) => (call === 1 && refs.length > 1 ? { kind: "exhausted" } : undefined),
      onGenerate: () => {
        now += 100_000;
      },
    });
    const ports: DraftBatchPorts = {
      ...h.ports,
      budget: { nowMs: (): number => now, deadlineAtMs: 150_000 },
    };
    const result = await runJiraDraftBatch(input(12, { granularity: "grouped" }), ports);
    expect(h.outlineCalls).toHaveLength(1);
    expect(h.fillCalls).toHaveLength(0);
    expect(result.stopReason).toBe("deadline");
    expect(result.deferredRequirementRefs).toEqual(requirements(12).map((item) => item.ref));
  });

  it("is unchanged when every page fits", async () => {
    const { h, ports } = clocked(100_000_000);
    const result = await runJiraDraftBatch(input(25), ports);
    expectComplete(result, 25, h);
    expect(result.stopReason).toBeUndefined();
    expect(result.deferredRequirementRefs).toEqual([]);
  });
});

describe("runJiraDraftBatch model and stage errors", () => {
  it("stops at the call allowance and reports what is not drafted", async () => {
    const h = harness({ completionPerKey: undefined });
    const result = await runJiraDraftBatch(input(25, { maxCalls: 2 }), h.ports);
    expect(result.stopReason).toBe("call-limit");
    expect(h.fillCalls).toHaveLength(2);
    expect(result.progress.draftedCount).toBe(20);
    expect(result.failedRequirementRefs).toEqual(
      requirements(25)
        .slice(20)
        .map((item) => item.ref),
    );
  });

  it("stops with call-limit when the turn has no model calls left", async () => {
    const h = harness({ completionPerKey: undefined });
    let left = 2;
    const ports: DraftBatchPorts = {
      ...h.ports,
      generate: (messages, purpose) => {
        left -= 1;
        return h.ports.generate(messages, purpose);
      },
      remainingCalls: () => left,
    };
    const result = await runJiraDraftBatch(input(25), ports);
    expect(result.stopReason).toBe("call-limit");
    expect(h.fillCalls).toHaveLength(2);
    expect(result.progress.draftedCount).toBe(20);
    expect(result.failedRequirementRefs).toHaveLength(5);
  });

  it("returns the staged pages and every undrafted requirement when the model fails", async () => {
    const provider = new Error("provider exploded");
    const h = harness({
      completionPerKey: undefined,
      failGenerate: (_purpose, call) => (call === 2 ? provider : undefined),
    });
    const result = await runJiraDraftBatch(input(25), h.ports);
    expect(result.stopReason).toBe("model-failed");
    expect(result.error).toBe(provider);
    expect(result.draftId).toBe("draft-1");
    expect(result.draftDigest).toBe("digest-1");
    expect(result.progress).toMatchObject({ phase: "complete", draftedCount: 10 });
    expect(result.failedRequirementRefs).toEqual(
      requirements(25)
        .slice(10)
        .map((item) => item.ref),
    );
    expect(h.fillCalls).toHaveLength(1);
  });

  it("asks the model nothing more after it failed, also for the outline", async () => {
    const h = harness({ failGenerate: () => new Error("provider exploded") });
    const result = await runJiraDraftBatch(input(5, { granularity: "grouped" }), h.ports);
    expect(result.stopReason).toBe("model-failed");
    expect(result.progress.draftedCount).toBe(0);
    expect(result.failedRequirementRefs).toEqual(requirements(5).map((item) => item.ref));
    expect(h.outlineCalls).toHaveLength(0);
    expect(h.fillCalls).toHaveLength(0);
  });

  it("rethrows a model error that is a cancellation", async () => {
    const controller = new AbortController();
    const h = harness({
      signal: controller.signal,
      failGenerate: () => {
        controller.abort(new Error("user stop"));
        return new Error("user stop");
      },
    });
    await expect(runJiraDraftBatch(input(5), h.ports)).rejects.toThrow("user stop");
  });

  it("stages a page again once when the draft fails transiently", async () => {
    const h = harness({
      stage: (_refs, call) =>
        call === 1 ? { kind: "fatal", reason: "metadata-unavailable", transient: true } : undefined,
    });
    const result = await runJiraDraftBatch(input(4), h.ports);
    expectComplete(result, 4, h);
    expect(h.stageCalls).toHaveLength(2);
    expect(h.fillCalls).toHaveLength(1);
  });

  it("stops after the second transient failure and keeps the earlier pages", async () => {
    const h = harness({
      completionPerKey: undefined,
      stage: (_refs, call) =>
        call >= 2 ? { kind: "fatal", reason: "metadata-unavailable", transient: true } : undefined,
    });
    const result = await runJiraDraftBatch(input(25), h.ports);
    expect(result.stopReason).toBe("stage-failed");
    expect(h.stageCalls).toHaveLength(3);
    expect(result.progress.draftedCount).toBe(10);
  });

  it("does not retry a permanent fatal outcome", async () => {
    const h = harness({ stage: () => ({ kind: "fatal", reason: "connection-changed" }) });
    const result = await runJiraDraftBatch(input(4), h.ports);
    expect(result.stopReason).toBe("stage-failed");
    expect(h.stageCalls).toHaveLength(1);
  });

  it("retries a staging call that threw once and keeps the error when it throws again", async () => {
    const first = harness({ failStage: (call) => (call === 1 ? new Error("boom") : undefined) });
    expectComplete(await runJiraDraftBatch(input(3), first.ports), 3, first);
    const boom = new Error("always");
    const always = harness({ failStage: () => boom });
    const result = await runJiraDraftBatch(input(3), always.ports);
    expect(result.stopReason).toBe("stage-failed");
    expect(result.error).toBe(boom);
    expect(result.failedRequirementRefs).toHaveLength(3);
  });
});

describe("runJiraDraftBatch Keiko-owned rejections", () => {
  const keikoRejects = (culprit: string): NonNullable<Behavior["stage"]> => {
    return (refs) =>
      refs.includes(culprit)
        ? { kind: "rejected", guidance: "Trace refused.", owner: "keiko" }
        : undefined;
  };

  it("stops cached isolation when the same Keiko rejection returns", async () => {
    const h = harness({ stage: keikoRejects("D3") });
    const result = await runJiraDraftBatch(input(10), h.ports);
    expect(h.fillCalls).toHaveLength(1);
    expect(result.stopReason).toBe("stage-rejection-unchanged");
    expect(result.failedRequirementRefs).toEqual(requirements(10).map((item) => item.ref));
    expect(result.progress.draftedCount).toBe(0);
    expect(stagedRefs(h)).toEqual([]);
    expect(h.stageCalls.map((call) => call.refs)).toEqual([
      ["D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9", "D10"],
      ["D1", "D2", "D3", "D4", "D5"],
    ]);
  });

  it("fails a lone issue at once, with no correction call", async () => {
    const h = harness({ stage: keikoRejects("D1") });
    const result = await runJiraDraftBatch(input(1), h.ports);
    expect(h.fillCalls).toHaveLength(1);
    expect(result.failedRequirementRefs).toEqual(["doc:R1"]);
  });

  it("sends an issue the model can still correct back to the model alone", async () => {
    let lone = 0;
    const h = harness({
      stage: (refs) => {
        if (refs.length === 3) return { kind: "rejected", guidance: "Trace.", owner: "keiko" };
        if (refs.length === 1 && refs[0] === "D3" && (lone += 1) === 1)
          return { kind: "rejected", guidance: "Summary too short.", owner: "model" };
        return undefined;
      },
    });
    const result = await runJiraDraftBatch(input(3), h.ports);
    expectComplete(result, 3, h);
    expect(h.fillCalls).toHaveLength(2);
    expect(keysOf(h.fillCalls[1] ?? [])).toEqual(["D3"]);
  });
});

describe("runJiraDraftBatch input window", () => {
  const wide = (count: number): DraftBatchRequirement[] =>
    requirements(count).map((item) => ({ ...item, text: "x".repeat(600) }));

  it("sizes pages by the prompt budget as well as by the output budget", async () => {
    const h = harness({ completionPerKey: undefined });
    const result = await runJiraDraftBatch(
      input(12, { requirements: wide(12), maxInputTokens: 1500 }),
      h.ports,
    );
    expectComplete(result, 12, h);
    expect(h.fillCalls.length).toBeGreaterThan(2);
    for (const call of h.fillCalls) expect(keysOf(call).length).toBeLessThan(6);
  });

  it("still tries one issue alone when it alone exceeds the budget", async () => {
    const h = harness({ completionPerKey: undefined });
    const result = await runJiraDraftBatch(
      input(2, { requirements: wide(2), maxInputTokens: 50 }),
      h.ports,
    );
    expectComplete(result, 2, h);
    expect(h.fillCalls).toHaveLength(2);
  });

  it("groups in chunks that fit the prompt budget", async () => {
    const h = harness();
    const result = await runJiraDraftBatch(
      input(40, { granularity: "grouped", maxInputTokens: 450 }),
      h.ports,
    );
    expect(h.outlineCalls.length).toBeGreaterThan(1);
    expect(result.progress.coveredRequirementCount).toBe(40);
    const listed = h.outlineCalls.flatMap((call) => outlineRefs(call));
    expect(new Set(listed).size).toBe(40);
  });
});

describe("runJiraDraftBatch description budget", () => {
  it("reports an issue whose criteria alone exceed the limit and drafts the others", async () => {
    const all = requirements(3);
    const huge = { ...all[1], criteria: ["y".repeat(40_000)] } as DraftBatchRequirement;
    const h = harness();
    const result = await runJiraDraftBatch(
      input(3, { requirements: [all[0], huge, all[2]] as DraftBatchRequirement[] }),
      h.ports,
    );
    expect(result.tooLargeCount).toBe(1);
    expect(result.failedRequirementRefs).toEqual(["doc:R2"]);
    expect(stagedRefs(h)).toEqual(["D1", "D3"]);
    expect(h.fillCalls.flatMap((call) => keysOf(call))).not.toContain("D2");
    expect(h.observations.some((o) => o.kind === "page" && o.outcome === "too-large")).toBe(true);
  });
});

describe("runJiraDraftBatch summaries", () => {
  it("never stages two issues with the same summary", async () => {
    const h = harness({
      fill: (keys) => ({
        kind: "text",
        text: JSON.stringify({
          items: keys.map((key) => ({
            key,
            summary: "Same\nsummary",
            sections: { Context: "c", Acceptance: "a" },
          })),
        }),
      }),
    });
    const result = await runJiraDraftBatch(input(12), h.ports);
    expectComplete(result, 12, h);
    const summaries = h.staged.map((item) => (item.fields as { summary: string }).summary);
    expect(new Set(summaries.map((text) => text.toLowerCase())).size).toBe(12);
    expect(summaries[0]).toBe("Same summary");
    expect(summaries[1]).toBe("Same summary (R2)");
  });
});

describe("runJiraDraftBatch oversized groups", () => {
  it("splits a group whose combined criteria exceed the limit into single issues", async () => {
    const big = (index: number): DraftBatchRequirement => ({
      ref: `doc:R${String(index + 1)}`,
      title: `Title ${String(index + 1)}`,
      section: "S",
      text: "Statement",
      criteria: [String(index).repeat(12_000)],
    });
    const three = [big(0), big(1), big(2)];
    const h = harness({
      outline: (refs) => ({
        kind: "text",
        text: JSON.stringify({ groups: [{ summary: "All", requirements: refs }] }),
      }),
    });
    const result = await runJiraDraftBatch(
      input(3, { requirements: three, granularity: "grouped" }),
      h.ports,
    );
    expect(result.tooLargeCount).toBe(0);
    expect(result.failedRequirementRefs).toEqual([]);
    expect(result.progress).toMatchObject({ draftedCount: 3, plannedCount: 3, failedCount: 0 });
    expect(h.staged.map((item) => item.requirementIds)).toEqual([
      ["doc:R1"],
      ["doc:R2"],
      ["doc:R3"],
    ]);
    expect(new Set(h.staged.map((item) => refOf(item))).size).toBe(3);
  });
});

const S17_GUIDANCE = "Start every summary with Corrected: and preserve its requirement key.";

function s17CorrectedAnswer(keys: readonly string[]): string {
  return JSON.stringify({
    items: keys.map((key) => ({
      key,
      summary: `Corrected: ${key}`,
      sections: { Context: `c ${key}`, Acceptance: `a ${key}` },
    })),
  });
}

function s17GuidedFill(
  keys: readonly string[],
  messages: readonly DraftBatchMessage[],
): DraftBatchGeneration {
  const corrected = messages.some((message) => message.content.includes(S17_GUIDANCE));
  return { kind: "text", text: corrected ? s17CorrectedAnswer(keys) : fillAnswer(keys) };
}

function s17CorrectedItem(item: CatalogJsonObject): boolean {
  const fields: unknown = item.fields;
  return (
    fields !== null &&
    typeof fields === "object" &&
    !Array.isArray(fields) &&
    "summary" in fields &&
    typeof fields.summary === "string" &&
    fields.summary.startsWith("Corrected: ")
  );
}

function s17Stage(items: readonly CatalogJsonObject[]): DraftBatchStageOutcome | undefined {
  if (items.every((item) => s17CorrectedItem(item))) return undefined;
  return { kind: "rejected", guidance: S17_GUIDANCE, owner: "model" };
}

function expectS17Correction(messages: readonly DraftBatchMessage[] | undefined): void {
  expect(messages?.some((message) => message.content.includes(S17_GUIDANCE))).toBe(true);
}

describe("S17 batch correction continuity", () => {
  it("carries the last stage correction into both halves after output exhaustion", async () => {
    const h = harness({
      fill: (keys, messages, call) =>
        call === 2 ? { kind: "exhausted" } : s17GuidedFill(keys, messages),
      stage: (_refs, _call, items) => s17Stage(items),
    });
    const result = await runJiraDraftBatch(input(4), h.ports);
    expectComplete(result, 4, h);
    expect(h.fillCalls.map((messages) => keysOf(messages).length)).toEqual([4, 4, 2, 2]);
    expectS17Correction(h.fillCalls[2]);
    expectS17Correction(h.fillCalls[3]);
    expect(h.stageCalls.map((call) => call.refs.length)).toEqual([4, 2, 2]);
    expect(h.staged.every((item) => s17CorrectedItem(item))).toBe(true);
  });

  it("does not spend the stage correction allowance on an earlier parse failure", async () => {
    const h = harness({
      fill: (keys, messages, call) =>
        call === 1 ? { kind: "text", text: "not json" } : s17GuidedFill(keys, messages),
      stage: (_refs, _call, items) => s17Stage(items),
    });
    const result = await runJiraDraftBatch(input(1), h.ports);
    expectComplete(result, 1, h);
    expect(h.fillCalls).toHaveLength(3);
    expect(h.stageCalls).toHaveLength(2);
    expectS17Correction(h.fillCalls[2]);
    expect(h.observations.find((observation) => observation.outcome === "staged")).toMatchObject({
      parseAttemptCount: 3,
      stageAttemptCount: 2,
    });
    expect(h.observations.some((observation) => observation.outcome === "split")).toBe(false);
  });

  it("stops with a closed reason when the corrected attempt receives the identical stage refusal", async () => {
    const h = harness({
      stage: (_refs, _call, items) => s17Stage(items),
    });
    const result = await runJiraDraftBatch(input(4), h.ports);
    expect(result.stopReason).toBe("stage-rejection-unchanged");
    expect(result.itemCount).toBe(0);
    expect(result.failedRequirementRefs).toEqual(["doc:R1", "doc:R2", "doc:R3", "doc:R4"]);
    expect(h.fillCalls).toHaveLength(2);
    expectS17Correction(h.fillCalls[1]);
    expect(h.stageCalls).toHaveLength(2);
    expect(h.staged).toEqual([]);
    expect(h.observations.some((observation) => observation.outcome === "split")).toBe(false);
    const last = h.observations.at(-1);
    expect(last).toMatchObject({
      outcome: "refused",
      parseAttemptCount: 2,
      stageAttemptCount: 2,
    });
    expect(last?.kind === "page" ? last.guidanceDigest : undefined).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("stops the first Keiko isolation after an identical rejection without visiting siblings", async () => {
    const h = harness({
      stage: () => ({ kind: "rejected", guidance: "Trace refused.", owner: "keiko" }),
    });
    const result = await runJiraDraftBatch(input(4), h.ports);
    expect(result.stopReason).toBe("stage-rejection-unchanged");
    expect(result.failedRequirementRefs).toEqual(["doc:R1", "doc:R2", "doc:R3", "doc:R4"]);
    expect(h.fillCalls).toHaveLength(1);
    expect(h.stageCalls.map((call) => call.refs)).toEqual([
      ["D1", "D2", "D3", "D4"],
      ["D1", "D2"],
    ]);
    expect(h.staged).toEqual([]);
    expect(h.observations.filter((item) => item.outcome === "split")).toHaveLength(1);
  });

  it("stops an identical rejection when its owner changes from model to Keiko", async () => {
    const h = harness({
      stage: (_refs, call) => ({
        kind: "rejected",
        guidance: S17_GUIDANCE,
        owner: call === 1 ? "model" : "keiko",
      }),
    });
    const result = await runJiraDraftBatch(input(4), h.ports);
    expect(result.stopReason).toBe("stage-rejection-unchanged");
    expect(result.failedRequirementRefs).toEqual(["doc:R1", "doc:R2", "doc:R3", "doc:R4"]);
    expect(h.fillCalls).toHaveLength(2);
    expectS17Correction(h.fillCalls[1]);
    expect(h.stageCalls).toHaveLength(2);
    expect(h.staged).toEqual([]);
    expect(h.observations.some((item) => item.outcome === "split")).toBe(false);
  });

  it("carries a model-owned singleton correction out of Keiko-owned bisection", async () => {
    const h = harness({
      fill: (keys, messages) => s17GuidedFill(keys, messages),
      stage: (refs, _call, items) => {
        if (refs.length === 3)
          return { kind: "rejected", guidance: "Trace refused.", owner: "keiko" };
        return refs.includes("D3") ? s17Stage(items) : undefined;
      },
    });
    const result = await runJiraDraftBatch(input(3), h.ports);
    expectComplete(result, 3, h);
    expect(h.fillCalls).toHaveLength(2);
    expect(keysOf(h.fillCalls[1] ?? [])).toEqual(["D3"]);
    expectS17Correction(h.fillCalls[1]);
    expect(h.stageCalls.map((call) => call.refs)).toEqual([
      ["D1", "D2", "D3"],
      ["D1", "D2"],
      ["D3"],
      ["D3"],
    ]);
    expect(
      h.observations.filter((item) => item.kind === "page" && item.outcome === "refused"),
    ).toEqual([
      expect.objectContaining({ itemCount: 3, parseAttemptCount: 1, stageAttemptCount: 1 }),
      expect.objectContaining({ itemCount: 1, parseAttemptCount: 0, stageAttemptCount: 1 }),
    ]);
    expect(
      h.staged.filter((item) => refOf(item) === "D3").every((item) => s17CorrectedItem(item)),
    ).toBe(true);
  });
});
