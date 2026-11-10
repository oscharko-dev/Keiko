// #4179: the source trace of Jira writes is resolved only from explicit, validated references and
// leaves closed, body-free evidence on the Activity Log.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import {
  createBufferedServerLogSink,
  type BufferedServerLogSink,
} from "../../../tests/support/buffered-server-log.js";
import { descriptionWithFooter } from "@oscharko-dev/keiko-connectors";
import { resolveJiraCitationMarkers } from "./atlassian/jiraCitationMarkers.js";
import { podFixture, specification, type PodFixture } from "./_requirementSupport.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { resetRequirementTurnCache } from "./requirement-inventory.js";
import {
  logTrace,
  newTally,
  openTraceSession,
  tallyOutcome,
  tallyRefusal,
  traceOutcomeData,
  traceRefusalData,
  type TraceResolution,
} from "./requirement-trace.js";

let sink: BufferedServerLogSink;
const fixtures: PodFixture[] = [];

beforeEach(() => {
  sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
  resetRequirementTurnCache();
});
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
  resetServerLogger();
});

async function session(
  pods: Parameters<typeof podFixture>[0],
  options?: Parameters<typeof podFixture>[1],
): Promise<{ f: PodFixture; open: () => ReturnType<typeof openTraceSession> }> {
  const f = await podFixture(pods, options);
  fixtures.push(f);
  return {
    f,
    open: () =>
      openTraceSession(f.deps, {
        chatId: f.chatId,
        userMessageId: "m-1",
        correlationId: "req-trace-0001",
      }),
  };
}

function scopeOf(references: string): string {
  return references;
}

