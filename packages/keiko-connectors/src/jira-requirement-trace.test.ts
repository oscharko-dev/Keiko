import { describe, expect, it } from "vitest";
import type { JiraFieldMetadata } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  descriptionWithFooter,
  traceCreateFields,
  traceEditArguments,
  type JiraTraceOutcome,
  type JiraTraceRequest,
} from "./jira-requirement-trace.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { parseJiraDraft } from "./jira-draft.js";

const START = "----\nKeiko traceability";
const END = "End of Keiko traceability";
const FOOTER = `${START}\nRequirement: LH-001 · Anmeldung\n${END}`;

function field(id: string, operations: readonly string[]): JiraFieldMetadata {
  return {
    id,
    name: id,
    required: false,
    hasDefaultValue: false,
    kind: "text",
    richText: false,
    operations: operations as JiraFieldMetadata["operations"],
  };
}

function trace(report?: (outcome: JiraTraceOutcome) => void): JiraTraceRequest {
  return {
    labels: [
      "keiko-requirement",
      "keiko-doc-aaaaaaaa",
      "keiko-req-LH-001",
      "keiko-rev-bbbbbbbbbbbb",
    ],
    footer: FOOTER,
    footerStart: START,
    footerEnd: END,
    replaceLabelPrefixes: ["keiko-rev-"],
    ...(report === undefined ? {} : { report }),
  };
}

describe("descriptionWithFooter", () => {
  it("appends the footer, and replaces an earlier footer in place", () => {
    expect(descriptionWithFooter("Ziel", trace())).toBe(`Ziel\n\n${FOOTER}`);
    expect(descriptionWithFooter(undefined, trace())).toBe(FOOTER);
    expect(descriptionWithFooter(`Ziel\n\n${START}\nRequirement: OLD\n${END}`, trace())).toBe(
      `Ziel\n\n${FOOTER}`,
    );
  });

  it("keeps the text on both sides of the earlier footer and is stable on a repeat", () => {
    const once = descriptionWithFooter(
      `Vorher\r\n\r\n${START}\nRequirement: OLD\n${END}\n\nNachher`,
      trace(),
    );

    expect(once).toBe(`Vorher\n\n${FOOTER}\n\nNachher`);
    expect(descriptionWithFooter(once, trace())).toBe(once);
  });

  it("does not treat a footer start without its end line as an owned block", () => {
    const text = `Ziel\n\n${START}\nvon Hand`;

    expect(descriptionWithFooter(text, trace())).toBe(`${text}\n\n${FOOTER}`);
  });
});

describe("traceCreateFields (#4179 review, defect 9)", () => {
  it("applies the labels and footer the create screen offers and reports it", () => {
    const outcomes: JiraTraceOutcome[] = [];

    const fields = traceCreateFields(
      { summary: "s", description: "Ziel", labels: ["x"] },
      [field("labels", ["set"]), field("description", ["set"])],
      trace((outcome) => outcomes.push(outcome)),
    );

    expect(fields.labels).toEqual(["x", ...trace().labels]);
    expect(fields.description).toBe(`Ziel\n\n${FOOTER}`);
    expect(outcomes).toEqual([{ labelsApplied: true, footerApplied: true, droppedLabels: [] }]);
  });

  it("names the dropped labels instead of counting them as traced", () => {
    const outcomes: JiraTraceOutcome[] = [];

    const fields = traceCreateFields(
      { summary: "s" },
      [field("description", ["set"])],
      trace((outcome) => outcomes.push(outcome)),
    );

    expect(fields).not.toHaveProperty("labels");
    expect(outcomes).toEqual([
      { labelsApplied: false, footerApplied: true, droppedLabels: trace().labels },
    ]);
  });

  it("reports a skipped footer when the screen has no description or it is not plain text", () => {
    const outcomes: JiraTraceOutcome[] = [];
    const report = (outcome: JiraTraceOutcome): void => {
      outcomes.push(outcome);
    };

    traceCreateFields({ summary: "s" }, [field("labels", ["set"])], trace(report));
    const kept = traceCreateFields(
      { summary: "s", description: { type: "doc" } },
      [field("labels", ["set"]), field("description", ["set"])],
      trace(report),
    );

    expect(outcomes.map((outcome) => outcome.footerApplied)).toEqual([false, false]);
    expect(kept.description).toEqual({ type: "doc" });
  });

  it("changes nothing on a repeated run", () => {
    const metadata = [field("labels", ["set"]), field("description", ["set"])];
    const once = traceCreateFields({ summary: "s", description: "Ziel" }, metadata, trace());

    expect(traceCreateFields(once, metadata, trace())).toEqual(once);
  });
});

