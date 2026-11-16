import { describe, expect, it } from "vitest";
import {
  answerObject,
  draftItem,
  fillMessages,
  outlineMessages,
  parseOutline,
  parsePage,
  type DraftBatchEntry,
  type DraftBatchInstructions,
  type DraftBatchRequirement,
  type DraftItemPlacement,
  type ParsedPage,
  type WrittenDraftItem,
} from "./jiraDraftBatchPrompt.js";
import { criteriaFitDescription, DESCRIPTION_CHARS_MAX } from "./jiraDraftBatchDescription.js";

const instructions: DraftBatchInstructions = {
  rules: '{"labels":["x"]}',
  requiredSections: ["Context", "Acceptance"],
  requiredFields: [],
};

function requirement(n: number): DraftBatchRequirement {
  return {
    ref: `doc:R${String(n)}`,
    title: `Title ${String(n)}`,
    section: `Section ${String(n)}`,
    text: `Statement ${String(n)}\nsecond line`,
  };
}

function entry(n: number, extra: readonly DraftBatchRequirement[] = []): DraftBatchEntry {
  return {
    ref: `D${String(n)}`,
    hint: `Hint ${String(n)}`,
    requirements: [requirement(n), ...extra],
  };
}

function item(key: string, sections: Record<string, string> = {}, summary = "S"): unknown {
  return { key, summary, sections };
}

const fullSections = { Context: "c", Acceptance: "a" };

function answer(items: readonly unknown[]): string {
  return JSON.stringify({ items });
}

function unwrapOk(parsed: ParsedPage): ReadonlyMap<string, WrittenDraftItem> {
  if (!parsed.ok) throw new Error(`expected ok, got ${parsed.problems.join(" ")}`);
  return parsed.items;
}

function unwrapProblems(parsed: ParsedPage): readonly string[] {
  if (parsed.ok) throw new Error("expected problems");
  return parsed.problems;
}

describe("outlineMessages", () => {
  it("lists every requirement by reference, section and title only", () => {
    const messages = outlineMessages([requirement(1), requirement(2)], instructions);
    expect(messages.map((message) => message.role)).toEqual(["system", "user"]);
    const user = messages[1]?.content ?? "";
    expect(user).toContain("doc:R1 | Section 1 | Title 1");
    expect(user).toContain("doc:R2 | Section 2 | Title 2");
    expect(user).not.toContain("Statement 1");
  });

  it("uses a default grouping wish and the person's wish when given", () => {
    const fallback = outlineMessages([requirement(1)], instructions)[1]?.content ?? "";
    expect(fallback).toContain("Group related requirements into coherent issues.");
    const wished =
      outlineMessages([requirement(1)], { ...instructions, grouping: "one per chapter" })[1]
        ?.content ?? "";
    expect(wished).toContain("Grouping: one per chapter");
    expect(wished).not.toContain("coherent issues");
  });

  it("carries the template rules and optional guidance", () => {
    const plain = outlineMessages([requirement(1)], instructions)[1]?.content ?? "";
    expect(plain).toContain('Template rules: {"labels":["x"]}');
    expect(plain).not.toContain("Instructions:");
    const guided =
      outlineMessages([requirement(1)], { ...instructions, guidance: "in German" })[1]?.content ??
      "";
    expect(guided).toContain("Instructions: in German");
  });
});

