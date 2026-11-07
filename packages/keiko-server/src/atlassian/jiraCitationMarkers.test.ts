import { describe, expect, it } from "vitest";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import type { ChatMessage } from "../store/index.js";
import {
  isJiraTextWrite,
  latestCitationLabels,
  recordJiraCitationMarkers,
  resolveJiraCitationMarkers,
} from "./jiraCitationMarkers.js";

function answer(id: string, citations: readonly { marker: string; label: string }[]): ChatMessage {
  return {
    id,
    role: "assistant",
    content: "",
    groundedAnswer: { groundingKind: "local-knowledge", citations },
  } as unknown as ChatMessage;
}
function request(id: string): ChatMessage {
  return { id, role: "user", content: "" } as unknown as ChatMessage;
}

const DOC = "Lastenheft-Kernbank-Migration.pdf";
const LABELS = latestCitationLabels(
  [
    answer("a1", [{ marker: "[5]", label: "Altes Dokument · page 9" }]),
    request("u1"),
    answer("a2", [
      { marker: "[5]", label: `${DOC} · page 2` },
      { marker: "[13]", label: `${DOC} · page 4` },
      { marker: "[14]", label: `${DOC} · page 5` },
    ]),
    request("u2"),
    answer("a3", [{ marker: "[5]", label: "Später geschrieben · page 1" }]),
  ],
  "u2",
);

describe("Jira text names the sources of the grounded answer it was written from (#4173 AC2)", () => {
  it("reads the latest grounded answer before the request, never a later or older one", () => {
    expect([...LABELS.entries()]).toEqual([
      [5, `${DOC} · page 2`],
      [13, `${DOC} · page 4`],
      [14, `${DOC} · page 5`],
    ]);
  });

  it("replaces the KER-1 markers in a description with readable, wiki-safe source labels", () => {
    const rewrite = resolveJiraCitationMarkers(
      {
        projectKey: "KER",
        fields: {
          summary: "Kick-off [5]",
          description: "Ziel [13] sowie Phase 1 [14].\nPlan [13][14] und Frist [5], [99].",
        },
      },
      LABELS,
    );
    expect(rewrite.arguments).toEqual({
      projectKey: "KER",
      fields: {
        summary: "Kick-off",
        description:
          "Ziel (Lastenheft-Kernbank-Migration.pdf · page 4) sowie Phase 1 (Lastenheft-Kernbank-Migration.pdf · page 5).\n" +
          "Plan (Lastenheft-Kernbank-Migration.pdf · page 4; Lastenheft-Kernbank-Migration.pdf · page 5) und Frist (Lastenheft-Kernbank-Migration.pdf · page 2)[99].",
      },
    });
    expect(rewrite).toMatchObject({ resolvedCount: 6, unresolvedCount: 1 });
  });

  it("never borrows an older answer's numbering when the latest grounded answer cites nothing", () => {
    const labels = latestCitationLabels(
      [answer("a1", [{ marker: "[5]", label: "Altes Dokument · page 9" }]), answer("a2", [])],
      "missing-request",
    );
    expect(labels.size).toBe(0);
  });

  it("keeps a summary a short title: its markers go, its sources stay in the description", () => {
    const rewrite = resolveJiraCitationMarkers(
      { fields: { summary: "Epic [5][13], Phase [99]" } },
      LABELS,
    );
    expect(rewrite.arguments).toEqual({ fields: { summary: "Epic, Phase [99]" } });
    expect(rewrite).toMatchObject({ resolvedCount: 2, unresolvedCount: 1 });
  });

  it("leaves brackets inside code alone", () => {
    const description =
      "Ziel [5]\n```\nids = [5]\n```\n{code:json}[5]{code} `a[5]` {{b[5]}} {noformat}[5]";
    expect(resolveJiraCitationMarkers({ description }, LABELS).arguments).toEqual({
      description:
        `Ziel (${DOC} · page 2)\n` +
        "```\nids = [5]\n```\n{code:json}[5]{code} `a[5]` {{b[5]}} {noformat}[5]",
    });
  });

  it("rewrites tagged Markdown and every draft item, keeping links and wiki links intact", () => {
    const args = {
      items: [
        {
          ref: "epic",
          fields: {
            description: {
              format: "markdown",
              text: "**Ziel** [5] und [Link](https://x.invalid) [5|y]",
            },
          },
        },
        { ref: "task", fields: { description: "Aufgabe [13]" } },
      ],
    };
    expect(resolveJiraCitationMarkers(args, LABELS).arguments).toEqual({
      items: [
        {
          ref: "epic",
          fields: {
            description: {
              format: "markdown",
              text: `**Ziel** (${DOC} · page 2) und [Link](https://x.invalid) [5|y]`,
            },
          },
        },
        { ref: "task", fields: { description: `Aufgabe (${DOC} · page 4)` } },
      ],
    });
  });

  it("escapes wiki markup in a label and leaves other fields and unknown markers alone", () => {
    const labels = new Map([[1, "C:\\Plan_v2_[final]!.pdf"]]);
    const rewrite = resolveJiraCitationMarkers(
      { fields: { description: "A [1]", labels: ["x[1]"], customfield_1: "B [1]" } },
      labels,
    );
    expect(rewrite.arguments).toEqual({
      fields: {
        description: "A (C:/Plan\\_v2\\_\\[final\\]\\!.pdf)",
        labels: ["x[1]"],
        customfield_1: "B [1]",
      },
    });
    const untouched = { fields: { description: "Nur [7]" } };
    expect(resolveJiraCitationMarkers(untouched, labels).arguments).toBe(untouched);
    expect(resolveJiraCitationMarkers(untouched, new Map()).arguments).toBe(untouched);
  });

  it("counts the descriptions Data Center receives converted from Markdown", () => {
    const count = (description: unknown): number =>
      resolveJiraCitationMarkers({ fields: { description } }, new Map()).markdownDescriptionCount;
    expect(count("**Ziel**\nText")).toBe(1);
    expect(count({ format: "markdown", text: "## Ziel\nText" })).toBe(1);
    expect(count("h2. Ziel\n* eins")).toBe(0);
    expect(count("Nur Text")).toBe(0);
  });

  it("applies to Jira text writes only", () => {
    expect(isJiraTextWrite("keiko.jira.create")).toBe(true);
    expect(isJiraTextWrite("keiko.jira.draft")).toBe(true);
    expect(isJiraTextWrite("keiko.jira.search")).toBe(false);
    expect(isJiraTextWrite(undefined)).toBe(false);
  });

  it("records counts only on the Activity Log", () => {
    const sink = createBufferedServerLogSink();
    recordJiraCitationMarkers(sink, "corr-citations", {
      callCount: 1,
      labelCount: 3,
      resolvedCount: 6,
      unresolvedCount: 1,
      markdownDescriptionCount: 1,
    });
    const line = sink.events.find((event) => event.op === "jira.citation.markers");
    expect(line?.correlationId).toBe("corr-citations");
    expect(line?.extra).toMatchObject({
      resolvedCount: 6,
      unresolvedCount: 1,
      labelCount: 3,
      markdownDescriptionCount: 1,
    });
    expect(JSON.stringify(sink.events)).not.toContain("Lastenheft");
    expectActivityLogProof("jira.citation.markers.line", formatActivityLogProofLine(line ?? {}));
  });
});