describe("source acceptance criteria before a Jira draft can be staged or approved", () => {
  it("binds complete source revisions even when displayed short digests stay equal", async () => {
    const { f: source, open } = await session([
      { capsuleId: "cap-revision", text: specification(1).text },
    ]);
    const update = (suffix: string): void => {
      source.withStore((store) => {
        store._internal.db
          .prepare("UPDATE documents SET content_hash = ? WHERE capsule_id = ?")
          .run("a".repeat(12) + suffix.repeat(52), "cap-revision");
        store._internal.db
          .prepare("UPDATE capsules SET updated_at = updated_at + 1000 WHERE id = ?")
          .run("cap-revision");
      });
    };
    const resolve = (): Extract<TraceResolution, { ok: true }> => {
      const trace = open();
      try {
        const result = trace.resolve(["LH-001"]);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new TypeError("Expected synthetic requirement trace");
        return result;
      } finally {
        trace.close();
      }
    };
    update("b");
    const first = resolve();
    update("c");
    const second = resolve();
    expect(first.trace).toEqual(second.trace);
    expect(first.sourceDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(second.sourceDigest).not.toBe(first.sourceDigest);
  });

  it("matches exact source punctuation after the canonical Markdown-to-wiki projection", async () => {
    const text = specification(1).text.replace(
      "Thema 1 ist verfügbar.",
      "Datei_a [42] ist verfügbar.",
    );
    const { open } = await session([{ capsuleId: "cap-criteria", text }]);
    const trace = open();
    try {
      expect(
        trace.resolve(["LH-001"], {
          description: {
            format: "markdown",
            text: "## Criteria\n- Datei_a [42] ist verfügbar.\n- Fehler zu Thema 1 werden gemeldet.",
          },
        }).ok,
      ).toBe(true);
      // Criteria copied only into a code block are not evidence: Keiko writes them itself.
      const inCode = trace.resolve(["LH-001"], {
        description: {
          format: "markdown",
          text: "## Criteria\n```\nDatei_a [42] ist verfügbar.\nFehler zu Thema 1 werden gemeldet.\n```",
        },
      });
      if (!inCode.ok) throw new TypeError("Expected Keiko to complete the criteria");
      expect(inCode.trace.footer).toContain("Acceptance criteria (verbatim from the source):");
      expect(inCode.trace.footer).toContain("Fehler zu Thema 1 werden gemeldet.");
    } finally {
      trace.close();
    }
  });
  it("writes an omitted original acceptance criterion into Keiko's own trace block instead of refusing", async () => {
    const { open } = await session([{ capsuleId: "cap-criteria", text: specification(1).text }]);
    const trace = open();
    try {
      for (const description of [
        "Thema 1 ist verfügbar.",
        "Thema 1 ist verfügbar. Fehler zu Thema 1 werden nicht gemeldet.",
        { format: "markdown", text: "## Ziel\nKurz." },
      ]) {
        const completed = trace.resolve(["LH-001"], { description });
        if (!completed.ok) throw new TypeError("Expected Keiko to complete the criteria");
        const footer = completed.trace.footer;
        expect(footer).toContain("Acceptance criteria (verbatim from the source):");
        expect(footer).toContain("Fehler zu Thema 1 werden gemeldet.");
        // The block sits inside the replaceable trace block, before the source reference lines.
        expect(footer.indexOf(completed.trace.footerStart)).toBeLessThan(
          footer.indexOf("Acceptance criteria (verbatim from the source):"),
        );
      }
    } finally {
      trace.close();
    }
  });

  it("writes no criteria block when the description already carries every criterion", async () => {
    const { open } = await session([{ capsuleId: "cap-criteria", text: specification(1).text }]);
    const trace = open();
    try {
      const complete = trace.resolve(["LH-001"], {
        description: "Thema 1 ist verfügbar. Fehler zu Thema 1 werden gemeldet.",
      });
      if (!complete.ok) throw new TypeError("Expected the complete description to resolve");
      expect(complete.trace.footer).not.toContain("verbatim from the source");
    } finally {
      trace.close();
    }
  });

  it("binds the same digest and block when a prepared description, footer included, is checked again", async () => {
    const { open } = await session([{ capsuleId: "cap-criteria", text: specification(1).text }]);
    const trace = open();
    try {
      const first = trace.resolve(["LH-001"], { description: "Thema 1 ist verfügbar." });
      if (!first.ok) throw new TypeError("Expected the first preparation to complete");
      const prepared = descriptionWithFooter("Thema 1 ist verfügbar.", first.trace);
      expect(prepared).toContain(first.trace.footerStart);
      const again = trace.resolve(["LH-001"], { description: prepared });
      if (!again.ok) throw new TypeError("Expected the prepared description to resolve again");
      expect(again.sourceDigest).toBe(first.sourceDigest);
      expect(again.trace.footer).toBe(first.trace.footer);
    } finally {
      trace.close();
    }
  });

  it.each(["native", "markdown"] as const)(
    "accepts all original criteria in %s descriptions with only whitespace normalized",
    async (format) => {
      const { open } = await session([{ capsuleId: "cap-criteria", text: specification(1).text }]);
      const trace = open();
      const text = "Thema 1 ist verfügbar.\r\nFehler zu Thema 1\nwerden gemeldet.";
      try {
        const description = format === "native" ? text : { format: "markdown", text };
        expect(trace.resolve(["LH-001"], { description }).ok).toBe(true);
      } finally {
        trace.close();
      }
    },
  );

  it("validates the exact criterion an explicit criterion reference implements", async () => {
    const { open } = await session([{ capsuleId: "cap-criteria", text: specification(1).text }]);
    const trace = open();
    try {
      expect(trace.resolve(["LH-001/AC1"], { description: "Thema 1 ist verfügbar." }).ok).toBe(
        true,
      );
      // Only the referenced criterion is completed; AC2 is not part of this reference.
      const other = trace.resolve(["LH-001/AC1"], {
        description: "Fehler zu Thema 1 werden gemeldet.",
      });
      if (!other.ok) throw new TypeError("Expected Keiko to complete the referenced criterion");
      expect(other.trace.footer).toContain("Thema 1 ist verfügbar.");
      expect(other.trace.footer).not.toContain("Fehler zu Thema 1");
    } finally {
      trace.close();
    }
  });
});

describe("criteria that carry Keiko's own source labels (LIM32)", () => {
  // A grounded model cites `[n]` after each criterion; before review Keiko itself replaces each
  // marker with its source label. The criterion check must read that text as the criterion plus
  // a citation, or Keiko refuses the description it wrote itself.
  const labels = new Map([
    [1, "cap-criteria.md · Lastenheft > LH-001 Thema 1"],
    [2, "cap-criteria.md · Seite 3"],
  ]);
  const cited = (body: string): unknown =>
    resolveJiraCitationMarkers({ description: body }, labels).arguments.description;

  it("accepts each criterion followed by the labels the citation rewrite wrote", async () => {
    const { open } = await session([{ capsuleId: "cap-criteria", text: specification(1).text }]);
    const trace = open();
    try {
      const description = cited(
        "h2. Abnahmekriterien\n# Thema 1 ist verfügbar. [1]\n# Fehler zu Thema 1 werden gemeldet. [1][2]",
      );
      expect(description).toContain("(cap-criteria.md · Lastenheft > LH-001 Thema 1)");
      expect(trace.resolve(["LH-001"], { description }).ok).toBe(true);
    } finally {
      trace.close();
    }
  });

  it.each([
    "# Thema 1 ist verfügbar. (nur montags)\n# Fehler zu Thema 1 werden gemeldet.",
    "# Thema 1 ist verfügbar. (fremd.md · Seite 2)\n# Fehler zu Thema 1 werden gemeldet.",
    "# Thema 1 ist verfügbar. (cap-criteria.md · Seite 3) außer montags\n# Fehler zu Thema 1 werden gemeldet.",
    "# Thema 1 ist verfügbar. (cap-criteria.md · Seite 3; nur montags)\n# Fehler zu Thema 1 werden gemeldet.",
  ])(
    "does not read trailing text that is not a label of this Chat's documents as the criterion, so Keiko writes it: %s",
    async (body) => {
      const { open } = await session([{ capsuleId: "cap-criteria", text: specification(1).text }]);
      const trace = open();
      try {
        const resolved = trace.resolve(["LH-001"], {
          description: `h2. Abnahmekriterien\n${body}`,
        });
        if (!resolved.ok) throw new TypeError("Expected Keiko to complete the criterion");
        // The criterion with foreign trailing text is missing, the clean second one is present.
        expect(resolved.trace.footer).toContain("Thema 1 ist verfügbar.");
        expect(resolved.trace.footer).not.toContain("Fehler zu Thema 1");
      } finally {
        trace.close();
      }
    },
  );
});

describe("criterion text is active content, not a substring or quotation", () => {
  it.each([
    "Not: Thema 1 ist verfügbar.",
    "Not:\nThema 1 ist verfügbar.",
    "> Thema 1 ist verfügbar.",
    "{quote}\nThema 1 ist verfügbar.\n{quote}",
    "{code}\nThema 1 ist verfügbar.\n{code}",
  ])(
    "does not count a criterion copied only into non-evidence content, Keiko writes it: %s",
    async (description) => {
      const { open } = await session([{ capsuleId: "cap-criteria", text: specification(1).text }]);
      const trace = open();
      try {
        const resolved = trace.resolve(["LH-001/AC1"], { description });
        if (!resolved.ok) throw new TypeError("Expected Keiko to complete the criterion");
        expect(resolved.trace.footer).toContain("Thema 1 ist verfügbar.");
      } finally {
        trace.close();
      }
    },
  );
});

const FORMATTED_CRITERIA = [
  "Der **Status** wird angezeigt.",
  "Der *Status* wird angezeigt.",
  "Der Wert `max` wird angezeigt.",
  "Siehe [Hilfe](https://example.test/hilfe) dazu.",
] as const;

function formattedSpecification(criterion: string): string {
  return [
    "# Lastenheft",
    "",
    "### LH-001 Thema",
    "",
    "Das Portal unterstützt das Thema; die Bearbeitung ist innerhalb von 10 Minuten abgeschlossen.",
    "",
    "Abnahmekriterien:",
    `- ${criterion}`,
    "",
    "Priorität: Muss.",
    "",
  ].join("\n");
}

describe("criteria with Markdown formatting survive the Markdown-to-wiki conversion", () => {
  it.each(FORMATTED_CRITERIA)("accepts %s written as a Markdown bullet", async (criterion) => {
    const { open } = await session([
      { capsuleId: "cap-fmt", text: formattedSpecification(criterion) },
    ]);
    const trace = open();
    try {
      const collapsed = criterion.replace(/\s+/gu, " ");
      expect(
        trace.resolve(["LH-001"], { description: { format: "markdown", text: `- ${collapsed}` } })
          .ok,
      ).toBe(true);
      // Unrelated text does not carry the criterion: Keiko writes the source's own words.
      const unrelated = trace.resolve(["LH-001"], {
        description: { format: "markdown", text: "- Etwas ganz anderes." },
      });
      if (!unrelated.ok) throw new TypeError("Expected Keiko to complete the criterion");
      expect(unrelated.trace.footer).toContain("Acceptance criteria (verbatim from the source):");
      expect(unrelated.trace.footer).not.toContain("Etwas ganz anderes");
    } finally {
      trace.close();
    }
  });

  it("accepts a multi-line criterion collapsed to one bullet and writes the source words for a paraphrase", async () => {
    const { open } = await session([
      { capsuleId: "cap-fmt", text: formattedSpecification("Der Status\nwird angezeigt.") },
    ]);
    const trace = open();
    try {
      const accepted = { format: "markdown", text: "- Der Status wird angezeigt." };
      expect(trace.resolve(["LH-001"], { description: accepted }).ok).toBe(true);
      const paraphrase = { format: "markdown", text: "- Der Status wird dargestellt." };
      const completed = trace.resolve(["LH-001"], { description: paraphrase });
      if (!completed.ok) throw new TypeError("Expected Keiko to complete the criterion");
      expect(completed.trace.footer).toContain("Der Status wird angezeigt.");
      const exact = trace.resolve(["LH-001"], { description: accepted });
      if (!exact.ok) throw new TypeError("Expected the exact criterion to resolve");
      expect(exact.trace.footer).not.toContain("verbatim from the source");
    } finally {
      trace.close();
    }
  });
});

function macroSpecification(macro: string, second: boolean): string {
  return [
    "# Lastenheft",
    "",
    "### LH-001 Thema",
    "",
    "Das Portal unterstützt das Thema; die Bearbeitung ist innerhalb von 10 Minuten abgeschlossen.",
    "",
    "Abnahmekriterien:",
    `- ${macro}`,
    ...(second ? ["- Fehler zu Thema 1 werden gemeldet."] : []),
    "",
    "Priorität: Muss.",
    "",
  ].join("\n");
}

describe("a criterion without a checkable representation is refused (F16)", () => {
  const MACROS = [
    "{code} Return an error if authentication fails.",
    "{noformat} Reject an invalid signature.",
  ] as const;

  it.each(MACROS)("refuses a description that omits the macro criterion: %s", async (macro) => {
    const { open } = await session([
      { capsuleId: "cap-macro", text: macroSpecification(macro, false) },
    ]);
    const trace = open();
    try {
      const omitted = trace.resolve(["LH-001"], {
        description: {
          format: "markdown",
          text: "## Acceptance criteria\n\n- Unrelated description.",
        },
      });
      expect(omitted).toMatchObject({
        ok: false,
        reason: "references",
        problems: [{ reason: "acceptance-criteria-missing" }],
      });
    } finally {
      trace.close();
    }
  });

  it.each(MACROS)(
    "does not let the ordinary second criterion establish the macro one: %s",
    async (macro) => {
      const { open } = await session([
        { capsuleId: "cap-macro", text: macroSpecification(macro, true) },
      ]);
      const trace = open();
      try {
        const omitted = trace.resolve(["LH-001"], {
          description: { format: "markdown", text: "- Fehler zu Thema 1 werden gemeldet." },
        });
        expect(omitted).toMatchObject({
          ok: false,
          problems: [{ reason: "acceptance-criteria-missing" }],
        });
        if (omitted.ok) throw new TypeError("Expected the macro criterion refusal");
        expect(omitted.problems[0]?.reference).toMatch(/:LH-001\/AC1$/u);
      } finally {
        trace.close();
      }
    },
  );
});

describe("trace session", () => {
  it("resolves a scoped reference to doc-scoped labels and a footer with the document and revision", async () => {
    const { f, open } = await session([
      { capsuleId: "cap-a", text: specification(5).text, name: "Spec.md" },
    ]);
    const trace = open();

    const listed = await import("./requirementsTool.js").then(async (module) => {
      const tool = module.createKnowledgeRequirementsProvider(f.deps).tools()[0];
      const result = await tool?.execute(
        { ids: ["LH-002"] },
        {
          invocationId: "i",
          correlationId: "req-tool-0002",
          signal: new AbortController().signal,
          beforeEffect: () => true,
          chatId: f.chatId,
          userMessageId: "m-1",
        },
      );
      return (result?.data as { items: { reference: string }[] }).items[0]?.reference ?? "";
    });
    const resolution = trace.resolve([scopeOf(listed)]);
    trace.close();

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.trace.labels).toEqual(
      expect.arrayContaining([
        "keiko-requirement",
        "keiko-req-LH-002",
        expect.stringMatching(/^keiko-doc-[0-9a-f]{8}$/u),
        expect.stringMatching(/^keiko-rev-[0-9a-f]{12}$/u),
      ]),
    );
    expect(resolution.trace.footer).toContain("Keiko traceability");
    expect(resolution.trace.footer).toContain("LH-002");
    expect(resolution.trace.footer).toContain("Spec.md");
    expect(resolution.trace.footerStart).toBe("----\nKeiko traceability");
    expect(resolution.trace.replaceLabelPrefixes).toEqual(["keiko-rev-"]);
  });

  it("counts the units the Chat's Pods hold for the untraced-draft advisory", async () => {
    const { open } = await session([{ capsuleId: "cap-a", text: specification(5).text }]);
    const trace = open();

    expect(trace.unitCount()).toBe(5);
    trace.close();
  });

  it("accepts a plain identifier that is unique and refuses it when two documents define it", async () => {
    const unique = await session([{ capsuleId: "cap-a", text: specification(3).text }]);
    const clash = await session([
      { capsuleId: "cap-a", text: specification(3).text },
      { capsuleId: "cap-b", text: specification(3).text.replace("Thema 2;", "Thema zwei;") },
    ]);

    const ok = unique.open().resolve(["LH-001"]);
    const ambiguous = clash.open().resolve(["LH-001"]);

    expect(ok.ok).toBe(true);
    expect(ambiguous).toMatchObject({
      ok: false,
      reason: "references",
      problems: [{ reference: "LH-001", reason: "ambiguous" }],
    });
    // Never "last wins": both candidates are named so the model can pick a scoped reference.
    const problem = (ambiguous as Extract<TraceResolution, { ok: false }>).problems[0];
    expect(problem?.candidates).toHaveLength(2);
  });

  it("refuses unknown references, an empty list and more references than the bound", async () => {
    const { open } = await session([{ capsuleId: "cap-a", text: specification(3).text }]);
    const trace = open();

    const unknown = trace.resolve(["LH-404", "not a reference!"]);
    const empty = trace.resolve([]);
    const many = trace.resolve(Array.from({ length: 9 }, (_, index) => `LH-00${String(index)}`));

    expect(unknown).toMatchObject({ ok: false, reason: "references" });
    expect(
      (unknown as Extract<TraceResolution, { ok: false }>).problems.map((p) => p.reason),
    ).toEqual(["unknown", "unknown"]);
    expect(empty).toMatchObject({ ok: false, problems: [{ reason: "malformed" }] });
    expect(many).toMatchObject({ ok: false, problems: [{ reason: "malformed" }] });
  });

  it("reports a Chat without a Knowledge Pod, and an unreadable store, as closed refusals", async () => {
    const none = await session([], { bindPods: false });
    const broken = await session([{ capsuleId: "cap-a", text: specification(3).text }]);
    broken.f.withStore((store) => {
      store._internal.db.prepare("DROP TABLE documents").run();
    });

    expect(none.open().resolve(["LH-001"])).toMatchObject({
      ok: false,
      reason: "no-knowledge-pod",
    });
    const trace = broken.open();
    expect(trace.resolve(["LH-001"])).toMatchObject({ ok: false, reason: "unavailable" });
    // A failed session stays failed and does not retry the store inside the same call.
    expect(trace.resolve(["LH-001"])).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("redacts the footer with the Chat content policy", async () => {
    const text = specification(2).text.replace(
      "### LH-002 Thema 2",
      "### LH-002 Thema SECRET-KEY-123",
    );
    const { open } = await session([{ capsuleId: "cap-a", text }], {
      redactor: (value) =>
        typeof value === "string" ? value.replaceAll("SECRET-KEY-123", "[REDACTED]") : value,
    });

    const resolution = open().resolve(["LH-002"]);

    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.trace.footer).not.toContain("SECRET-KEY-123");
      expect(resolution.trace.footer).toContain("REDACTED");
    }
  });
});