describe("fillMessages", () => {
  it("lists the keys and the requirements of every planned issue", () => {
    const messages = fillMessages([entry(1), entry(2)], instructions);
    expect(messages).toHaveLength(2);
    const user = messages[1]?.content ?? "";
    expect(user).toContain("Keys: D1, D2");
    expect(user).toContain("### D1\nSummary hint: Hint 1");
    expect(user).toContain("- doc:R2: Title 2");
    expect(user).toContain('Required sections: ["Context","Acceptance"]');
    expect(user).toContain("Required fields: []");
  });

  it("keeps Keiko's draft key out of summaries and sections", () => {
    // A summary rule asking for a bracketed identifier made a model write the draft key "[OKE01]"
    // instead of the requirement reference (#4287).
    const system = fillMessages([entry(1)], instructions)[0]?.content ?? "";
    expect(system).toContain("Each key is Keiko's internal draft key");
    expect(system).toContain("never write it into a summary or a section");
  });
  it("indents multi-line requirement text under its bullet", () => {
    const user = fillMessages([entry(1)], instructions)[1]?.content ?? "";
    expect(user).toContain("  Statement 1\n  second line");
  });

  it("lists every requirement of a grouped issue", () => {
    const user = fillMessages([entry(1, [requirement(9)])], instructions)[1]?.content ?? "";
    expect(user).toContain("- doc:R1: Title 1");
    expect(user).toContain("- doc:R9: Title 9");
  });

  it("repeats the page with the correction as a third message", () => {
    const messages = fillMessages([entry(1)], instructions, "D1 lacks sections.");
    expect(messages).toHaveLength(3);
    expect(messages[2]?.role).toBe("user");
    expect(messages[2]?.content).toContain("D1 lacks sections.");
    expect(messages[1]?.content).toBe(fillMessages([entry(1)], instructions)[1]?.content);
  });
});

describe("answerObject", () => {
  it("parses plain JSON", () => {
    expect(answerObject('{"a":1}')).toEqual({ a: 1 });
  });

  it("tolerates a Markdown fence and prose around the object", () => {
    expect(answerObject('Here you go:\n```json\n{"a":{"b":2}}\n```\nDone.')).toEqual({
      a: { b: 2 },
    });
  });

  it.each(["", "no json here", "{ broken", "} {", '["a"]', "{not: json}"])(
    "returns undefined for %j",
    (text) => {
      expect(answerObject(text)).toBeUndefined();
    },
  );
});

