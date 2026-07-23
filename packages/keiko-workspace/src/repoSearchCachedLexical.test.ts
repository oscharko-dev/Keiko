import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { describe, expect, it } from "vitest";
import {
  bestCachedLexicalLines,
  cachedContentScores,
  cachedExactSymbolDefinitionMatches,
  cachedLexicalRecordMatches,
  prepareCachedLexicalQuery,
  scoreCachedLexicalContent,
} from "./repoSearchCachedLexical.js";
import { resolveSearchPolicy, scoreContentForSearch } from "./repoSearchPolicy.js";
import {
  buildWorkspaceIndexLexicalRecord,
  type PreparedWorkspaceIndexEntry,
  type WorkspaceIndexLexicalRecord,
} from "./workspaceIndex.js";

function query(text: string, overrides: Partial<RetrievalQuery> = {}): RetrievalQuery {
  return {
    kind: "natural-language",
    text,
    caseSensitive: false,
    maxResults: 50,
    emittedAtMs: 0,
    ...overrides,
  };
}

function entry(scopePath: string, content: string, stale = false): PreparedWorkspaceIndexEntry {
  return {
    scopePath,
    absolutePath: `/workspace/${scopePath}`,
    file: { relativePath: scopePath, sizeBytes: Buffer.byteLength(content, "utf8") },
    record: {
      scopePath,
      sizeBytes: Buffer.byteLength(content, "utf8"),
      kind: "text",
      lexical: buildWorkspaceIndexLexicalRecord(content),
    },
    stale,
  };
}

