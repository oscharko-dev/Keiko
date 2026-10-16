import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_EXPLORATION_BUDGET,
  type ConnectedContextPack,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { ContextOverflowError } from "@oscharko-dev/keiko-model-gateway";
import { nodeWorkspaceFs, type WorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { detectWorkspaceAt, readExcerpt, searchText } from "@oscharko-dev/keiko-workspace";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import {
  fittedGroundedGatewayPrompt,
  modelInputPromptByteLimit,
  promptByteLength,
  withPromptExcerptBudget,
  withPromptExcerptByteLimit,
} from "./grounded-qa.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { logGroundedPromptSelection } from "./chat-activity.js";
import type { SentGroundedPrompt } from "./grounded-prompt-context.js";
import { withSentSelectionDiagnostics } from "./grounded-answer-evidence.js";
import {
  retrieveConnectedContextPack,
  type OrchestratorDeps,
  type OrchestratorInput,
  type RetrievalOnlyOutput,
} from "./grounded-orchestrator.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  resetServerLogger();
});

function ordinaryApp(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-natural-context-"));
  roots.push(root);
  mkdirSync(join(root, "src/domain"), { recursive: true });
  mkdirSync(join(root, "handbook/services"), { recursive: true });
  writeFileSync(
    join(root, "README.md"),
    "# Parcel quote\nA small read-only fixture for Keiko Chat. The app calculates parcel shipping quotes.\nThe shipping rule is implemented in src/domain/shipping.ts. The maximum allowed weight is 12 kg.\nNegative and non-finite weights are rejected. The HTML handbook contains a separate service marker.\n",
  );
  writeFileSync(
    join(root, "src/domain/shipping.ts"),
    'export function shippingQuote(weightKg: number): number {\n  if (!Number.isFinite(weightKg) || weightKg <= 0 || weightKg > 12) {\n    throw new RangeError("Weight must be greater than zero and at most 12 kg.");\n  }\n  return weightKg <= 2 ? 4 : 4 + Math.ceil(weightKg - 2) * 1.5;\n}\n',
  );
  writeFileSync(
    join(root, "src/main.ts"),
    'import { shippingQuote } from "./domain/shipping.js";\nexport const example = shippingQuote(3);\n',
  );
  writeFileSync(
    join(root, "handbook/services/parcel.html"),
    "<!doctype html><html><head><title>Parcel handbook</title></head><body><h1>Parcel service</h1><p>ParcelServiceMarker: ORCHID</p><p>The late collection cut-off is 17:45.</p></body></html>\n",
  );
  writeFileSync(
    join(root, "package.json"),
    '{"name":"ordinary-parcel-fixture","private":true,"type":"module"}\n',
  );
  return root;
}

const QUESTION =
  "Erkläre mir diese kleine App: Wo wird der Versandpreis berechnet, was kostet ein Paket mit 3 kg, welches Höchstgewicht gilt und welche Kennung sowie Annahmefrist stehen im HTML-Handbuch? Belege die Antwort mit den tatsächlich gelesenen Dateien und Zeilen.";

function retrieve(
  root: string,
  text = QUESTION,
  deps: Partial<OrchestratorDeps> = {},
  budget?: OrchestratorInput["budget"],
  caseSensitive = false,
): Promise<RetrievalOnlyOutput> {
  return retrieveConnectedContextPack(
    {
      workspaceRoot: root,
      ...(budget === undefined ? {} : { budget }),
      scope: {
        schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
        scopeId: "natural-folder",
        workspaceRoot: root,
        kind: "workspace-root",
        relativePaths: [],
        explicitConnection: true,
        conversationId: undefined,
        connectedAtMs: 1,
      },
      query: {
        kind: "natural-language",
        text,
        caseSensitive,
        maxResults: 4096,
        emittedAtMs: 1,
      },
    },
    {
      correlationId: undefined,
      nowMs: () => 1000,
      answerer: {
        answer: (): Promise<string> =>
          Promise.reject(new Error("retrieval-only fixture must not call the model")),
      },
      ...deps,
    },
  );
}

function unavailableFs(): WorkspaceFs {
  const read = nodeWorkspaceFs.readFileBytes;
  if (read === undefined) throw new Error("physical read port missing");
  return {
    ...nodeWorkspaceFs,
    readFileBytes: (...args): Promise<Uint8Array> =>
      args[0].endsWith("/unavailable.txt")
        ? Promise.reject(Object.assign(new Error("fixture read failure"), { code: "EIO" }))
        : read(...args),
  };
}

function compoundDocumentCorpus(): string {
  const root = ordinaryApp();
  for (const [division, ceiling] of [
    ["receiving", 17],
    ["dispatch", 29],
  ] as const) {
    mkdirSync(join(root, "operations", division), { recursive: true });
    writeFileSync(
      join(root, "operations", division, "procedure.md"),
      `# Unit-G42 shipment policy\nStatus: current; approved by the operations owner.\nThe shipment ceiling is ${String(ceiling)} containers.\nNo priority between current procedures is specified.\n`,
    );
  }
  mkdirSync(join(root, "neighbours"), { recursive: true });
  for (let index = 0; index < 40; index += 1) {
    writeFileSync(
      join(root, "neighbours", `${String(index)}.md`),
      `# Separate shipping station ${String(index)}\n${"The current owner-approved shipment policy specifies a container ceiling and operational documentation.\n".repeat(50)}`,
    );
  }
  return root;
}

