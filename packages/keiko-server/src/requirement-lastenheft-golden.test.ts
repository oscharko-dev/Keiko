// Golden proof of the Knowledge Pod requirement read and of the Jira draft batch over a large,
// nested German Lastenheft (Epic #4173). The specification and its manifest live under
// tests/fixtures/requirements/lastenheft-kundenportal and are written by the fixture generator; the
// Pod holds the Markdown text, `collectRequirementUnits` reads it as a Chat does, and every unit it
// returns is drafted through `runJiraDraftBatch` with a fake model, per requirement and grouped.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatToolBatchProgress } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { requirementReference } from "@oscharko-dev/keiko-quality-intelligence";

import { podFixture, type PodFixture } from "./_requirementSupport.js";
import {
  runJiraDraftBatch,
  type DraftBatchInput,
  type DraftBatchPorts,
  type DraftBatchResult,
} from "./atlassian/jiraDraftBatch.js";
import type { DraftBatchMessage, DraftBatchRequirement } from "./atlassian/jiraDraftBatchPrompt.js";
import { openKnowledgeStoreForDeps } from "./local-knowledge-store-open.js";
import {
  chatKnowledgeScopes,
  collectRequirementUnits,
  resetRequirementTurnCache,
  type LocatedRequirementUnit,
  type RequirementCollection,
} from "./requirement-inventory.js";

interface ManifestRequirement {
  readonly id: string;
  readonly title: string;
  readonly priority: string;
  readonly statement: string;
  readonly acceptanceCriteria: readonly string[];
}

interface Manifest {
  readonly requirementCount: number;
  readonly statementClipChars: number;
  readonly requirements: readonly ManifestRequirement[];
}

const FIXTURE_DIRECTORY = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../tests/fixtures/requirements/lastenheft-kundenportal",
);
const manifest = JSON.parse(
  readFileSync(join(FIXTURE_DIRECTORY, "manifest.json"), "utf8"),
) as Manifest;
const markdown = readFileSync(
  join(FIXTURE_DIRECTORY, "lastenheft-kundenportal-zahlungsverkehr.md"),
  "utf8",
);

const fixtures: PodFixture[] = [];

beforeEach(() => {
  resetRequirementTurnCache();
});
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

/** The collection a Chat with the Lastenheft Pod reads, exactly as the requirement tools do. */
async function collect(): Promise<RequirementCollection> {
  const pod = await podFixture([
    { capsuleId: "pod-lastenheft", text: markdown, name: "lastenheft-kundenportal.md" },
  ]);
  fixtures.push(pod);
  const chat = pod.deps.store.findChatById(pod.chatId);
  const session = openKnowledgeStoreForDeps(pod.deps, { recover: false });
  try {
    return collectRequirementUnits(session.store, chatKnowledgeScopes(chat));
  } finally {
    session.close();
  }
}

function explicitUnits(collection: RequirementCollection): readonly LocatedRequirementUnit[] {
  return collection.units.filter(({ entry }) => entry.idOrigin === "explicit");
}