describe("trace results and evidence", () => {
  it("tells the model to preserve literal missing acceptance criteria in the description (S16)", () => {
    const refusal = traceRefusalData(
      {
        ok: false,
        reason: "references",
        problems: [{ reference: "document:LH-001/AC2", reason: "acceptance-criteria-missing" }],
      },
      "traced",
    );
    expect(refusal.guidance).toContain(
      "Copy each missing acceptance criterion verbatim into fields.description.",
    );
    expect(refusal.guidance).toContain("Keep requirementIds");
    expect(refusal.requirementProblems).toEqual([
      { ref: "traced", reference: "document:LH-001/AC2", reason: "acceptance-criteria-missing" },
    ]);
  });

  it("shapes refusals and outcomes for the tool result without echoing long input", () => {
    const refusal = traceRefusalData(
      {
        ok: false,
        reason: "references",
        problems: [{ reference: "X".repeat(200), reason: "unknown" }],
      },
      "epic",
    );
    const outcome = traceOutcomeData({
      labelsApplied: true,
      footerApplied: false,
      droppedLabels: ["a", "b"],
    });

    expect(refusal).toMatchObject({
      reason: "field-validation",
      requirementRefusal: "references",
      requirementProblems: [{ ref: "epic", reason: "unknown" }],
    });
    expect(JSON.stringify(refusal).length).toBeLessThan(400);
    expect(outcome).toEqual({
      labelsApplied: true,
      footerApplied: false,
      droppedLabels: ["a", "b"],
    });
    expect(traceOutcomeData(undefined)).toBeUndefined();
  });

  it("records applied labels, footers, dropped labels and refusals as counts on one line", () => {
    const tally = newTally();
    tallyOutcome(tally, { labelsApplied: true, footerApplied: true, droppedLabels: ["x"] });
    tallyOutcome(tally, { labelsApplied: false, footerApplied: true, droppedLabels: [] });
    tallyRefusal(tally, {
      ok: false,
      reason: "references",
      problems: [
        { reference: "LH-9", reason: "unknown" },
        { reference: "1234abcd:LH-1/AC1", reason: "acceptance-criteria-missing" },
      ],
    });

    logTrace("req-trace-0002", "draft", tally);

    const line = expectActivityLogProof(
      "knowledge.requirement-trace.applied.line",
      formatActivityLogProofLine(
        sink.events.find((event) => event.op === "knowledge.requirement-trace.applied") ?? {},
      ),
    );
    expect(line).toMatchObject({
      correlationId: "req-trace-0002",
      operation: "draft",
      tracedItemCount: 3,
      refusedItemCount: 1,
      referenceProblemCount: 1,
      acceptanceCriteriaMissingCount: 1,
      labelsAppliedCount: 1,
      footerAppliedCount: 2,
      droppedLabelCount: 1,
      unavailable: false,
    });
    expect(tally.problems).toBe(2);
    expect(JSON.stringify(line)).not.toMatch(/LH-9|1234abcd|LH-1|AC1/u);
  });

  it("writes nothing when no item named a requirement", () => {
    logTrace("req-trace-0003", "create", newTally());

    expect(
      sink.events.filter((event) => event.op === "knowledge.requirement-trace.applied"),
    ).toHaveLength(0);
  });
});

