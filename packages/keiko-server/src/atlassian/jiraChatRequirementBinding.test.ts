import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJiraDraftStore } from "@oscharko-dev/keiko-connectors";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import { podFixture, specification, type PodFixture } from "../_requirementSupport.js";
import { openTraceSession } from "../requirement-trace.js";
import { createServerLogger, setServerLogger } from "../observability/index.js";
import { resetServerLogger } from "../../../../tests/support/activity-log-test-support.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  formatActivityLogProofLine,
  expectActivityLogProof,
} from "../../../../tests/support/activity-log-proof.js";
import {
  createJiraChatSourcePreparation,
  prepareJiraDraftRequirements,
  type JiraChatSourcePreparation,
} from "./jiraChatRequirementBinding.js";

const fixtures: PodFixture[] = [];
let sink = createBufferedServerLogSink();
beforeEach(() => {
  sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
});
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
  resetServerLogger();
});
const description = {
  format: "markdown",
  text: "## Criteria\n- Thema 1 ist verfügbar.\n- Fehler zu Thema 1 werden gemeldet.",
};
const item = {
  ref: "one",
  projectId: "10000",
  issueTypeId: "10001",
  fields: { summary: "Synthetic", description },
  requirementIds: ["LH-001"],
};

async function fixture(): Promise<{
  source: PodFixture;
  draftStore: ReturnType<typeof createJiraDraftStore>;
  openTrace: ReturnType<typeof vi.fn<() => ReturnType<typeof openTraceSession>>>;
  prepared: JiraChatSourcePreparation;
  changeSource: () => void;
}> {
  const source = await podFixture([
    { capsuleId: "source-binding", text: specification(1).text, name: "original.md" },
  ]);
  fixtures.push(source);
  const draftStore = createJiraDraftStore();
  // One connection for the fixture: a staged draft resolves under the fingerprint it was stored with.
  draftStore.bindConnection(() => "connection");
  const openTrace = vi.fn(() => {
    const session = openTraceSession(source.deps, {
      chatId: source.chatId,
      userMessageId: "binding-turn",
      correlationId: "binding-proof",
    });
    vi.spyOn(session, "resolve");
    return session;
  });
  const prepared = createJiraChatSourcePreparation({
    chatId: source.chatId,
    draftStore,
    openTrace,
    admitted: () => true,
    correlationId: "binding-proof",
  });
  const changeSource = (): void => {
    source.withStore((store) => {
      store._internal.db
        .prepare("UPDATE documents SET safe_display_name = ? WHERE capsule_id = ?")
        .run("revised.md", "source-binding");
      store._internal.db
        .prepare("UPDATE capsules SET updated_at = updated_at + 1000 WHERE id = ?")
        .run("source-binding");
    });
  };
  return { source, draftStore, openTrace, prepared, changeSource };
}