describe("parsePage", () => {
  it("reads one written item per planned key", () => {
    const items = unwrapOk(
      parsePage(
        answer([item("D1", fullSections), item("D2", fullSections, "Two")]),
        [entry(1), entry(2)],
        instructions,
      ),
    );
    expect([...items.keys()]).toEqual(["D1", "D2"]);
    expect(items.get("D2")?.summary).toBe("Two");
    expect(items.get("D1")?.sections.get("Context")).toBe("c");
  });

  it("tolerates a fence and prose around the JSON", () => {
    const text = `Sure.\n\`\`\`json\n${answer([item("D1", fullSections)])}\n\`\`\`\nHope it helps.`;
    expect(unwrapOk(parsePage(text, [entry(1)], instructions)).has("D1")).toBe(true);
  });

  it("asks for a JSON object when the answer is not one", () => {
    expect(unwrapProblems(parsePage("nope", [entry(1)], instructions))[0]).toContain(
      "Answer with one JSON object",
    );
    expect(unwrapProblems(parsePage('{"items":"x"}', [entry(1)], instructions))).toHaveLength(1);
    expect(unwrapProblems(parsePage("{}", [entry(1)], instructions))).toHaveLength(1);
  });

  it("names missing keys", () => {
    const problems = unwrapProblems(
      parsePage(answer([item("D1", fullSections)]), [entry(1), entry(2), entry(3)], instructions),
    );
    expect(problems.join(" ")).toContain("Missing keys or summaries: D2, D3.");
  });

  it("names missing sections case-insensitively", () => {
    const lower = unwrapOk(
      parsePage(
        answer([item("D1", { context: "c", " ACCEPTANCE ": "a" })]),
        [entry(1)],
        instructions,
      ),
    );
    expect(lower.has("D1")).toBe(true);
    const problems = unwrapProblems(
      parsePage(answer([item("D1", { Context: "c" })]), [entry(1)], instructions),
    );
    expect(problems.join(" ")).toContain('D1 lacks sections ["Acceptance"].');
  });

  it("treats blank section text as missing", () => {
    const problems = unwrapProblems(
      parsePage(
        answer([item("D1", { Context: "c", Acceptance: "   " })]),
        [entry(1)],
        instructions,
      ),
    );
    expect(problems.join(" ")).toContain("lacks sections");
  });

  it("names missing required fields and keeps only the listed ones", () => {
    const withFields = { ...instructions, requiredFields: ["Priority"] };
    const raw = { key: "D1", summary: "S", sections: fullSections, fields: { Other: "x" } };
    expect(unwrapProblems(parsePage(answer([raw]), [entry(1)], withFields)).join(" ")).toContain(
      'D1 lacks fields ["Priority"].',
    );
    const good = {
      ...raw,
      fields: { Priority: 3, Other: "x" },
    };
    const parsed = unwrapOk(parsePage(answer([good]), [entry(1)], withFields));
    expect(parsed.get("D1")?.fields).toEqual({ Priority: "3" });
  });

  it("ignores keys outside the page and repeated keys", () => {
    const items = unwrapOk(
      parsePage(
        answer([
          item("D9", fullSections),
          item("D1", fullSections, "first"),
          item("D1", fullSections, "second"),
        ]),
        [entry(1)],
        instructions,
      ),
    );
    expect([...items.keys()]).toEqual(["D1"]);
    expect(items.get("D1")?.summary).toBe("first");
  });

  it("counts an item without a usable summary as missing", () => {
    const problems = unwrapProblems(
      parsePage(
        answer([item("D1", fullSections, "  "), "text", null, { key: 5, summary: "S" }]),
        [entry(1)],
        instructions,
      ),
    );
    expect(problems.join(" ")).toContain("Missing keys or summaries: D1.");
  });

  it("accepts a numeric summary and clips an overlong one", () => {
    const items = unwrapOk(
      parsePage(
        answer([
          { key: "D1", summary: 42, sections: fullSections },
          { key: "D2", summary: "x".repeat(400), sections: fullSections },
        ]),
        [entry(1), entry(2)],
        instructions,
      ),
    );
    expect(items.get("D1")?.summary).toBe("42");
    expect(items.get("D2")?.summary).toHaveLength(255);
  });

  it("clips an overlong section", () => {
    const items = unwrapOk(
      parsePage(
        answer([item("D1", { Context: "x".repeat(9000), Acceptance: "a" })]),
        [entry(1)],
        instructions,
      ),
    );
    expect(items.get("D1")?.sections.get("Context")).toHaveLength(8000);
  });

  it("lists at most twelve problems", () => {
    const page = Array.from({ length: 30 }, (_, index) => entry(index + 1));
    const raw = page.map((planned) => item(planned.ref, {}));
    expect(unwrapProblems(parsePage(answer(raw), page, instructions))).toHaveLength(12);
  });

  it("ignores sections that are not an object", () => {
    const problems = unwrapProblems(
      parsePage(answer([{ key: "D1", summary: "S", sections: ["a"] }]), [entry(1)], instructions),
    );
    expect(problems.join(" ")).toContain("lacks sections");
  });
});

describe("parseOutline", () => {
  const chunk = [requirement(1), requirement(2), requirement(3)];

  function outline(groups: unknown): string {
    return JSON.stringify({ groups });
  }

  it("returns the groups in order", () => {
    const parsed = parseOutline(
      outline([
        { summary: "A", requirements: ["doc:R1", "doc:R3"] },
        { summary: "B", requirements: ["doc:R2"] },
      ]),
      chunk,
    );
    expect(parsed).toEqual([
      { summary: "A", refs: ["doc:R1", "doc:R3"] },
      { summary: "B", refs: ["doc:R2"] },
    ]);
  });

  it("keeps at most eight references per group and leaves the rest for a later group", () => {
    const many = Array.from({ length: 10 }, (_, index) => requirement(index + 1));
    const refs = many.map((entry) => entry.ref);
    const parsed = parseOutline(
      outline([
        { summary: "A", requirements: refs },
        { summary: "B", requirements: ["doc:R9"] },
      ]),
      many,
    );
    expect(parsed).toEqual([
      { summary: "A", refs: refs.slice(0, 8) },
      { summary: "B", refs: ["doc:R9"] },
    ]);
  });

  it("drops unknown references and keeps a reference only in its first group", () => {
    const parsed = parseOutline(
      outline([
        { summary: "A", requirements: ["doc:R1", "doc:ZZ", "doc:R1"] },
        { summary: "B", requirements: ["doc:R1", "doc:R2"] },
      ]),
      chunk,
    );
    expect(parsed).toEqual([
      { summary: "A", refs: ["doc:R1"] },
      { summary: "B", refs: ["doc:R2"] },
    ]);
  });

  it("drops groups without a summary or without a valid reference", () => {
    const parsed = parseOutline(
      outline([
        { summary: "", requirements: ["doc:R1"] },
        { summary: "Empty", requirements: ["doc:ZZ"] },
        { summary: "NoList" },
        "text",
        null,
        { summary: "Keep", requirements: ["doc:R2", 5] },
      ]),
      chunk,
    );
    expect(parsed).toEqual([{ summary: "Keep", refs: ["doc:R2"] }]);
  });

  it.each(["", "not json", '{"groups":"x"}', "{}"])("returns no groups for %j", (text) => {
    expect(parseOutline(text, chunk)).toEqual([]);
  });

  it("tolerates a fence around the answer", () => {
    const text = `\`\`\`json\n${outline([{ summary: "A", requirements: ["doc:R1"] }])}\n\`\`\``;
    expect(parseOutline(text, chunk)).toHaveLength(1);
  });
});

