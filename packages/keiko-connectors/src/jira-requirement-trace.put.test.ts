// #4179 review: a traced Jira edit writes exactly what the human and the trace each own. The
// connector runs against a synthetic Jira that records the outgoing PUT, so the assertions are on
// what would have reached the instance, not on an intermediate argument object.
import { describe, expect, it, vi } from "vitest";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import { executeJiraManagedMutation } from "./jira-managed-mutations.js";
import type { JiraTraceOutcome, JiraTraceRequest } from "./jira-requirement-trace.js";
import { field, response } from "../../../tests/support/jira-managed-remote.js";

const START = "----\nKeiko traceability";
const END = "End of Keiko traceability";
const block = (name: string): string => `${START}\nRequirement: ${name}\n${END}`;
const TRACE_LABELS = ["keiko-requirement", "keiko-doc-aaaaaaaa", "keiko-rev-bbbbbbbbbbbb"];

function trace(report?: (outcome: JiraTraceOutcome) => void): JiraTraceRequest {
  return {
    labels: TRACE_LABELS,
    footer: block("NEW"),
    footerStart: START,
    footerEnd: END,
    replaceLabelPrefixes: ["keiko-rev-"],
    ...(report === undefined ? {} : { report }),
  };
}

interface Stored {
  fields: Record<string, unknown>;
}

function jira(
  stored: Stored,
  options: { readonly hide?: readonly string[] } = {},
): {
  readonly http: ReturnType<typeof vi.fn<AtlassianHttpBodyPort>>;
  readonly puts: () => readonly Record<string, unknown>[];
  readonly edit: (
    args: Record<string, unknown>,
    request: JiraTraceRequest,
  ) => ReturnType<typeof executeJiraManagedMutation>;
} {
  const http = vi.fn<AtlassianHttpBodyPort>((request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "PUT") {
      const body = JSON.parse(request.bodyJson ?? "{}") as {
        fields?: Record<string, unknown>;
        update?: { labels?: Record<string, string>[] };
      };
      stored.fields = { ...stored.fields, ...body.fields };
      const labels = new Set(stored.fields.labels as readonly string[]);
      for (const item of body.update?.labels ?? []) {
        if (item.add !== undefined) labels.add(item.add);
        if (item.remove !== undefined) labels.delete(item.remove);
      }
      stored.fields.labels = [...labels];
      return Promise.resolve(response(undefined, 204));
    }
    if (path.endsWith("editmeta"))
      return Promise.resolve(
        response({
          fields: {
            summary: field("summary", "string"),
            description: field("description", "string"),
            labels: {
              ...field("labels", "array"),
              operations: ["set", "add", "remove"],
              schema: { type: "array", items: "string", system: "labels" },
            },
          },
        }),
      );
    const visible = Object.fromEntries(
      Object.entries(stored.fields).filter(([key]) => options.hide?.includes(key) !== true),
    );
    return Promise.resolve(response({ id: "10001", key: "SYN-1", fields: visible }));
  });
  return {
    http,
    puts: () =>
      http.mock.calls
        .filter(([request]) => request.method === "PUT")
        .map(([request]) => JSON.parse(request.bodyJson ?? "{}") as Record<string, unknown>),
    edit: (args, request) =>
      executeJiraManagedMutation(
        "jira.edit",
        { issueKey: "SYN-1", ...args },
        {
          invocationId: "synthetic",
          correlationId: "synthetic",
          signal: new AbortController().signal,
          beforeEffect: () => true,
        },
        { deployment: "data-center", baseUrl: "https://jira.example.invalid/context", http },
        request,
      ),
  };
}