describe("Jira source payload captured before review", () => {
  it("rechecks only the dispatched draft item, with linear resolution work and no stale cache", async () => {
    const f = await fixture();
    const items = Array.from({ length: 16 }, (_, index) => ({
      ...item,
      ref: `item-${String(index)}`,
    }));
    const args = { items };
    await f.prepared.prepareInvocation(
      { id: "linear", name: "jira_draft", arguments: args },
      "linear",
    );
    const held = f.prepared.sourceFor("linear", sha256Hex(canonicalise(args)));
    if (held === undefined) throw new TypeError("Expected traced draft");
    for (const candidate of items) expect(f.prepared.current(held, candidate.ref)).toBe(true);
    expect(f.openTrace).toHaveBeenCalledTimes(items.length + 1);
    const resolutions = f.openTrace.mock.results.reduce(
      (total, result) =>
        total + (result.type === "return" ? vi.mocked(result.value.resolve).mock.calls.length : 0),
      0,
    );
    expect(resolutions).toBe(items.length * 2);
    f.changeSource();
    expect(f.prepared.current(held, items[0]?.ref)).toBe(false);
    const event = sink.events.find((event) => event.op === "knowledge.requirement-trace.applied");
    const line = expectActivityLogProof(
      "knowledge.requirement-trace.applied.line",
      formatActivityLogProofLine(event ?? {}),
    );
    expect(line).toMatchObject({
      sourceRefusal: "source-changed",
      sourceChangedCount: 1,
      refusedItemCount: 1,
      unavailable: false,
    });
    expect(JSON.stringify(line)).not.toMatch(/original|revised|LH-001|source-binding/u);
  });

  it("does not open Knowledge for an untraced sibling and refuses an unknown draft ref", async () => {
    const f = await fixture();
    const args = { items: [item, { ref: "untraced", fields: { summary: "Manual" } }] };
    await f.prepared.prepareInvocation(
      { id: "mixed", name: "jira_draft", arguments: args },
      "mixed",
    );
    const held = f.prepared.sourceFor("mixed", sha256Hex(canonicalise(args)));
    if (held === undefined) throw new TypeError("Expected traced draft");
    f.openTrace.mockClear();
    expect(f.prepared.current(held, "untraced")).toBe(true);
    expect(f.prepared.current(held, "not-in-the-approved-draft")).toBe(false);
    expect(f.openTrace).not.toHaveBeenCalled();
  });
  it.each(["jira_create", "jira_edit"])(
    "binds %s exactly once and refuses a changed source before effects",
    async (name) => {
      const f = await fixture();
      const call = { id: "call-one", name, arguments: item };
      const argumentsDigest = sha256Hex(canonicalise(call.arguments));
      const first = await f.prepared.prepareInvocation(call, "action-one");
      const held = f.prepared.sourceFor("action-one", argumentsDigest);
      expect(held).toBeDefined();
      if (held === undefined) throw new TypeError("Expected prepared source");
      expect(first?.sourceDigest).toMatch(/^[0-9a-f]{64}$/u);
      const fields = held.items[0]?.item.fields as Record<string, unknown>;
      expect(fields.description).toContain("Source: original.md");
      expect(fields.labels).toContain("keiko-requirement");
      expect(f.prepared.current(held)).toBe(true);
      f.changeSource();
      expect(f.prepared.current(held)).toBe(false);
      expect(await f.prepared.prepareInvocation(call, "action-one")).toEqual(first);
      expect(f.prepared.sourceFor("action-one", argumentsDigest)).toBe(held);
      expect(fields.description).toContain("Source: original.md");
      expect(Object.isFrozen(held.items[0]?.item.fields)).toBe(true);
    },
  );

  it("leaves untraced writes and numeric prose citations untouched without opening Knowledge", async () => {
    const f = await fixture();
    for (const name of [
      "jira_create",
      "jira_edit",
      "jira_draft",
      "jira_comment",
      "jira_assign",
      "jira_attach",
      "jira_transition",
    ]) {
      const args =
        name === "jira_draft"
          ? { items: [{ fields: { description: "Source [1]" } }] }
          : { fields: { description: "Source [1]" } };
      expect(
        await f.prepared.prepareInvocation({ id: name, name, arguments: args }, name),
      ).toBeUndefined();
      expect(f.prepared.refusalFor(name, sha256Hex(canonicalise(args)))).toBeUndefined();
    }
    expect(f.openTrace).not.toHaveBeenCalled();
  });

  it("stages canonical footer and labels before the digest and refuses changed or unbound drafts", async () => {
    const f = await fixture();
    const page = prepareJiraDraftRequirements([item], f.openTrace);
    expect(page.ok).toBe(true);
    if (!page.ok) throw new TypeError("Expected prepared page");
    const stored = f.draftStore.append(
      f.source.chatId,
      undefined,
      "connection",
      page.items,
      page.sourceBindings,
    );
    expect(stored.ok).toBe(true);
    if (!stored.ok) throw new TypeError("Expected staged draft");
    const args = { draftId: stored.draft.id, draftDigest: stored.draft.digest };
    const first = await f.prepared.prepareInvocation(
      { id: "draft", name: "jira_draft", arguments: args },
      "draft",
    );
    expect(first?.sourceDigest).toMatch(/^[0-9a-f]{64}$/u);
    const source = f.prepared.sourceFor("draft", sha256Hex(canonicalise(args)));
    expect(source).toBeDefined();
    if (source === undefined) throw new TypeError("Expected bound draft source");
    expect(f.prepared.current(source)).toBe(true);
    expect(
      (page.items[0]?.fields as { description: string }).description.match(/Keiko traceability/gu),
    ).toHaveLength(2);
    f.changeSource();
    expect(
      await f.prepared.prepareInvocation(
        { id: "changed", name: "jira_draft", arguments: args },
        "changed",
      ),
    ).toBeUndefined();
    expect(f.prepared.refusalFor("changed", sha256Hex(canonicalise(args)))).toMatchObject({
      requirementRefusal: "source-changed",
    });
    const legacy = f.draftStore.append(f.source.chatId, undefined, "connection", [item]);
    if (!legacy.ok) throw new TypeError("Expected legacy draft");
    const legacyArgs = { draftId: legacy.draft.id, draftDigest: legacy.draft.digest };
    expect(
      await f.prepared.prepareInvocation(
        { id: "legacy", name: "jira_draft", arguments: legacyArgs },
        "legacy",
      ),
    ).toBeUndefined();
    expect(f.prepared.refusalFor("legacy", sha256Hex(canonicalise(legacyArgs)))).toMatchObject({
      requirementRefusal: "unavailable",
    });
  });

  it("binds the same digest when an item whose criteria Keiko completed is prepared again", async () => {
    const f = await fixture();
    const bare = {
      ...item,
      fields: { summary: "Synthetic", description: { format: "markdown", text: "## Ziel\nKurz." } },
    };
    const first = prepareJiraDraftRequirements([bare], f.openTrace);
    if (!first.ok) throw new TypeError("Expected the first preparation to complete the criteria");
    const completed = first.items[0];
    expect((completed?.fields as { description: string }).description).toContain(
      "Thema 1 ist verfügbar.",
    );
    const again = prepareJiraDraftRequirements([completed ?? bare], f.openTrace);
    if (!again.ok) throw new TypeError("Expected the prepared item to prepare again");
    expect(again.sourceBindings).toEqual(first.sourceBindings);
    expect(again.items).toEqual(first.items);
  });
});
