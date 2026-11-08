import { describe, expect, it } from "vitest";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import {
  LINEAR_RATIO_MAX,
  measureScaling,
  scalingRatio,
} from "../../../../tests/support/property-testing.js";
import type { ChatMessage } from "../store/index.js";
import {
  isJiraTextWrite,
  latestCitationLabels,
  recordJiraCitationMarkers,
  resolveJiraCitationMarkers,
  unambiguousCitationLabels,
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

  it("keeps later markers in place after an astral character inside code (F31)", () => {
    const cases = [
      "Use `\u{1F600}` literally. Ziel [5].",
      "```\n\u{1F600}\n```\nZiel [5].",
      "{code}\u{1F600}{code}\nZiel [5].",
    ];
    for (const description of cases) {
      const rewrite = resolveJiraCitationMarkers({ description }, LABELS);
      expect(rewrite.arguments).toEqual({
        description: description.replace("Ziel [5].", `Ziel (${DOC} · page 2).`),
      });
      expect(rewrite).toMatchObject({ resolvedCount: 1, unresolvedCount: 0 });
    }
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

  describe("source replacement is confined to prose (F3)", () => {
    const spec = new Map([[1, "Spec A"]]);
    const resolve = (description: string): unknown =>
      resolveJiraCitationMarkers({ description }, spec).arguments;

    it("keeps a tilde fence untouched", () => {
      const code = "~~~python\nvalues = [1]\n~~~";
      expect(resolve(`Ziel [1]\n${code}`)).toEqual({ description: `Ziel (Spec A)\n${code}` });
    });

    it("keeps a four-backtick block with an inner three-backtick run untouched", () => {
      const code = "````md\n```\ninner [1]\n```\nafter [1]\n````";
      expect(resolve(`Ziel [1]\n${code}\nEnde [1]`)).toEqual({
        description: `Ziel (Spec A)\n${code}\nEnde (Spec A)`,
      });
    });

    it("resolves grouped, lenticular and fullwidth markers like the shared grammar", () => {
      const labels = new Map([
        [1, "Spec A"],
        [2, "Spec B"],
      ]);
      const rewrite = resolveJiraCitationMarkers(
        { description: "Gruppe [1, 2] und \u30101\u3011 sowie \uff3b2\uff3d." },
        labels,
      );
      expect(rewrite.arguments).toEqual({
        description: "Gruppe (Spec A; Spec B) und (Spec A) sowie (Spec B).",
      });
      expect(rewrite).toMatchObject({ resolvedCount: 4, unresolvedCount: 0 });
    });

    it("keeps links, adjacent and comma-separated runs and counts unknown markers", () => {
      const labels = new Map([
        [1, "A"],
        [2, "B"],
      ]);
      const rewrite = resolveJiraCitationMarkers(
        { description: "x [1][2] y [1] ,\t[2] z [1](http://u) w [9] v a[2]" },
        labels,
      );
      expect(rewrite.arguments).toEqual({
        description: "x (A; B) y (A; B) z [1](http://u) w [9] v a[2]",
      });
      expect(rewrite).toMatchObject({ resolvedCount: 4, unresolvedCount: 1 });
    });

    it("keeps the wiki code, noformat and inline macros protected", () => {
      const description = "{code:java}[1]{code} {noformat}[1]{noformat} {{x[1]}} `y[1]` [1]";
      expect(resolve(description)).toEqual({
        description: "{code:java}[1]{code} {noformat}[1]{noformat} {{x[1]}} `y[1]` (Spec A)",
      });
    });

    // F14: a delimiter is recognised according to the outer code context it stands in.
    it.each([
      ["a {code} tag inside Markdown inline code", "Use `{code}` literally. Goal [1]."],
      ["a {noformat} tag inside a Markdown fence", "```\n{noformat}\n```\nGoal [1]."],
      ["a {{ opener inside Markdown inline code", "Use `{{` literally. Goal [1]."],
    ])("does not let %s protect later prose", (_name, text) => {
      const rewrite = resolveJiraCitationMarkers({ description: text }, spec);
      expect(rewrite.resolvedCount).toBe(1);
      expect(rewrite.arguments).toEqual({
        description: text.replace("Goal [1].", "Goal (Spec A)."),
      });
    });

    it.each([
      ["a fence inside a {code} macro", "{code}\n```\n{code}\nGoal [1]."],
      ["a backtick pair inside a {noformat} macro", "{noformat}`a{noformat} `b` Goal [1]."],
      ["an unclosed backtick run inside a {code} macro", "{code}``{code}\nGoal [1]."],
    ])("does not let Markdown delimiters in %s swallow the macro tag", (_name, text) => {
      const rewrite = resolveJiraCitationMarkers({ description: text }, spec);
      expect(rewrite.resolvedCount).toBe(1);
      expect(rewrite.arguments).toEqual({
        description: text.replace("Goal [1].", "Goal (Spec A)."),
      });
    });

    it("keeps the code of both kinds unchanged while naming the prose between", () => {
      const text =
        "`a [1]` {code}b [1]{code} `{code}` c [1] {{d [1]}}\n```\n{noformat}[1]\n```\ne [1]";
      expect(resolve(text)).toEqual({
        description:
          "`a [1]` {code}b [1]{code} `{code}` c (Spec A) {{d [1]}}\n```\n{noformat}[1]\n```\ne (Spec A)",
      });
    });

    it("removes a summary marker with the blank before it", () => {
      expect(resolveJiraCitationMarkers({ summary: "Titel  [1]" }, spec).arguments).toEqual({
        summary: "Titel",
      });
      expect(resolveJiraCitationMarkers({ summary: "Titel [1], [9]" }, spec).arguments).toEqual({
        summary: "Titel [9]",
      });
    });
  });

  describe("marker and separator processing is linear (F13)", () => {
    const labels = new Map([[1, "Spec A"]]);
    const ratio = (build: (size: number) => Record<string, unknown>): number => {
      const scaling = measureScaling({
        build,
        run: (args) => resolveJiraCitationMarkers(args, labels),
        size: 8_000,
        maximumSize: 8_000,
      });
      expect(scaling.measurable, JSON.stringify(scaling)).toBe(true);
      return scalingRatio(scaling);
    };

    const spaces = (size: number): Record<string, unknown> => ({ summary: " ".repeat(size) + "x" });
    const markerThenSpaces = (size: number): Record<string, unknown> => ({
      description: "[1]" + " ".repeat(size) + "x",
    });
    const markerThenTabs = (size: number): Record<string, unknown> => ({
      description: "[1]" + "\t".repeat(size) + "x",
    });
    const summaryMarkerThenSpaces = (size: number): Record<string, unknown> => ({
      summary: "[1]" + " ".repeat(size) + "x",
    });
    type Build = (size: number) => Record<string, unknown>;
    const repeating =
      (piece: string): Build =>
      (size: number): Record<string, unknown> => ({
        description: piece.repeat(Math.ceil(size / piece.length)) + " [1]",
      });
    it.each<[string, Build]>([
      ["a summary of spaces without markers", spaces],
      ["a description with a marker followed by spaces", markerThenSpaces],
      ["a description with a marker followed by tabs", markerThenTabs],
      ["a summary with a marker followed by spaces", summaryMarkerThenSpaces],
      ["unclosed {code: parameters", repeating("{code:")],
      ["unclosed {noformat macros", repeating("{noformat")],
      ["many opening {{ without a close", repeating("{{")],
      ["{{ spans broken by a line end", repeating("{{x\n")],
      ["{{ followed by single braces", repeating("{{}")],
      ["literal {code} inside inline code", repeating("`{code}` ")],
      ["Markdown code inside closed macros", repeating("{code}`a`{code}")],
      ["backticks inside an unclosed macro", repeating("{code}``")],
    ])("scales linearly for %s", { timeout: 60_000 }, (_name, build) => {
      expect(ratio(build)).toBeLessThan(LINEAR_RATIO_MAX);
    });
  });

  describe("an earlier answer's numbering is used only when it is unambiguous (F8)", () => {
    const messages = [
      answer("a1", [{ marker: "[1]", label: "Spec A" }]),
      request("u1"),
      answer("a2", [
        { marker: "[1]", label: "Spec C" },
        { marker: "[2]", label: "Spec C2" },
      ]),
      request("u2"),
    ];
    it("leaves a number that two earlier answers define differently, and keeps the others", () => {
      const latest = latestCitationLabels(messages, "u3");
      const labels = unambiguousCitationLabels(messages, "u3", latest);
      expect([...labels.entries()]).toEqual([[2, "Spec C2"]]);
      expect(resolveJiraCitationMarkers({ body: "x [1] y [2]" }, labels).arguments).toEqual({
        body: "x [1] y (Spec C2)",
      });
    });

    it("keeps a number every defining answer agrees on, and a single prior answer", () => {
      const agreeing = [
        answer("a1", [{ marker: "[1]", label: "Spec A" }]),
        answer("a2", [{ marker: "[1]", label: "Spec A" }]),
      ];
      const labels = unambiguousCitationLabels(agreeing, "u", latestCitationLabels(agreeing, "u"));
      expect([...labels.entries()]).toEqual([[1, "Spec A"]]);
      const single = [answer("a1", [{ marker: "[1]", label: "Spec A" }])];
      expect(unambiguousCitationLabels(single, "u", latestCitationLabels(single, "u")).get(1)).toBe(
        "Spec A",
      );
    });
  });
});