describe("golden Lastenheft: Knowledge Pod requirement read", () => {
  it("reads every requirement of the specification once, without cutting anything", async () => {
    const collection = await collect();
    const explicit = explicitUnits(collection);
    const wanted = new Set(manifest.requirements.map(({ id }) => id));

    expect(collection.refusals).toEqual([]);
    expect(collection.cutReasons).toEqual([]);
    expect(collection.unitsOmitted).toBe(0);
    expect(collection.documentsNotExtracted).toBe(0);
    expect(collection.documentsScanned).toBe(1);
    expect(collection.documents).toHaveLength(1);

    const ids = explicit.map(({ entry }) => entry.id);
    expect(new Set(ids).size, "an identifier was read twice").toBe(ids.length);
    expect(ids.filter((id) => !wanted.has(id))).toEqual([]);
    expect([...wanted].filter((id) => !ids.includes(id))).toEqual([]);
    expect(ids).toHaveLength(manifest.requirementCount);
    // Nothing else becomes a unit: no derived requirement from a legend, a field line or a table.
    expect(collection.units).toHaveLength(manifest.requirementCount);
    expect(collection.conflictingIds, "an identifier was defined twice with other content").toEqual(
      [],
    );
    expect(collection.units.filter(({ conflicting }) => conflicting === true)).toEqual([]);
    expect(collection.documents[0]?.unitCount).toBe(collection.units.length);
  });

  it("reads the full statement, priority and criteria of every requirement", async () => {
    const collection = await collect();
    const byId = new Map(explicitUnits(collection).map(({ entry }) => [entry.id, entry]));
    const clipped = (statement: string): string => statement.slice(0, manifest.statementClipChars);

    for (const requirement of manifest.requirements) {
      const entry = byId.get(requirement.id);
      expect(entry?.statement, `${requirement.id} statement`).toBe(clipped(requirement.statement));
      expect(entry?.priority, `${requirement.id} priority`).toBe(requirement.priority);
      expect(
        entry?.acceptanceCriteria.map(({ text }) => text),
        `${requirement.id} criteria`,
      ).toEqual(requirement.acceptanceCriteria);
    }
  });

  it("reads each requirement with its title and its reference in the document scope", async () => {
    const collection = await collect();
    const byId = new Map(explicitUnits(collection).map(({ entry }) => [entry.id, entry]));

    for (const { id, title } of manifest.requirements) {
      const entry = byId.get(id);
      expect(entry?.title, id).toBe(title);
      expect(entry === undefined ? "" : requirementReference(entry), id).toBe(
        `${entry?.documentScope ?? ""}:${id}`,
      );
    }
  });
});

// ─── Jira draft batch over every collected unit ──────────────────────────────────────────────

const SECTIONS = ["Context", "Acceptance"];