describe("draftItem", () => {
  const placement: DraftItemPlacement = {
    projectId: "P1",
    issueTypeId: "T1",
    requiredLabels: ["keiko", "draft"],
    parent: { key: "EPIC-1" },
  };

  function written(sections: Record<string, string>, fields = {}): WrittenDraftItem {
    return { summary: "Sum", sections: new Map(Object.entries(sections)), fields };
  }

  it("sets every identifier from Keiko's own plan", () => {
    const planned = entry(1, [requirement(2)]);
    const result = draftItem(
      planned,
      written({ Context: "c", Acceptance: "a" }),
      instructions,
      placement,
    );
    expect(result).toMatchObject({
      ref: "D1",
      projectId: "P1",
      issueTypeId: "T1",
      requirementIds: ["doc:R1", "doc:R2"],
      parent: { key: "EPIC-1" },
    });
  });

  it("writes a Markdown description with headings in template order and extras after", () => {
    const result = draftItem(
      entry(1),
      written({ Extra: "e", Acceptance: "a", context: "c" }),
      instructions,
      placement,
    );
    expect(result.fields).toMatchObject({
      summary: "Sum",
      description: {
        format: "markdown",
        text: "## Context\n\nc\n\n## Acceptance\n\na\n\n## Extra\n\ne",
      },
      labels: ["keiko", "draft"],
    });
  });

  it("leaves a missing required section empty rather than dropping its heading", () => {
    const result = draftItem(entry(1), written({ Context: "c" }), instructions, placement);
    const description = result.fields as { description: { text: string } };
    expect(description.description.text).toBe("## Context\n\nc\n\n## Acceptance\n\n");
  });

  it("omits labels and parent when there are none, and carries written fields", () => {
    const result = draftItem(
      entry(1),
      written({ Context: "c", Acceptance: "a" }, { Priority: "High" }),
      instructions,
      { projectId: "P1", issueTypeId: "T1", requiredLabels: [] },
    );
    expect(result).not.toHaveProperty("parent");
    expect(result.fields).not.toHaveProperty("labels");
    expect(result.fields).toMatchObject({ Priority: "High", summary: "Sum" });
  });

  it("does not let a written field replace the summary or description", () => {
    const result = draftItem(
      entry(1),
      written({ Context: "c", Acceptance: "a" }, { summary: "evil", description: "evil" }),
      instructions,
      placement,
    );
    const fields = result.fields as { summary: string; description: { format: string } };
    expect(fields.summary).toBe("Sum");
    expect(fields.description.format).toBe("markdown");
  });

  it("copies the required labels instead of sharing the array", () => {
    const labels = ["a"];
    const result = draftItem(entry(1), written({}), instructions, {
      ...placement,
      requiredLabels: labels,
    });
    labels.push("b");
    expect((result.fields as { labels: string[] }).labels).toEqual(["a"]);
  });
});