function partnerPolicyCorpus(): string {
  const root = ordinaryApp();
  const sources = {
    "backend/RefundPolicy.java":
      "// Approved Maple partner refund policy: 21 calendar days, EUR 7500 inclusive.\npublic final class RefundPolicy {}\n",
    "frontend/RefundSummary.tsx":
      'export const summary = "Maple partner refunds: 21 calendar days, up to EUR 7500 inclusive.";\n',
    "archive/RefundPolicy.java": "// REJECTED Maple partner refund proposal: 14 days, EUR 9000.\n",
  };
  for (const [path, text] of Object.entries(sources)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  mkdirSync(join(root, "modules/backend"), { recursive: true });
  for (let index = 0; index < 40; index += 1) {
    writeFileSync(
      join(root, "modules/backend", `Catalog${String(index)}.java`),
      `// Inventory catalogue ${String(index)}: unrelated to partner refunds.\n`.repeat(50),
    );
  }
  return root;
}

it.each(["Maple-Partner", "Maple Partner"])(
  "retains current and rejected policy sources for the multilingual subject %s",
  async (subject) => {
    const root = partnerPolicyCorpus();
    const log = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink: log, level: "info" }));
    const question = `Welche aktuell freigegebene Rückerstattungsfrist und welcher Höchstbetrag gelten für ${subject}? Prüfe Backend und Frontend und unterscheide abgelehnte Vorschläge. Belege die Antwort mit Quellen.`;
    const { pack } = await retrieve(
      root,
      question,
      {},
      {
        ...DEFAULT_EXPLORATION_BUDGET,
        filesReadMax: 8,
        excerptBytesMax: 4096,
      },
    );
    expect(pack.files.map((file) => file.scopePath)).toEqual(
      expect.arrayContaining([
        "backend/RefundPolicy.java",
        "frontend/RefundSummary.tsx",
        "archive/RefundPolicy.java",
      ]),
    );
    expect(pack.usage.filesRead).toBeLessThanOrEqual(8);
    expect(pack.usage.excerptBytes).toBeLessThanOrEqual(4096);
    expect(pack.files).toHaveLength(3);
    expect(pack.diagnostics?.selection).toMatchObject({
      selectionConfidence: "low",
      keepOneFallbackApplied: false,
      fallbackRankingSource: "lexical-producer",
    });
    expect(pack.uncertainty.some((marker) => marker.kind === "low-confidence-selection")).toBe(
      true,
    );
    expect(
      log.events.find((event) => event.op === "search.connected-context.completed")?.extra,
    ).toMatchObject({ selectedFileCount: pack.files.length });
    expect(
      log.events.find((event) => event.op === "search.connected-context.selection-details")?.extra,
    ).toMatchObject({ selectionConfidence: "low", keepOneFallbackApplied: false });
    expect(log.lines().join("\n")).not.toContain(subject);
  },
);

function minimumFittedBudget(question: string, pack: ConnectedContextPack): number {
  let low = 1;
  let high = pack.budget.modelInputTokensMax;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    try {
      fittedGroundedGatewayPrompt(question, pack, (value: unknown): unknown => value, {
        modelInputTokensMax: middle,
      });
      high = middle;
    } catch (error) {
      if (!(error instanceof ContextOverflowError)) throw error;
      low = middle + 1;
    }
  }
  return low;
}

function assertFittedConfidenceLog(sent: SentGroundedPrompt, inputBudget: number): void {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
  logGroundedPromptSelection("fitted-confidence-proof", sent, inputBudget);
  const event = sink.events.find((entry) => entry.op === "chat.context.selected");
  expect(event?.extra).toMatchObject({ sourceSelectionConfidence: "low", inputBudget });
  expect(sink.lines().join("\n")).not.toContain("Unit-G42");
}

function assertRetainedSubjectEvidence(sent: SentGroundedPrompt): void {
  expect(sent.sentEvidencePacks?.[0]?.diagnostics?.selection?.selectionConfidence).toBe("high");
  expect(
    sent.sentEvidencePacks?.[0]?.files
      .flatMap((file) => file.excerpts)
      .some((excerpt) => excerpt.content.includes("Unit-G42")),
  ).toBe(true);
}

function shortDocumentRoot(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-short-document-context-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
  return root;
}

function assertCompleteShortSource(
  pack: ConnectedContextPack,
  path: string,
  content: string,
): void {
  const excerpts = pack.files.find((file) => file.scopePath === path)?.excerpts;
  expect(excerpts?.some((excerpt) => excerpt.content === content)).toBe(true);
  expect(excerpts?.some((excerpt) => excerpt.atom.lineRange?.endLine === 6)).toBe(true);
  expect(pack.usage.excerptBytes).toBeLessThanOrEqual(pack.budget.excerptBytesMax);
}