describe("human description text survives a traced edit (#4179 review)", () => {
  it("keeps the paragraphs written before and after the earlier footer on a summary-only edit", async () => {
    const before = "Ziel des Epics.";
    const after = "Meine Notizen nach dem Footer.\n\nZweiter Absatz.";
    const stored: Stored = {
      fields: {
        summary: "alt",
        labels: ["mine"],
        description: `${before}\n\n${block("OLD")}\n\n${after}`,
      },
    };
    const remote = jira(stored);

    const result = await remote.edit({ fields: { summary: "neu" } }, trace());

    expect(result.ok).toBe(true);
    expect(remote.puts()).toHaveLength(1);
    expect(remote.puts()[0]).toMatchObject({
      fields: { summary: "neu", description: `${before}\n\n${block("NEW")}\n\n${after}` },
    });
    expect(stored.fields.description).toContain(after);
    expect(stored.fields.description).not.toContain("Requirement: OLD");
  });

  it("leaves a footer start without its end line alone and appends a complete block", async () => {
    const half = `Ziel\n\n${START}\nvon Hand geschrieben, ohne Ende`;
    const stored: Stored = { fields: { summary: "alt", labels: [], description: half } };
    const remote = jira(stored);

    await remote.edit({ fields: { summary: "neu" } }, trace());

    expect(remote.puts()[0]).toMatchObject({
      fields: { description: `${half}\n\n${block("NEW")}` },
    });
  });

  it.each([["omitted by the read", { hide: ["description"] }]])(
    "does not replace a description that was %s",
    async (_name, options) => {
      const stored: Stored = { fields: { summary: "alt", labels: [], description: "Echter Text" } };
      const remote = jira(stored, options);
      const outcomes: JiraTraceOutcome[] = [];

      const result = await remote.edit(
        { fields: { summary: "neu" } },
        trace((outcome) => outcomes.push(outcome)),
      );

      expect(result.ok).toBe(true);
      expect(remote.puts()[0]?.fields).toEqual({ summary: "neu" });
      expect(stored.fields.description).toBe("Echter Text");
      expect(outcomes[0]).toMatchObject({ footerApplied: false });
    },
  );

  it("writes the footer alone only over a description the read states empty", async () => {
    const stored: Stored = { fields: { summary: "alt", labels: [], description: null } };
    const remote = jira(stored);

    await remote.edit({ fields: { summary: "neu" } }, trace());

    expect(remote.puts()[0]).toMatchObject({ fields: { description: block("NEW") } });
  });

  it("keeps a plain-text description plain and refuses to rewrite a structured one", async () => {
    const structured: Stored = {
      fields: { summary: "alt", labels: [], description: { type: "doc", version: 1 } },
    };
    const remote = jira(structured);
    const outcomes: JiraTraceOutcome[] = [];

    await remote.edit(
      { fields: { summary: "neu" } },
      trace((outcome) => outcomes.push(outcome)),
    );

    expect(remote.puts()[0]?.fields).toEqual({ summary: "neu" });
    expect(outcomes[0]).toMatchObject({ footerApplied: false });
  });
});

describe("the caller's label intent and the trace are one legal mutation (#4179 review)", () => {
  const OLD_REV = "keiko-rev-oldoldoldold";

  it("combines a replacement label set with the trace, replacing an outdated revision", async () => {
    const stored: Stored = {
      fields: { summary: "alt", labels: ["mine", "keiko-requirement", OLD_REV], description: "" },
    };
    const remote = jira(stored);
    const outcomes: JiraTraceOutcome[] = [];

    const result = await remote.edit(
      { fields: { labels: ["human-label", OLD_REV] } },
      trace((outcome) => outcomes.push(outcome)),
    );

    expect(result.ok).toBe(true);
    expect(remote.puts()[0]).toMatchObject({
      fields: { labels: ["human-label", ...TRACE_LABELS] },
    });
    expect(remote.puts()[0]?.update ?? {}).toEqual({});
    expect(outcomes[0]).toMatchObject({ labelsApplied: true, droppedLabels: [] });
  });

  it("does not remove the trace labels a replacement set leaves out when they are already present", async () => {
    const stored: Stored = {
      fields: { summary: "alt", labels: ["mine", ...TRACE_LABELS], description: "" },
    };
    const remote = jira(stored);

    const result = await remote.edit({ fields: { labels: ["human-label"] } }, trace());

    expect(result.ok).toBe(true);
    expect([...(stored.fields.labels as string[])].sort()).toEqual(
      ["human-label", ...TRACE_LABELS].sort(),
    );
  });

  it.each([
    ["absent", ["mine"]],
    ["present", ["mine", ...TRACE_LABELS]],
  ])("adds the caller's label next to a trace that is %s", async (_name, current) => {
    const stored: Stored = { fields: { summary: "alt", labels: current, description: "" } };
    const remote = jira(stored);

    const result = await remote.edit(
      { updates: [{ fieldId: "labels", operation: "add", value: "extra" }] },
      trace(),
    );

    expect(result.ok).toBe(true);
    expect([...(stored.fields.labels as string[])].sort()).toEqual(
      ["extra", "mine", ...TRACE_LABELS].sort(),
    );
  });

  it("does not let the caller's own removal strip a trace label, and still removes theirs", async () => {
    const stored: Stored = {
      fields: { summary: "alt", labels: ["mine", "scratch", ...TRACE_LABELS], description: "" },
    };
    const remote = jira(stored);

    const result = await remote.edit(
      {
        updates: [
          { fieldId: "labels", operation: "remove", value: "keiko-doc-aaaaaaaa" },
          { fieldId: "labels", operation: "remove", value: "scratch" },
        ],
      },
      trace(),
    );

    expect(result.ok).toBe(true);
    expect([...(stored.fields.labels as string[])].sort()).toEqual(
      ["mine", ...TRACE_LABELS].sort(),
    );
  });

  it("states labelsApplied false when the labels were not returned by the read", async () => {
    const stored: Stored = { fields: { summary: "alt", labels: ["mine"], description: "" } };
    const remote = jira(stored, { hide: ["labels"] });
    const outcomes: JiraTraceOutcome[] = [];

    await remote.edit(
      { fields: { summary: "neu" } },
      trace((outcome) => outcomes.push(outcome)),
    );

    expect(outcomes[0]).toMatchObject({ labelsApplied: false, droppedLabels: TRACE_LABELS });
    expect(remote.puts()[0]?.update ?? {}).toEqual({});
  });
});