describe("template without required sections", () => {
  const free: DraftBatchInstructions = { ...instructions, requiredSections: [] };
  const placement: DraftItemPlacement = { projectId: "P1", issueTypeId: "T1", requiredLabels: [] };

  it("asks for the issue text in sections.description", () => {
    const user = fillMessages([entry(1)], free)[1]?.content ?? "";
    expect(user).toContain(
      "Required sections: none; write the issue text into sections.description.",
    );
  });

  it("requires a description section when parsing", () => {
    const problems = unwrapProblems(
      parsePage(answer([item("D1", { Other: "x" })]), [entry(1)], free),
    );
    expect(problems.join(" ")).toContain('D1 lacks sections ["description"].');
    const ok = unwrapOk(parsePage(answer([item("D1", { Description: "text" })]), [entry(1)], free));
    expect(ok.has("D1")).toBe(true);
  });

  it("renders the free text without a heading, other sections after as headings", () => {
    const written: WrittenDraftItem = {
      summary: "Sum",
      sections: new Map([
        ["Notes", "n"],
        ["Description", "Free text"],
      ]),
      fields: {},
    };
    const fields = draftItem(entry(1), written, free, placement).fields as {
      description: { format: string; text: string };
    };
    expect(fields.description.format).toBe("markdown");
    expect(fields.description.text).toBe("Free text\n\n## Notes\n\nn");
    expect(fields.description.text).not.toContain("## Description");
  });

  it("renders an empty description when nothing was written", () => {
    const fields = draftItem(
      entry(1),
      { summary: "S", sections: new Map(), fields: {} },
      free,
      placement,
    ).fields as { description: { text: string } };
    expect(fields.description.text).toBe("");
  });
});

describe("acceptance-criteria section", () => {
  const placement: DraftItemPlacement = { projectId: "P", issueTypeId: "T", requiredLabels: [] };
  const withCriteria = (criteria: readonly string[], text = "Statement"): DraftBatchEntry => ({
    ref: "D1",
    hint: "h",
    requirements: [{ ...requirement(1), text, criteria }],
  });
  const descriptionOf = (
    planned: DraftBatchEntry,
    ins: DraftBatchInstructions,
    sections: Record<string, string> = {},
  ): string => {
    const result = draftItem(
      planned,
      { summary: "S", sections: new Map(Object.entries(sections)), fields: {} },
      ins,
      placement,
    );
    return (result.fields as { description: { text: string } }).description.text;
  };

  it.each([
    "Acceptance Criteria (DoD)",
    "Akzeptanzkriterien / DoD",
    "Definition of Done",
    "Abnahmekriterien",
    "Kriterien",
    "DoD",
  ])("owns the template section %s", (name) => {
    const ins = { ...instructions, requiredSections: ["Context", name] };
    const planned = withCriteria(["A", "B"]);
    expect(fillMessages([planned], ins)[1]?.content).toContain('Required sections: ["Context"]');
    expect(descriptionOf(planned, ins, { Context: "c" })).toBe(
      `## Context\n\nc\n\n## ${name}\n\n- A\n- B`,
    );
  });

  it("does not take an unrelated section for the criteria", () => {
    const ins = { ...instructions, requiredSections: ["Context", "Dodo habitat"] };
    expect(fillMessages([withCriteria(["A"])], ins)[1]?.content).toContain(
      '["Context","Dodo habitat"]',
    );
  });

  it("flattens multi-line criteria and drops empty ones", () => {
    const text = descriptionOf(withCriteria(["a\n  b\r\n c", "  ", ""]), {
      ...instructions,
      requiredSections: [],
    });
    expect(text).toContain("- a b c");
    expect(text.match(/^- /gmu)).toHaveLength(1);
  });

  it("asks the model for the section when every criterion is empty", () => {
    const ins = { ...instructions, requiredSections: ["Context", "Acceptance criteria"] };
    expect(fillMessages([withCriteria([" "])], ins)[1]?.content).toContain(
      '["Context","Acceptance criteria"]',
    );
  });

  const free: DraftBatchInstructions = { ...instructions, requiredSections: [] };

  it.each([
    ["Das Portal soll die Daten mit Hilfe einer Maske erfassen.", undefined, "Akzeptanzkriterien"],
    ["The portal shall record the data with a form.", undefined, "Acceptance criteria"],
    ["Portal 4711", undefined, "Acceptance criteria"],
    ["Portal 4711", "Schreibe auf Deutsch.", "Akzeptanzkriterien"],
    ["Portal 4711", "Write in English", "Acceptance criteria"],
  ])("always writes a heading for %s", (text, guidance, heading) => {
    const planned = withCriteria(["A"], text);
    const result = descriptionOf(planned, { ...free, guidance });
    expect(result).toContain(`## ${heading}\n\n- A`);
  });
});

