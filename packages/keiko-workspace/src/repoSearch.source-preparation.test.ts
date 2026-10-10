import { afterEach, describe, expect, it, vi } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { memFs } from "./_memfs.js";
import { DEFAULT_SEARCH_LIMITS, searchText, type SearchScope } from "./repoSearch.js";
import * as classification from "./repoSearchSourceClassification.js";
import { htmlEntitySearchText } from "./repoSearchHtml.js";

const ROUTE_QUERY: RetrievalQuery = {
  kind: "natural-language",
  text: "Where is POST /orders/{id} declared?",
  caseSensitive: false,
  maxResults: 20,
  emittedAtMs: 0,
};
const CASES = [
  { name: "route", path: "src/routes.ts", text: 'router.post("/orders/{id}", save);' },
  {
    name: "multiline route",
    path: "src/routes.ts",
    text: 'router.post(\n\n\n"/orders/{id}", save);',
  },
  {
    name: "distant route",
    path: "src/routes.ts",
    text: 'router.post(\n\n\n\n"/orders/{id}", save);',
  },
  {
    name: "adjacent declarations",
    path: "src/routes.ts",
    text: 'router.get("/orders/{id}", read);\nrouter.post("/other", save);',
  },
  {
    name: "annotation",
    path: "src/routes.java",
    text: '@Path("/orders/{id}")\n@Produces("application/json")\n@POST\nvoid save() {}',
  },
  {
    name: "configured route",
    path: "config/routes.json",
    text: '{\n"method": "POST", "path": "/orders/{id}",\n"handler": "save"\n}',
  },
  {
    name: "yaml route",
    path: "config/routes.yaml",
    text: "routes:\n  - method: POST\n    path: /orders/{id}\n    handler: save",
  },
  {
    name: "late deep route",
    path: "src/a/b/c/d/e/routes.ts",
    text: "export const unrelated = 937;\n".repeat(128) + 'router.post("/orders/{id}", save);',
  },
  { name: "comment", path: "src/routes.ts", text: '// router.post("/orders/{id}", save);' },
  {
    name: "docstring",
    path: "src/routes.py",
    text: '"""\n@router.post("/orders/{id}")\n"""',
  },
  {
    name: "template expression",
    path: "src/routes.ts",
    text: 'const sample = `router.post("/fake", save); ${router.post("/orders/{id}", save)}`;',
  },
  {
    name: "encoded html route",
    path: "manual.html",
    text: "<p>POST /orders/{id} declaration</p>\n<script>router.post(&quot;/orders/{id}&quot;, save);</script>",
  },
] as const;

function fixture(
  path: string,
  text: string,
): {
  readonly scope: SearchScope;
  readonly fs: ReturnType<typeof memFs>;
} {
  const fs = memFs("/ws", { [path]: text });
  return {
    fs,
    scope: {
      scopeId: "source-preparation",
      relativePaths: [],
      workspace: {
        root: "/ws",
        selectedRoot: "/ws",
        name: "source-preparation",
        version: "1.0.0",
        testFramework: "vitest",
        sourceDirs: ["src"],
        testDirs: [],
        languages: ["typescript"],
        ignoreLines: [],
      },
    },
  };
}

async function search(
  path: string,
  text: string,
  query = ROUTE_QUERY,
): Promise<Awaited<ReturnType<typeof searchText>>> {
  const { scope, fs } = fixture(path, text);
  return searchText(
    scope,
    query,
    { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: null, elapsedMsMax: null },
    { fs, nowMs: () => 0 },
  );
}

afterEach(() => vi.restoreAllMocks());

describe("request-local source preparation from the actual streamed search producer", () => {
  it.each(CASES)("preserves old producer output for $name", async (row) => {
    const result = await search(row.path, row.text);
    if (result.diagnostics === undefined) throw new Error("missing search diagnostics");
    expect({
      atoms: result.atoms.map(({ scopePath, lineRange, score }) => ({
        scopePath,
        lineRange,
        score,
      })),
      candidates: result.candidates,
      coverage: {
        discovered: result.coverage.filesDiscovered,
        scanned: result.coverage.filesScanned,
        skipped: result.coverage.filesSkipped,
        matches: result.coverage.matchesReturned,
        incomplete: result.coverage.incomplete,
        reasons: result.coverage.reasons,
      },
      ranked: result.diagnostics.rankedCandidates.map(({ scopePath, score, signals }) => ({
        scopePath,
        score,
        contentScore: signals.find((signal) => signal.name === "content-term-score")?.value,
      })),
    }).toMatchSnapshot(row.name);
  });

  it.each([
    { query: ROUTE_QUERY, text: 'router.post("/orders/{id}", save);' },
    {
      query: { ...ROUTE_QUERY, text: "Where is reconcileInvoice defined?" },
      text: "export function reconcileInvoice() { return 937; }",
    },
    {
      query: { ...ROUTE_QUERY, kind: "exact-symbol" as const, text: "reconcileInvoice" },
      text: "export function reconcileInvoice() { return 937; }",
    },
  ])("classifies the verified raw file once for $query.text", async ({ query, text }) => {
    const spy = vi.spyOn(classification, "repositorySourceLines");
    const result = await search("src/source.ts", text, query);
    expect(result.atoms.length).toBeGreaterThan(0);
    expect(spy).toHaveBeenCalledExactlyOnceWith(text, "src/source.ts");
  });

  it("retains distinct raw and entity-decoded structural interpretations", async () => {
    const row = CASES.at(-1);
    if (row === undefined) throw new Error("missing encoded HTML fixture");
    const projected = htmlEntitySearchText(row.path, row.text);
    expect(projected).not.toBe(row.text);
    const spy = vi.spyOn(classification, "repositorySourceLines");
    await search(row.path, row.text);
    expect(spy.mock.calls.filter(([text]) => text === row.text)).toHaveLength(1);
    expect(spy.mock.calls.filter(([text]) => text === projected)).toHaveLength(1);
  });

  it("does not prepare unrelated files or share prepared lines between requests", async () => {
    const spy = vi.spyOn(classification, "repositorySourceLines");
    await search("src/source.ts", "const unrelated = 937;\n");
    expect(spy).not.toHaveBeenCalled();
    const text = 'router.post("/orders/{id}", save);';
    await search("src/source.ts", text);
    await search("src/source.ts", text);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
