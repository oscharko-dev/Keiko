import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_EXPLORATION_BUDGET,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { nodeWorkspaceFs, type WorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { detectWorkspaceAt, searchText } from "@oscharko-dev/keiko-workspace";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import { fittedGroundedGatewayPrompt } from "./grounded-qa.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  retrieveConnectedContextPack,
  type OrchestratorDeps,
  type OrchestratorInput,
  type RetrievalOnlyOutput,
} from "./grounded-orchestrator.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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
        caseSensitive: false,
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

describe("natural connected-folder context", () => {
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

  it("refuses whole-folder enrichment after an eligible file read failure", async () => {
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
    ).toBe(false);
  });
});