describe("short document source context", () => {
  it("retains conflicting values and the final precedence statement in current records", async () => {
    const files = Object.fromEntries(
      [17, 23, 31].map((capacity, index): readonly [string, string] => [
        `record-${String(index)}.md`,
        [
          "# Atlas-H17 operating directive",
          "Status: current.",
          "Approved by the operations owner.",
          "Audience: onsite coordinators.",
          `Capacity: ${String(capacity)} packages per shift.`,
          "No precedence is specified between current directives.",
        ].join("\n"),
      ]),
    );
    const root = shortDocumentRoot(files);
    const { pack } = await retrieve(root, 'Compare the current records for "Atlas-H17".');
    for (const [path, content] of Object.entries(files))
      assertCompleteShortSource(pack, path, content);
  });

  it("retains a current bulletin's final identifier with its preceding limit", async () => {
    const content = [
      "# Atlas-H17 handover bulletin",
      "Status: current.",
      "Approved by the shift owner.",
      "Processing limit: 26 cartons.",
      "Bulletin identifier: NIGHT-672.",
      "This bulletin supersedes previous notices.",
    ].join("\n");
    const root = shortDocumentRoot({ "bulletin.md": content });
    const { pack } = await retrieve(root, 'Read the current handover bulletin for "Atlas-H17".');
    assertCompleteShortSource(pack, "bulletin.md", content);
  });

  it("keeps explicit document line reads inside their requested range", async () => {
    const root = shortDocumentRoot({ "record.md": "one\ntwo\nthree\nfour\nfive\nsix" });
    const workspace = detectWorkspaceAt(root);
    const result = await readExcerpt(
      { workspace, scopeId: "explicit-short-document", relativePaths: [] },
      { scopePath: "record.md", startLine: 2, endLine: 3, maxBytes: 8192 },
    );
    expect(result.content).toBe("two\nthree");
    expect(result.atom.lineRange).toEqual({ startLine: 2, endLine: 3 });
  });

  it("keeps the accepted byte grant when a complete document does not fit", async () => {
    const content = [
      "# Atlas-H17 directive",
      "Status: current.",
      "Owner: operations.",
      "Audience: coordinators.",
      "Capacity: 31 packages per shift.",
      "No precedence is specified between current directives.",
    ].join("\n");
    const root = shortDocumentRoot({ "record.md": content });
    const { pack } = await retrieve(
      root,
      'Read the current directive for "Atlas-H17".',
      {},
      {
        ...DEFAULT_EXPLORATION_BUDGET,
        excerptBytesMax: 80,
      },
    );
    const excerpts = pack.files.flatMap((file) => file.excerpts);
    expect(
      excerpts.reduce((bytes, excerpt) => bytes + excerpt.contentBytes, 0),
    ).toBeLessThanOrEqual(80);
    expect(excerpts.some((excerpt) => excerpt.content.includes("Capacity: 31"))).toBe(false);
    expect(pack.usage.excerptBytes).toBeLessThanOrEqual(80);
  });

  it("keeps code hit windows bounded instead of appending an unrelated source tail", async () => {
    const root = shortDocumentRoot({
      "state.ts": [
        "// Atlas-H17 state",
        "const first = 1;",
        "const second = 2;",
        "const third = 3;",
        "const fourth = 4;",
        "const unrelatedTail = 99;",
      ].join("\n"),
    });
    const { pack } = await retrieve(root, 'Read the state for "Atlas-H17".');
    const excerpts = pack.files.flatMap((file) => file.excerpts);
    expect(excerpts.some((excerpt) => excerpt.content.includes("Atlas-H17"))).toBe(true);
    expect(excerpts.some((excerpt) => excerpt.content.includes("unrelatedTail"))).toBe(false);
  });
});