describe("a document that defines one identifier twice (#4179 review)", () => {
  /** LH-001 appears in the table of contents (harmless) and twice with different bodies. */
  const CONFLICTING = [
    "# Lastenheft",
    "",
    "Inhaltsverzeichnis",
    "- LH-001 Aufbewahrung",
    "- LH-002 Anmeldung",
    "",
    "### LH-001 Aufbewahrung",
    "",
    "Daten werden zehn Tage aufbewahrt; die Frist beträgt 10 Tage.",
    "",
    "Priorität: Muss.",
    "",
    "### LH-001 Aufbewahrung ergänzt",
    "",
    "Daten werden neunzig Tage aufbewahrt; die Frist beträgt 90 Tage.",
    "",
    "Priorität: Muss.",
    "",
    "### LH-002 Anmeldung",
    "",
    "Das Portal unterstützt die Anmeldung; sie ist innerhalb von 10 Minuten abgeschlossen.",
    "",
    "Priorität: Muss.",
    "",
  ].join("\n");

  it("refuses a reference to the conflicting identifier and still resolves the unambiguous one", async () => {
    const { open } = await session([{ capsuleId: "cap-a", text: CONFLICTING }]);
    const trace = open();

    const conflicting = trace.resolve(["LH-001"]);
    const clean = trace.resolve(["LH-002"]);
    trace.close();

    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) throw new Error("expected a refusal");
    expect(conflicting.problems).toMatchObject([
      {
        reference: "LH-001",
        reason: "ambiguous",
        candidates: [expect.stringMatching(/:LH-001$/u)],
      },
    ]);
    expect(clean.ok).toBe(true);
  });

  it("does not let a document-scoped reference pick one of the two definitions", async () => {
    const { open } = await session([{ capsuleId: "cap-a", text: CONFLICTING }]);
    const trace = open();

    const first = trace.resolve(["LH-001"]);
    if (first.ok) throw new Error("expected a refusal");
    const scoped = trace.resolve([first.problems[0]?.candidates?.[0] ?? ""]);
    trace.close();

    expect(scoped.ok).toBe(false);
  });
});