describe("repoSearchCachedLexical", () => {
  it("rejects query shapes whose semantics cannot be reproduced from privacy-safe hashes", () => {
    expect(prepareCachedLexicalQuery(query(""))).toBeUndefined();
    expect(prepareCachedLexicalQuery(query("handler", { caseSensitive: true }))).toBeUndefined();
    expect(prepareCachedLexicalQuery(query("handler", { kind: "regex" }))).toBeUndefined();
    expect(prepareCachedLexicalQuery(query("*.ts", { kind: "file-pattern" }))).toBeUndefined();
  });

  it("recognizes route declarations across a bounded multiline window", () => {
    const retrieval = query("Which file registers POST /api/messages and its handler?");
    const prepared = prepareCachedLexicalQuery(retrieval);
    expect(prepared).toBeDefined();
    if (prepared === undefined) return;
    const policy = resolveSearchPolicy(false, { retrievalIntent: "targeted-code-search" });
    const route = buildWorkspaceIndexLexicalRecord(
      'router.post(\n  "/api/messages",\n  handleMessages,\n);',
    );
    const decoy = buildWorkspaceIndexLexicalRecord('const path = "/api/messages";');

    expect(scoreCachedLexicalContent(route, prepared, policy)).toBeGreaterThan(
      scoreCachedLexicalContent(decoy, prepared, policy),
    );
  });

  it.each([
    ["POST", "/a"],
    ["GET", "/b"],
  ])("does not cross-pair adjacent route declarations for %s %s", (method, path) => {
    const retrieval = query(`Where is ${method} ${path} registered?`);
    const prepared = prepareCachedLexicalQuery(retrieval);
    expect(prepared).toBeDefined();
    if (prepared === undefined) return;
    const policy = resolveSearchPolicy(false, { retrievalIntent: "targeted-code-search" });
    const adjacent = 'router.get("/a", getA);\nrouter.post("/b", postB);';
    const actual = `${method === "GET" ? "router.get" : "router.post"}("${path}", handler);`;
    const adjacentRecord = buildWorkspaceIndexLexicalRecord(adjacent, "src/routes.ts");

    expect(scoreCachedLexicalContent(adjacentRecord, prepared, policy)).toBe(
      scoreContentForSearch(retrieval, adjacent, policy, "src/routes.ts"),
    );
    expect(scoreCachedLexicalContent(adjacentRecord, prepared, policy)).toBeLessThan(
      scoreCachedLexicalContent(
        buildWorkspaceIndexLexicalRecord(actual, "src/routes.ts"),
        prepared,
        policy,
      ),
    );
  });

  it.each([
    '[HttpGet("/orders/{order_id}")] public IActionResult GetOrder() {',
    '#[get("/orders/{order_id}")] async fn get_order() {',
    '.route("/orders/{order_id}", get(get_order))',
  ])("preserves polyglot route declarations in cached scoring: %s", (declaration) => {
    const retrieval = query("Trace GET /orders/{order_id} to its handler");
    const prepared = prepareCachedLexicalQuery(retrieval);
    expect(prepared).toBeDefined();
    if (prepared === undefined) return;
    const policy = resolveSearchPolicy(false, { retrievalIntent: "targeted-code-search" });

    const declarationScore = scoreCachedLexicalContent(
      buildWorkspaceIndexLexicalRecord(declaration),
      prepared,
      policy,
    );
    const documentationScore = scoreCachedLexicalContent(
      buildWorkspaceIndexLexicalRecord("GET /orders/{order_id} is documented for API consumers."),
      prepared,
      policy,
    );

    expect(declarationScore).toBeGreaterThan(140);
    expect(declarationScore).toBe(scoreContentForSearch(retrieval, declaration, policy));
    expect(declarationScore).toBeGreaterThan(documentationScore);
    expect(documentationScore).toBeLessThanOrEqual(140);
  });

  it("uses the prepared term count consistently in live and cached scoring", () => {
    const retrieval = query("release handler");
    const prepared = prepareCachedLexicalQuery(retrieval);
    expect(prepared).toBeDefined();
    if (prepared === undefined) return;
    const policy = resolveSearchPolicy(false, { retrievalIntent: "targeted-code-search" });
    const content = "release handler";

    expect(
      scoreCachedLexicalContent(buildWorkspaceIndexLexicalRecord(content), prepared, policy),
    ).toBe(scoreContentForSearch(retrieval, content, policy));
  });

  it("distinguishes exact-symbol definitions from references", () => {
    const retrieval = query("dispatchWork", { kind: "exact-symbol" });
    const prepared = prepareCachedLexicalQuery(retrieval);
    expect(prepared).toBeDefined();
    if (prepared === undefined) return;

    expect(
      cachedExactSymbolDefinitionMatches(
        buildWorkspaceIndexLexicalRecord("export function dispatchWork(): void {}"),
        prepared.exactSymbolHash,
      ),
    ).toBe(true);
    expect(
      cachedExactSymbolDefinitionMatches(
        buildWorkspaceIndexLexicalRecord("await dispatchWork();"),
        prepared.exactSymbolHash,
      ),
    ).toBe(false);
  });

  it("keeps live and cached definition scoring aligned after language-specific masking", () => {
    const retrieval = query("real_handler", { kind: "exact-symbol" });
    const prepared = prepareCachedLexicalQuery(retrieval);
    expect(prepared).toBeDefined();
    if (prepared === undefined) return;
    const policy = resolveSearchPolicy(false, { retrievalIntent: "targeted-code-search" });
    const content = "local half = total // 2; function real_handler() end";
    const record = buildWorkspaceIndexLexicalRecord(content, "src/math.lua");

    expect(scoreCachedLexicalContent(record, prepared, policy)).toBe(
      scoreContentForSearch(retrieval, content, policy, "src/math.lua"),
    );
    expect(cachedExactSymbolDefinitionMatches(record, prepared.exactSymbolHash)).toBe(true);
  });

  it("does not persist definition or route bonuses from comments and quoted examples", () => {
    const symbol = prepareCachedLexicalQuery(query("dispatchWork", { kind: "exact-symbol" }));
    const route = prepareCachedLexicalQuery(
      query("Where is GET /api/messages defined?", { kind: "natural-language" }),
    );
    expect(symbol).toBeDefined();
    expect(route).toBeDefined();
    if (symbol === undefined || route === undefined) return;

    const commentedDefinition = buildWorkspaceIndexLexicalRecord(`
      /*
       * function dispatchWork(): void {}
       */
      const actual = true;
    `);
    const quotedDefinition = buildWorkspaceIndexLexicalRecord(
      'const documentation = "function dispatchWork(): void {}";',
    );
    const documentedDefinition = buildWorkspaceIndexLexicalRecord(
      "```ts\nexport function dispatchWork(): void {}\n```",
      "docs/example.md",
    );
    const commentedRoute = buildWorkspaceIndexLexicalRecord(
      '// router.get("/api/messages", dispatchWork);',
    );
    const actualRoute = buildWorkspaceIndexLexicalRecord(
      'router.get("/api/messages", dispatchWork);',
    );
    const policy = resolveSearchPolicy(false, { retrievalIntent: "targeted-code-search" });

    expect(cachedExactSymbolDefinitionMatches(commentedDefinition, symbol.exactSymbolHash)).toBe(
      false,
    );
    expect(cachedExactSymbolDefinitionMatches(quotedDefinition, symbol.exactSymbolHash)).toBe(
      false,
    );
    expect(cachedExactSymbolDefinitionMatches(documentedDefinition, symbol.exactSymbolHash)).toBe(
      false,
    );
    expect(scoreCachedLexicalContent(commentedRoute, route, policy)).toBeLessThan(
      scoreCachedLexicalContent(actualRoute, route, policy),
    );
  });

  it.each([
    "public Result handler() { return ok; }",
    "Return handler() { return ok; }",
    "public void handler() {}",
    "public abstract void handler();",
    "function handler(): void {}",
    "handler(input: string): Promise<Result> {}",
    "abstract handler(input: string): Promise<Result>;",
    "func handler() {}",
    "fn handler() {}",
  ])("matches cached definitions with the same language coverage as live search: %s", (line) => {
    const prepared = prepareCachedLexicalQuery(query("handler", { kind: "exact-symbol" }));
    expect(prepared).toBeDefined();
    if (prepared === undefined) return;

    expect(
      cachedExactSymbolDefinitionMatches(
        buildWorkspaceIndexLexicalRecord(line),
        prepared.exactSymbolHash,
      ),
    ).toBe(true);
  });

  it.each([
    "void handler();",
    "typeof handler();",
    "delete handler();",
    "value instanceof handler();",
    '"handler" in handler();',
    "for (const value of handler()) {}",
    "else handler();",
    "do handler();",
    "case handler():",
    "default handler();",
    "with handler();",
    "assert handler();",
    "raise handler();",
  ])(
    "does not turn an operator or control-flow reference into a cached definition: %s",
    (reference) => {
      const prepared = prepareCachedLexicalQuery(query("handler", { kind: "exact-symbol" }));
      expect(prepared).toBeDefined();
      if (prepared === undefined) return;
      const record = buildWorkspaceIndexLexicalRecord(`${reference} const unrelated = true;`);

      expect(cachedExactSymbolDefinitionMatches(record, prepared.exactSymbolHash)).toBe(false);
    },
  );

  it("does not persist false test stems for ordinary identifiers", () => {
    const falseStem = prepareCachedLexicalQuery(query("Con", { kind: "exact-symbol" }));
    const sourceStem = prepareCachedLexicalQuery(query("PaymentService", { kind: "exact-symbol" }));
    expect(falseStem).toBeDefined();
    expect(sourceStem).toBeDefined();
    if (falseStem === undefined || sourceStem === undefined) return;

    expect(
      cachedLexicalRecordMatches(buildWorkspaceIndexLexicalRecord("class Contest {}"), falseStem),
    ).toBe(false);
    expect(
      cachedLexicalRecordMatches(
        buildWorkspaceIndexLexicalRecord("class PaymentServiceTest {}"),
        sourceStem,
      ),
    ).toBe(true);
  });

  it("returns the strongest matching lines in deterministic source order", () => {
    const retrieval = query("release handler");
    const prepared = prepareCachedLexicalQuery(retrieval);
    expect(prepared).toBeDefined();
    if (prepared === undefined) return;
    const record = buildWorkspaceIndexLexicalRecord(
      ["release handler", "unrelated", "release", "release handler", "handler"].join("\n"),
    );

    expect(bestCachedLexicalLines(record, prepared)).toEqual([
      { line: 1, startLine: 1, endLine: 1, score: 1 },
      { line: 3, startLine: 3, endLine: 3, score: 0.5 },
      { line: 4, startLine: 4, endLine: 4, score: 1 },
    ]);
    expect(cachedLexicalRecordMatches(record, prepared)).toBe(true);
  });

  it("fails closed for truncated lexical records", () => {
    const retrieval = query("release handler");
    const prepared = prepareCachedLexicalQuery(retrieval);
    expect(prepared).toBeDefined();
    if (prepared === undefined) return;
    const base = buildWorkspaceIndexLexicalRecord("release handler");
    const truncated: WorkspaceIndexLexicalRecord = { ...base, truncated: true };
    const policy = resolveSearchPolicy(false, undefined);

    expect(cachedLexicalRecordMatches(truncated, prepared)).toBe(false);
    expect(scoreCachedLexicalContent(truncated, prepared, policy)).toBe(0);
  });

  it("uses only fresh indexed entries and returns undefined without a positive score", () => {
    const retrieval = query("release handler");
    const policy = resolveSearchPolicy(false, { retrievalIntent: "targeted-code-search" });

    expect(
      cachedContentScores(
        [
          entry("src/fresh.ts", "export const releaseHandler = true;"),
          entry("src/stale.ts", "release handler", true),
        ],
        retrieval,
        policy,
      ),
    ).toEqual(new Map([["src/fresh.ts", expect.any(Number)]]));
    expect(
      cachedContentScores([entry("src/other.ts", "unrelated")], retrieval, policy),
    ).toBeUndefined();
  });
});