describe("named documents beyond whole-folder context", () => {
  it.each(["unit-g42 wrong.", "Unit-G42x bad.", "Unit-G42-extra x", "nearUnit-G42 x"])(
    "fits the actual case-sensitive whole compound before an earlier decoy: %s",
    async (decoy) => {
      const root = mkdtempSync(join(tmpdir(), "keiko-fitting-compound-"));
      roots.push(root);
      const subject = "Unit-G42 correct.";
      writeFileSync(join(root, "procedure.md"), `${decoy}\n${subject}`);
      const { pack } = await retrieve(root, "Unit-G42", {}, undefined, true);
      const original = pack.files.flatMap((file) => file.excerpts);
      expect(original.some((excerpt) => excerpt.content.includes(`${decoy}\n${subject}`))).toBe(
        true,
      );
      expect(pack.diagnostics?.selection?.selectionConfidence).toBe("high");
      const sent = withPromptExcerptBudget(pack, Buffer.byteLength(subject, "utf8"));
      const excerpts = sent.files.flatMap((file) => file.excerpts);
      expect(excerpts.map((excerpt) => excerpt.content)).toEqual([subject]);
      expect(excerpts[0]?.atom.lineRange).toEqual({ startLine: 2, endLine: 2 });
      expect(sent.diagnostics?.selection?.selectionConfidence).toBe("high");
      expect(
        excerpts.reduce((bytes, excerpt) => bytes + excerpt.contentBytes, 0),
      ).toBeLessThanOrEqual(Buffer.byteLength(subject, "utf8"));
    },
  );

  it.each([923, 934, 944])(
    "retains fitting subject evidence when uncertainty changes overhead at %i tokens",
    async (modelInputTokensMax) => {
      const root = mkdtempSync(join(tmpdir(), "keiko-fitting-transition-"));
      roots.push(root);
      const question = "What is the rule for Unit-G42?";
      const observedPrefix = `${"x ".repeat(25)}Unit-G42 `;
      writeFileSync(join(root, "a.txt"), `${observedPrefix}${"details ".repeat(300)}`);
      const { pack } = await retrieve(root, question);
      const redactor = (value: unknown): unknown => value;
      const minimal = withPromptExcerptBudget(pack, Buffer.byteLength(observedPrefix, "utf8"));
      const options = { modelInputTokensMax };
      const positive = fittedGroundedGatewayPrompt(question, minimal, redactor, options);
      expect(positive.sentEvidencePacks?.[0]?.diagnostics?.selection?.selectionConfidence).toBe(
        "high",
      );
      const actual = fittedGroundedGatewayPrompt(question, pack, redactor, options);
      assertRetainedSubjectEvidence(actual);
      expect(countGatewayPromptTokens({ messages: actual.messages })).toBeLessThanOrEqual(
        modelInputTokensMax,
      );
      expect(promptByteLength(actual.messages)).toBeLessThanOrEqual(
        modelInputPromptByteLimit(modelInputTokensMax),
      );
    },
  );

  it.each([
    ["total byte budget", withPromptExcerptBudget],
    ["per-excerpt byte limit", withPromptExcerptByteLimit],
  ] as const)(
    "rechecks contextual confidence after %s removes the subject",
    async (_name, trim) => {
      const question = "What is the shipment ceiling for Unit-G42?";
      const { pack } = await retrieve(compoundDocumentCorpus(), question);
      expect(pack.diagnostics?.selection?.selectionConfidence).toBe("high");
      const trimmed = trim(pack, 0);
      expect(trimmed.files).toEqual([]);
      expect(trimmed.diagnostics?.selection?.selectionConfidence).toBe("low");
      expect(trimmed.diagnostics?.selection?.keepOneFallbackApplied).toBe(false);
      expect(
        trimmed.uncertainty.filter((entry) => entry.kind === "low-confidence-selection"),
      ).toHaveLength(1);
      expect(
        trim(pack, pack.budget.excerptBytesMax).diagnostics?.selection?.selectionConfidence,
      ).toBe("high");
    },
  );

  it("binds fitted prompt confidence to its actual retained subject evidence", async () => {
    const question = "What is the shipment ceiling for Unit-G42?";
    const { pack } = await retrieve(compoundDocumentCorpus(), question);
    const redactor = (value: unknown): unknown => value;
    const complete = fittedGroundedGatewayPrompt(question, pack, redactor);
    expect(complete.withoutSources.map((message) => message.content).join("\n")).not.toContain(
      "The supplied evidence may be unrelated to the question.",
    );
    const modelInputTokensMax = minimumFittedBudget(question, pack);
    const sent = fittedGroundedGatewayPrompt(question, pack, redactor, { modelInputTokensMax });
    const actual = sent.sentEvidencePacks?.[0];
    expect(actual).toBeDefined();
    expect(
      actual?.files
        .flatMap((file) => file.excerpts)
        .some((excerpt) => excerpt.content.includes("Unit-G42")),
    ).toBe(false);
    expect(actual?.diagnostics?.selection?.selectionConfidence).toBe("low");
    expect(
      actual?.uncertainty.filter((entry) => entry.kind === "low-confidence-selection"),
    ).toHaveLength(1);
    expect(countGatewayPromptTokens({ messages: sent.messages })).toBeLessThanOrEqual(
      modelInputTokensMax,
    );
    assertFittedConfidenceLog(sent, modelInputTokensMax);
    expect(pack.diagnostics?.selection?.selectionConfidence).toBe("high");
  });

  it("preserves the requested case in trimming and actual-sent confidence", async () => {
    const question = "What is the shipment ceiling for Unit-G42?";
    const { pack } = await retrieve(compoundDocumentCorpus(), question);
    const sensitive = { ...pack, query: { ...pack.query, caseSensitive: true } };
    const retained = withPromptExcerptBudget(sensitive, sensitive.budget.excerptBytesMax);
    const removed = withPromptExcerptBudget(sensitive, 0);
    for (const [sent, confidence] of [
      [retained, "high"],
      [removed, "low"],
    ] as const) {
      expect(sent.diagnostics?.selection?.selectionConfidence).toBe(confidence);
      expect(
        withSentSelectionDiagnostics(sensitive, [sent], 1).diagnostics?.selection
          ?.selectionConfidence,
      ).toBe(confidence);
    }
    const wrongCase = {
      ...sensitive,
      query: { ...sensitive.query, text: question.replace("Unit-G42", "unit-g42") },
    };
    expect(
      withPromptExcerptBudget(wrongCase, wrongCase.budget.excerptBytesMax).diagnostics?.selection
        ?.selectionConfidence,
    ).toBe("low");
    expect(
      withSentSelectionDiagnostics(wrongCase, [retained], 1).diagnostics?.selection
        ?.selectionConfidence,
    ).toBe("low");
  });

  it.each([
    "How does this app compute SHA-256 digests? Cite the implementation.",
    "How does this app handle UTF-8 input? Cite the implementation.",
    "Explain this production-ready-24-7 app and its shipping calculation.",
  ])("preserves ordinary contextual evidence for %s", async (question) => {
    const root = ordinaryApp();
    writeFileSync(
      join(root, "src/digest.ts"),
      'import { createHash } from "node:crypto";\nexport function digest(text: string): string {\n  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");\n}\n',
    );
    const out = await retrieve(root, question);
    expect(out.pack.files.map((file) => file.scopePath)).toContain(
      question.includes("shipping") ? "src/domain/shipping.ts" : "src/digest.ts",
    );
  });

  it("supplies both current conflicting procedures for an unquoted compound identifier", async () => {
    const log = createBufferedServerLogSink();
    const out = await retrieve(
      compoundDocumentCorpus(),
      "What is the current shipment ceiling for Unit-G42 according to the owner-approved documentation? Cite the sources and state whether the supplied documents establish a single justified value.",
      { activityLog: log },
    );
    const paths = out.pack.files.map((file) => file.scopePath);
    expect(paths).toEqual(
      expect.arrayContaining([
        "operations/receiving/procedure.md",
        "operations/dispatch/procedure.md",
      ]),
    );
    const contents = out.pack.files.flatMap((file) => file.excerpts).map((entry) => entry.content);
    expect(contents.some((content) => content.includes("17 containers"))).toBe(true);
    expect(contents.some((content) => content.includes("29 containers"))).toBe(true);
    expect(out.pack.usage.excerptBytes).toBeLessThanOrEqual(out.pack.budget.excerptBytesMax);
    expect(
      log.events.find((event) => event.op === "search.connected-context.completed")?.extra,
    ).toMatchObject({ retrievalTargetDecision: "contextual", retrievalTargetCount: 0 });
    expect(log.lines().join("\n")).not.toContain("Unit-G42");
  });

  it("does not treat an absent compound identifier as permission to answer from neighbours", async () => {
    const log = createBufferedServerLogSink();
    const out = await retrieve(
      compoundDocumentCorpus(),
      "For Missing-8Z, how many containers are admitted by the current operational policy?",
      { activityLog: log },
    );
    expect(out.pack.diagnostics?.selection?.selectionConfidence).toBe("low");
    expect(out.pack.files.length).toBeGreaterThan(0);
    expect(out.pack.uncertainty.some((entry) => entry.kind === "low-confidence-selection")).toBe(
      true,
    );
    expect(
      log.events.find((entry) => entry.op === "search.connected-context.selection-details")?.extra,
    ).toMatchObject({ selectionConfidence: "low", keepOneFallbackApplied: false });
    expect(log.lines().join("\n")).not.toContain("Missing-8Z");
    expect(
      out.pack.files
        .flatMap((file) => file.excerpts)
        .some((excerpt) => excerpt.content.includes("Missing-8Z")),
    ).toBe(false);
  });
});