describe("traceEditArguments", () => {
  function request(labels: readonly string[], description: unknown): JiraMutationRequest {
    return (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        body: { key: "SYN-1", id: "10001", fields: { labels, description } },
      })) as unknown as JiraMutationRequest;
  }
  const METADATA = [field("labels", ["add", "remove"]), field("description", ["set"])];

  it("replaces the outdated revision label and rewrites the footer in place", async () => {
    const outcomes: JiraTraceOutcome[] = [];
    const prior = ["keiko-requirement", "keiko-req-LH-001", "keiko-rev-oldoldoldold", "mine"];

    const traced = await traceEditArguments(
      request(prior, `Ziel\n\n${START}\nRequirement: OLD\n${END}`),
      "SYN-1",
      { issueKey: "SYN-1", fields: { summary: "neu" } },
      METADATA,
      trace((outcome) => outcomes.push(outcome)),
    );

    if (!traced.ok) throw new Error("expected traced arguments");
    expect(traced.args.updates).toEqual([
      { fieldId: "labels", operation: "remove", value: "keiko-rev-oldoldoldold" },
      { fieldId: "labels", operation: "add", value: "keiko-doc-aaaaaaaa" },
      { fieldId: "labels", operation: "add", value: "keiko-rev-bbbbbbbbbbbb" },
    ]);
    expect(traced.args.fields).toEqual({ summary: "neu", description: `Ziel\n\n${FOOTER}` });
    expect(outcomes).toEqual([{ labelsApplied: true, footerApplied: true, droppedLabels: [] }]);
  });

  it("reports labels the edit screen cannot take", async () => {
    const outcomes: JiraTraceOutcome[] = [];

    const traced = await traceEditArguments(
      request([], null),
      "SYN-1",
      { issueKey: "SYN-1", fields: { summary: "neu" } },
      [field("description", ["set"])],
      trace((outcome) => outcomes.push(outcome)),
    );

    expect(traced.ok && traced.args.updates).toBeUndefined();
    expect(outcomes[0]).toMatchObject({ labelsApplied: false, droppedLabels: trace().labels });
  });

  it("surfaces a failed read of the issue instead of editing blind", async () => {
    const failing = (() =>
      Promise.resolve({ ok: false, reason: "not-found" })) as unknown as JiraMutationRequest;

    const traced = await traceEditArguments(
      failing,
      "SYN-1",
      { issueKey: "SYN-1" },
      METADATA,
      trace(),
    );

    expect(traced).toMatchObject({ ok: false, attempt: { ok: false } });
  });
});

describe("draft items name their requirements explicitly", () => {
  const item = (extra: Record<string, unknown>): Record<string, unknown> => ({
    ref: "epic",
    projectId: "10000",
    issueTypeId: "10001",
    fields: { summary: "[LH-001] Anmeldung" },
    ...extra,
  });

  it("accepts a bounded list of reference strings", () => {
    const parsed = parseJiraDraft({
      items: [item({ requirementIds: ["a1b2c3d4:LH-001", "LH-002/AC1"] })],
    });

    expect(parsed?.items[0]?.requirementIds).toEqual(["a1b2c3d4:LH-001", "LH-002/AC1"]);
  });

  it.each([
    ["an empty list", []],
    ["a non-string", [1]],
    ["a hostile string", ["LH-001; DROP"]],
    ["too many", Array.from({ length: 9 }, () => "LH-001")],
    ["a non-array", "LH-001"],
  ])("refuses %s", (_name, requirementIds) => {
    expect(parseJiraDraft({ items: [item({ requirementIds })] })).toBeUndefined();
  });
});