describe("model text hygiene", () => {
  const one = (overrides: Record<string, unknown>): WrittenDraftItem => {
    const parsed = unwrapOk(
      parsePage(
        answer([
          { key: "D1", summary: "S", sections: fullSections, fields: { team: "t" }, ...overrides },
        ]),
        [entry(1)],
        { ...instructions, requiredFields: ["team"] },
      ),
    );
    const found = parsed.get("D1");
    if (found === undefined) throw new Error("missing");
    return found;
  };

  it("collapses a summary to one line", () => {
    expect(one({ summary: " First\n\nline\t second " }).summary).toBe("First line second");
  });

  it("demotes headings but leaves code fences alone", () => {
    const body = "# Big\ntext\n```\n# comment\n```\n### Small ###";
    const item = one({ sections: { Context: body, Acceptance: "a" } });
    expect(item.sections.get("Context")).toBe("**Big**\ntext\n```\n# comment\n```\n**Small**");
  });

  it("joins lists instead of counting them as missing", () => {
    const item = one({
      sections: { Context: ["- one", "two\nlines"], Acceptance: "a" },
      fields: { team: ["x", "y"] },
    });
    expect(item.sections.get("Context")).toBe("- one\n- two lines");
    expect(item.fields.team).toBe("x, y");
  });
});

describe("description budget", () => {
  const placement: DraftItemPlacement = { projectId: "P", issueTypeId: "T", requiredLabels: [] };
  const ins = { ...instructions, requiredSections: ["Context", "Acceptance criteria"] };

  it("shortens the model text and never the criteria", () => {
    const planned: DraftBatchEntry = {
      ref: "D1",
      hint: "h",
      requirements: [{ ...requirement(1), criteria: ["c".repeat(5000)] }],
    };
    const result = draftItem(
      planned,
      { summary: "S", sections: new Map([["Context", "x".repeat(60_000)]]), fields: {} },
      ins,
      placement,
    );
    const text = (result.fields as { description: { text: string } }).description.text;
    expect(text.length).toBeLessThanOrEqual(DESCRIPTION_CHARS_MAX);
    expect(text).toContain(`- ${"c".repeat(5000)}`);
  });

  it("reports criteria that alone do not fit", () => {
    const planned: DraftBatchEntry = {
      ref: "D1",
      hint: "h",
      requirements: [{ ...requirement(1), criteria: ["c".repeat(40_000)] }],
    };
    expect(criteriaFitDescription(planned, ins)).toBe(false);
    expect(criteriaFitDescription(entry(1), ins)).toBe(true);
  });
});

describe("prompt hygiene", () => {
  it("keeps titles and sections on one line", () => {
    const messages = outlineMessages(
      [{ ...requirement(1), title: "A\nB", section: "S\n# X" }],
      instructions,
    );
    expect(messages[1]?.content).toContain("doc:R1 | S # X | A B");
    expect(fillMessages([{ ...entry(1), hint: "h\nj" }], instructions)[1]?.content).toContain(
      "Summary hint: h j",
    );
  });

  it("finds the answer among prose braces and other objects", () => {
    const text = 'Note {see} below. {"meta":1} ```json\n{"items":[{"a":"}"}]}\n``` end {';
    expect(answerObject(text, "items")).toEqual({ items: [{ a: "}" }] });
    expect(answerObject('{"x":1} {"groups":[]}', "groups")).toEqual({ groups: [] });
    expect(answerObject("no json", "items")).toBeUndefined();
  });
});