function legacyHandbooks(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-natural-legacy-context-"));
  roots.push(root);
  const manuals = [
    ["water/pump.html", "Shift_JIS", [0x82, 0xa0], "Pumpe", 731],
    ["material/conveyor.html", "Big5", [0xa4, 0xa4, 0xa4, 0xe5], "Foerderband", 1193],
    [
      "metrology/calibration.html",
      "ISO-2022-JP",
      [0x1b, 0x24, 0x42, 0x24, 0x22, 0x1b, 0x28, 0x42],
      "Kalibrierstation",
      1687,
    ],
    ["monitoring/controller.html", "windows-1252", [], "Steuerung", 428],
  ] as const;
  for (const [path, charset, bytes, name, interval] of manuals) {
    const target = join(root, "handbooks", path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(
      target,
      Buffer.concat([
        Buffer.from(
          `<meta charset="${charset}">\n${"<!-- archived instructions -->\n".repeat(180)}<p>${name} `,
        ),
        Buffer.from(bytes),
        Buffer.from(`: Wartung alle ${String(interval)} Betriebsstunden.</p>\n`),
      ]),
    );
  }
  writeFileSync(
    join(root, "unsupported.html"),
    '<meta charset="unavailable-codec"><p>Unverified interval: 9999 hours.</p>\n',
  );
  return root;
}

describe("natural connected-folder context", () => {
  it.each(["utf16le", "utf16be", "windows-1252"] as const)(
    "keeps decoded %s secrets out of the actual fitted gateway prompt",
    async (codec) => {
      const root = ordinaryApp();
      const secret = ["private", "codec", "sentinel"].join("-");
      const text = `<meta charset="${codec}">\n<p>CodecServiceProbe Ölwechsel 750 hours; password="${secret}"</p>\n`;
      const bytes =
        codec === "windows-1252"
          ? Buffer.from(text, "latin1")
          : Buffer.from(`\uFEFF${text}`, "utf16le");
      writeFileSync(
        join(root, "handbook/services/encoded.html"),
        codec === "utf16be" ? bytes.swap16() : bytes,
      );
      const query = 'Find "CodecServiceProbe" and cite its documented maintenance interval.';
      const output = await retrieve(root, query);
      const evidence = output.pack.files
        .flatMap((file) => file.excerpts)
        .map((excerpt) => excerpt.content)
        .join("\n");
      expect(evidence).toContain("Ölwechsel 750 hours");
      expect(evidence).toContain("[REDACTED]");
      expect(JSON.stringify(output.pack)).not.toContain(secret);
      const sent = fittedGroundedGatewayPrompt(
        query,
        output.pack,
        (value: unknown): unknown => value,
      );
      const prompt = sent.messages.map((message) => message.content).join("\n");
      expect(prompt).toContain("Ölwechsel 750 hours");
      expect(prompt).not.toContain(secret);
      expect(prompt).toContain("handbook/services/encoded.html");
    },
  );

  it.each([
    ["What Next.js version is documented?", "Next.js 16 is documented."],
    ["Which package manager is documented?", "The package manager is npm."],
    ["Welche Version von Next.js ist dokumentiert?", "Next.js 16 is documented."],
    ["Which package manager does this project document?", "The package manager is npm."],
    ["What's the format of the user's profile page?", "The user profile page uses HTML."],
  ])(
    "retains semantic evidence for natural wording without an actual named literal: %s",
    async (text, fact) => {
      const root = ordinaryApp();
      writeFileSync(join(root, "README.md"), `# Overview\n${fact}\n`);
      let semanticCalls = 0;
      const out = await retrieve(root, text, {
        repoSemanticSearchProvider: {
          name: "actual natural-question provider",
          search: () => {
            semanticCalls += 1;
            return Promise.resolve([{ scopePath: "README.md", line: 2, score: 0.99 }]);
          },
        },
      });
      expect(semanticCalls).toBeGreaterThan(0);
      expect(
        out.pack.files
          .flatMap((file) => file.excerpts)
          .map((excerpt) => excerpt.content)
          .join("\n"),
      ).toContain(fact);
    },
  );

  it.each([
    QUESTION,
    "Was macht diese Anwendung, wie viel kostet die Lieferung eines drei Kilogramm schweren Pakets und welche Frist ist im Handbuch genannt?",
    "Explain this little application, its price calculation and weight limit, and the marker and collection deadline in its handbook.",
    "Wie hängen die Anwendung und das Handbuch zusammen? Beschreibe die Berechnung und die darin dokumentierten Grenzen anhand gelesener Quellen.",
  ])("grounds natural app and handbook questions with actual nested evidence: %s", async (text) => {
    const out = await retrieve(ordinaryApp(), text);
    expect(out.pack.files.map((file) => file.scopePath)).toEqual(
      expect.arrayContaining(["src/domain/shipping.ts", "handbook/services/parcel.html"]),
    );
    expect(
      out.pack.files
        .flatMap((file) => file.excerpts)
        .map((excerpt) => excerpt.content)
        .join("\n"),
    ).toContain("ORCHID");
    expect(
      out.pack.files
        .find((file) => file.scopePath === "src/domain/shipping.ts")
        ?.excerpts.some((excerpt) => excerpt.content.includes("Math.ceil(weightKg - 2) * 1.5")),
    ).toBe(true);
    expect(out.pack.diagnostics?.coverage?.filesScanned).toBe(5);
    expect(out.pack.usage.searchCalls).toBe(1);
  });

  it("records actual enriched reads without labeling them as additional lexical matches", async () => {
    const log = createBufferedServerLogSink();
    const root = ordinaryApp();
    const out = await retrieve(root, QUESTION, { activityLog: log });
    const ring = out.plan.rings.find((entry) => entry.kind === "lexical");
    if (ring === undefined) throw new Error("lexical plan missing");
    const literal = await searchText(
      { workspace: detectWorkspaceAt(root), scopeId: "natural-folder", relativePaths: [] },
      out.pack.query,
      ring.searchLimits,
      { nowMs: () => 1000 },
    );
    expect(out.pack.usage.filesRead).toBe(5);
    expect(out.pack.diagnostics?.coverage?.matchesReturned).toBe(literal.coverage.matchesReturned);
    expect(new Set(literal.atoms.map((atom) => atom.scopePath)).size).toBeLessThan(
      out.pack.files.length,
    );
    expect(
      log.events.find((event) => event.op === "search.connected-context.completed")?.extra,
    ).toMatchObject({
      scopeContextSelectedFileCount: 5,
      selectedFileCount: 5,
      usageSearchCalls: 1,
    });
    expect(log.lines().join("\n")).not.toContain("ORCHID");
  });

  it("discards overflowing enrichment while preserving normal literal matches", async () => {
    const root = ordinaryApp();
    writeFileSync(join(root, "large.txt"), "z".repeat(200_000));
    const out = await retrieve(root);
    expect(out.pack.files.map((file) => file.scopePath)).toContain("README.md");
    expect(
      out.pack.files
        .flatMap((file) => file.excerpts)
        .map((excerpt) => excerpt.atom)
        .some(
          (atom) =>
            atom.provenance.kind === "file-listing" &&
            atom.provenance.tool === "repo.findFiles" &&
            atom.lineRange !== undefined,
        ),
    ).toBe(false);
    expect(out.pack.diagnostics?.coverage?.filesScanned).toBe(6);
    expect(out.pack.diagnostics?.coverage?.incomplete).toBe(false);
  });

  it("does not substitute whole-folder context for an absent named identifier", async () => {
    const out = await retrieve(
      ordinaryApp(),
      "Welche Information ist für MissingContextProbe in diesem Ordner belegt?",
    );
    expect(out.pack.files).toEqual([]);
    expect(out.pack.diagnostics?.coverage?.filesScanned).toBe(5);
  });

  it("preserves an explicit finite accepted source-read budget", async () => {
    const out = await retrieve(
      ordinaryApp(),
      QUESTION,
      {},
      { ...DEFAULT_EXPLORATION_BUDGET, filesReadMax: 2 },
    );
    expect(out.pack.files).toHaveLength(2);
    expect(out.pack.usage.filesRead).toBe(2);
    expect(out.pack.omitted.some((entry) => entry.reason === "budget-exhausted")).toBe(true);
  });

  it("reads known-fit context beyond generic header ranges with arbitrary names and formats", async () => {
    const root = ordinaryApp();
    writeFileSync(
      join(root, "handbook/services/parcel.html"),
      `${"<!-- heading -->\n".repeat(260)}<p>untranslated fact: SAPPHIRE</p>\n`,
    );
    const out = await retrieve(
      root,
      "Describe the actual rules and the handbook information in this application.",
    );
    const excerpt = out.pack.files
      .find((file) => file.scopePath === "handbook/services/parcel.html")
      ?.excerpts.find((entry) => entry.content.includes("SAPPHIRE"));
    expect(excerpt).toBeDefined();
    expect(excerpt?.atom.lineRange?.endLine).toBeGreaterThanOrEqual(261);
  });

  it("retains an uneven known-fit file beyond the ordinary excerpt-window byte cap", async () => {
    const root = ordinaryApp();
    const text = `<!doctype html>\n${"<!-- filler -->\n".repeat(5_000)}<p>actual service marker: TRILLIUM; collection deadline: 18:30</p>\n`;
    writeFileSync(join(root, "handbook/services/parcel.html"), text);
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(70_000);
    const out = await retrieve(root);
    const excerpt = out.pack.files
      .find((file) => file.scopePath === "handbook/services/parcel.html")
      ?.excerpts.find((entry) => entry.content.includes("TRILLIUM"));
    expect(excerpt).toBeDefined();
    expect(out.pack.usage.excerptBytes).toBeLessThanOrEqual(out.pack.budget.excerptBytesMax);
    expect(
      out.pack.uncertainty.filter((entry) => entry.claim.includes("excerpt byte limit")),
    ).toEqual([]);
  });

  it("reads complete known-fit ranges once instead of clipping redundant anchor views", async () => {
    const root = ordinaryApp();
    const overview =
      "# Werkstatthandbuch\nDieser Ordner dokumentiert drei Anlagen: eine Wasserpumpe, ein Förderband und einen Messplatz.\nDie jeweiligen Betriebsgrenzen und Wartungsfristen stehen in den HTML-Handbüchern der Anlagen.\n";
    writeFileSync(join(root, "README.md"), overview);
    const out = await retrieve(
      root,
      "Welche Anlagen beschreibt dieser Handbuchordner? Nenne für jede Anlage die Wartungsfrist und die zugehörige Betriebsgrenze. Belege alle Angaben mit Datei und Zeile.",
    );
    const file = out.pack.files.find((entry) => entry.scopePath === "README.md");
    expect(file?.excerpts.some((excerpt) => excerpt.content === overview)).toBe(true);
    expect(out.pack.uncertainty.filter((marker) => marker.kind === "scope-incomplete")).toEqual([]);
    expect(out.pack.usage.filesRead).toBe(5);
    expect(out.pack.usage.excerptBytes).toBeLessThanOrEqual(out.pack.budget.excerptBytesMax);
  });

  it("uses the accepted byte capacity independently of the model token capacity", async () => {
    const root = ordinaryApp();
    const text = `${"<!-- source material -->\n".repeat(5_000)}<p>actual final fact: AZALEA</p>\n`;
    const bytes = Buffer.byteLength(text);
    expect(bytes).toBeGreaterThan(DEFAULT_EXPLORATION_BUDGET.modelInputTokensMax);
    expect(bytes).toBeLessThan(DEFAULT_EXPLORATION_BUDGET.excerptBytesMax);
    writeFileSync(join(root, "handbook/services/parcel.html"), text);
    const out = await retrieve(root);
    expect(
      out.pack.files.some((file) =>
        file.excerpts.some((entry) => entry.content.includes("AZALEA")),
      ),
    ).toBe(true);
    expect(out.pack.usage.excerptBytes).toBeLessThanOrEqual(out.pack.budget.excerptBytesMax);
    expect(out.pack.usage.modelInputTokens).toBeLessThanOrEqual(
      out.pack.budget.modelInputTokensMax,
    );
    const prompt = fittedGroundedGatewayPrompt(
      QUESTION,
      out.pack,
      (value: unknown): unknown => value,
    );
    expect(prompt.messages.some((message) => message.content.includes("AZALEA"))).toBe(true);
    expect(countGatewayPromptTokens({ messages: prompt.messages })).toBeLessThanOrEqual(
      out.pack.budget.modelInputTokensMax,
    );
  });

  it("discloses model clipping rather than promising complete known-fit folder evidence", async () => {
    const root = ordinaryApp();
    writeFileSync(
      join(root, "handbook/services/parcel.html"),
      `${"<!-- source -->\n".repeat(5_000)}<p>actual final fact: FREESIA</p>\n`,
    );
    const out = await retrieve(
      root,
      QUESTION,
      {},
      { ...DEFAULT_EXPLORATION_BUDGET, modelInputTokensMax: 1024 },
    );
    expect(
      out.pack.files.some((file) =>
        file.excerpts.some((excerpt) => excerpt.content.includes("FREESIA")),
      ),
    ).toBe(true);
    const prompt = fittedGroundedGatewayPrompt(
      QUESTION,
      out.pack,
      (value: unknown): unknown => value,
    );
    expect(countGatewayPromptTokens({ messages: prompt.messages })).toBeLessThanOrEqual(1024);
    expect(prompt.messages.map((message) => message.content).join("\n")).not.toContain("FREESIA");
    expect(prompt.sentReferenceCount).toBeLessThan(prompt.availableReferenceCount);
    expect(out.pack.usage.excerptBytes).toBeLessThanOrEqual(out.pack.budget.excerptBytesMax);
  });

  it.each([
    "Nenne pro Anlage das dokumentierte Wartungsintervall im verbundenen Handbuchordner. Belege jede Angabe mit der gelesenen Datei und Zeile. Weise darauf hin, wenn ein Dokument nicht lesbar ist.",
    "List the documented maintenance interval for each plant in this handbook folder. Cite the actual file and line and disclose any unreadable document.",
  ])(
    "retains verified readable legacy manuals while disclosing unavailable text: %s",
    async (text) => {
      const out = await retrieve(legacyHandbooks(), text);
      expect(out.pack.files.map((file) => file.scopePath)).toEqual(
        expect.arrayContaining([
          "handbooks/water/pump.html",
          "handbooks/material/conveyor.html",
          "handbooks/metrology/calibration.html",
          "handbooks/monitoring/controller.html",
        ]),
      );
      const content = out.pack.files
        .flatMap((file) => file.excerpts)
        .map((excerpt) => excerpt.content)
        .join("\n");
      for (const interval of [731, 1193, 1687, 428])
        expect(content).toContain(`${String(interval)} Betriebsstunden`);
      expect(content).not.toContain("9999");
      expect(out.pack.usage.filesRead).toBe(4);
      expect(out.pack.diagnostics?.coverage).toMatchObject({
        filesDiscovered: 5,
        filesScanned: 5,
        incomplete: true,
      });
      expect(out.pack.diagnostics?.coverage?.reasons).toContain("io-error");
      expect(out.pack.uncertainty.some((entry) => entry.kind === "scope-incomplete")).toBe(true);
      const sent = fittedGroundedGatewayPrompt(text, out.pack, (value: unknown): unknown => value);
      const prompt = sent.messages.map((message) => message.content).join("\n");
      expect(prompt).toContain("Candidate file evidence unavailable for reading/retrieval: 1.");
      expect(prompt).toContain("Current traversal incomplete: true; reasons: io-error.");
      expect(prompt).not.toContain("9999");
      expect(countGatewayPromptTokens({ messages: sent.messages })).toBeLessThanOrEqual(
        out.pack.budget.modelInputTokensMax,
      );
      expect(out.pack.usage.excerptBytes).toBeLessThanOrEqual(out.pack.budget.excerptBytesMax);
    },
  );

  it("retains readable partial context after an eligible file read failure", async () => {
    const root = ordinaryApp();
    writeFileSync(join(root, "unavailable.txt"), "other information\n");
    const out = await retrieve(root, QUESTION, { fs: unavailableFs() });
    expect(out.pack.diagnostics?.coverage?.reasons).toContain("io-error");
    expect(
      out.pack.files
        .flatMap((file) => file.excerpts)
        .map((excerpt) => excerpt.atom)
        .some(
          (atom) =>
            atom.provenance.kind === "file-listing" &&
            atom.provenance.tool === "repo.findFiles" &&
            atom.lineRange !== undefined,
        ),
    ).toBe(true);
    expect(out.pack.usage.filesRead).toBe(5);
    expect(out.pack.diagnostics?.coverage?.incomplete).toBe(true);
    expect(out.pack.uncertainty.some((entry) => entry.kind === "scope-incomplete")).toBe(true);
  });
});