function draftRequirements(units: readonly LocatedRequirementUnit[]): DraftBatchRequirement[] {
  // Mirrors collectRequirements() of the Jira draft batch tool without redaction or clipping.
  return units.map(({ entry }) => ({
    ref: requirementReference(entry),
    title: entry.title,
    section: entry.sectionPath.join(" > "),
    text: [
      entry.statement,
      ...entry.acceptanceCriteria.map((item) => `- ${item.id}: ${item.text}`),
    ].join("\n"),
    criteria: entry.acceptanceCriteria.map((item) => item.text),
  }));
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

function refOf(item: CatalogJsonObject): string {
  const { ref } = item;
  if (typeof ref !== "string") throw new TypeError("staged item without ref");
  return ref;
}

interface Harness {
  readonly ports: DraftBatchPorts;
  readonly fillCalls: DraftBatchMessage[][];
  readonly outlineCalls: DraftBatchMessage[][];
  readonly staged: CatalogJsonObject[];
  readonly progress: ChatToolBatchProgress[];
}

/** A fake model that drafts what it is asked for and groups the outline in fixed sizes. */
function harness(groupSize: number): Harness {
  const h: Harness = {
    fillCalls: [],
    outlineCalls: [],
    staged: [],
    progress: [],
    ports: undefined as never,
  };
  let pageCount = 0;
  const ports: DraftBatchPorts = {
    generate: (messages, purpose) => {
      if (purpose === "outline") {
        h.outlineCalls.push([...messages]);
        const refs = outlineRefs(messages);
        const groups: { summary: string; requirements: string[] }[] = [];
        for (let at = 0; at < refs.length; at += groupSize)
          groups.push({
            summary: `Group ${String(groups.length + 1)}`,
            requirements: refs.slice(at, at + groupSize),
          });
        return Promise.resolve({
          kind: "text",
          text: JSON.stringify({ groups }),
          completionTokens: 50,
        });
      }
      h.fillCalls.push([...messages]);
      const keys = keysOf(messages);
      const items = keys.map((key) => ({
        key,
        summary: `Summary ${key}`,
        sections: { Context: `c ${key}`, Acceptance: `a ${key}` },
      }));
      return Promise.resolve({
        kind: "text",
        text: JSON.stringify({ items }),
        completionTokens: keys.length * 100,
      });
    },
    stage: (items) => {
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
    observe: () => undefined,
    signal: new AbortController().signal,
  };
  return { ...h, ports };
}

function batchInput(
  requirements: readonly DraftBatchRequirement[],
  granularity: DraftBatchInput["granularity"],
): DraftBatchInput {
  return {
    requirements,
    granularity,
    instructions: { rules: "{}", requiredSections: SECTIONS, requiredFields: [] },
    placement: {
      projectId: "P1",
      issueTypeId: "T1",
      requiredLabels: ["keiko"],
      parent: { key: "EPIC-1" },
    },
    maxOutputTokens: 8192,
    refPrefix: "D",
  };
}

function coveredRefs(h: Harness): string[] {
  return h.staged.flatMap((item) => item.requirementIds as string[]);
}

function expectEveryRequirementCoveredOnce(
  result: DraftBatchResult,
  requirements: readonly DraftBatchRequirement[],
  h: Harness,
): void {
  const refs = requirements.map(({ ref }) => ref);
  expect(result.progress).toMatchObject({
    phase: "complete",
    coveredRequirementCount: refs.length,
    requirementCount: refs.length,
    failedCount: 0,
  });
  expect(result.failedRequirementRefs).toEqual([]);
  expect(result.stopReason).toBeUndefined();
  expect(coveredRefs(h).sort()).toEqual([...refs].sort());
  expect(new Set(coveredRefs(h)).size, "a requirement was covered twice").toBe(refs.length);
  expect(new Set(h.staged.map(refOf)).size, "a draft ref was used twice").toBe(h.staged.length);
}

describe("golden Lastenheft: Jira draft batch", () => {
  it("drafts every requirement of the Pod once per requirement", async () => {
    const collection = await collect();
    const requirements = draftRequirements(collection.units);
    const h = harness(4);

    const result = await runJiraDraftBatch(batchInput(requirements, "per-requirement"), h.ports);

    expect(requirements).toHaveLength(manifest.requirementCount);
    expectEveryRequirementCoveredOnce(result, requirements, h);
    expect(result.itemCount).toBe(requirements.length);
    expect(h.staged).toHaveLength(requirements.length);
    expect(h.outlineCalls).toHaveLength(0);
    // Pages, not one call per issue; the batch is sized from the 8192-token output budget.
    expect(h.fillCalls.length).toBeGreaterThan(1);
    expect(h.fillCalls.length).toBeLessThan(requirements.length / 4);
    const manifestRefs = new Set(
      collection.units
        .filter(({ entry }) => manifest.requirements.some(({ id }) => id === entry.id))
        .map(({ entry }) => requirementReference(entry)),
    );
    expect(manifestRefs.size).toBe(manifest.requirementCount);
    for (const ref of manifestRefs) expect(coveredRefs(h)).toContain(ref);
  });

  it("drafts exactly the manifest's requirements when they are selected by identifier", async () => {
    const collection = await collect();
    const wanted = new Set(manifest.requirements.map(({ id }) => id));
    const selected = collection.units.filter(({ entry }) => wanted.has(entry.id));
    const requirements = draftRequirements(selected);
    const h = harness(4);

    const result = await runJiraDraftBatch(batchInput(requirements, "per-requirement"), h.ports);

    expect(requirements).toHaveLength(manifest.requirementCount);
    expectEveryRequirementCoveredOnce(result, requirements, h);
    expect(result.progress.coveredRequirementCount).toBe(manifest.requirementCount);
  });

  it("drafts every requirement of the Pod once in grouped issues", async () => {
    const collection = await collect();
    const requirements = draftRequirements(collection.units);
    const h = harness(4);

    const result = await runJiraDraftBatch(batchInput(requirements, "grouped"), h.ports);

    expectEveryRequirementCoveredOnce(result, requirements, h);
    expect(h.outlineCalls.length).toBeGreaterThanOrEqual(1);
    expect(result.progress.plannedCount).toBe(Math.ceil(requirements.length / 4));
    expect(result.itemCount).toBe(Math.ceil(requirements.length / 4));
  });
});
