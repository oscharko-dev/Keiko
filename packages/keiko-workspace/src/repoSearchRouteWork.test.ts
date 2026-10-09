import { afterEach, describe, expect, it, vi } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import {
  orderCandidatesForSearch,
  resolveSearchPolicy,
  scoreContentForSearch,
} from "./repoSearchPolicy.js";
import { repositorySourceLines } from "./repoSearchSourceClassification.js";

const QUERY: RetrievalQuery = {
  kind: "natural-language",
  text: "Where is POST /orders/{id} declared?",
  caseSensitive: false,
  maxResults: 20,
  emittedAtMs: 0,
};
const POLICY = resolveSearchPolicy(true, undefined);
const CASES = [
  { name: "single", path: "src/routes.ts", text: 'router.post("/orders/{id}", save);' },
  {
    name: "adjacent declarations",
    path: "src/routes.ts",
    text: 'router.get("/orders/{id}", read);\nrouter.post("/other", save);',
  },
  {
    name: "four-line fluent",
    path: "src/routes.ts",
    text: 'router.post(\n\n\n"/orders/{id}", save);',
  },
  {
    name: "five-line fluent",
    path: "src/routes.ts",
    text: 'router.post(\n\n\n\n"/orders/{id}", save);',
  },
  {
    name: "annotation",
    path: "src/routes.java",
    text: '@Path("/orders/{id}")\n@Produces("application/json")\n@POST\nvoid save() {}',
  },
  {
    name: "distant annotation",
    path: "src/routes.java",
    text: '@Path("/orders/{id}")\n\n\n\n@POST\nvoid save() {}',
  },
  {
    name: "configured",
    path: "config/routes.json",
    text: '{\n"method": "POST", "path": "/orders/{id}",\n"handler": "save"\n}',
  },
  {
    name: "distant configured",
    path: "config/routes.json",
    text: '{\n"method": "POST", "path": "/orders/{id}",\n\n"handler": "save"\n}',
  },
  {
    name: "nested configured",
    path: "config/routes.json",
    text: '{ method: "GET", handler: read, child: { method: "POST", path: "/orders/{id}", handler: save } }',
  },
  {
    name: "yaml",
    path: "config/routes.yaml",
    text: "routes:\n  - method: POST\n    path: /orders/{id}\n    handler: save",
  },
  {
    name: "empty yaml indicator",
    path: "config/routes.yaml",
    text: "routes:\n  -\n    method: POST\n    path: /orders/{id}\n    handler: save",
  },
  {
    name: "distant yaml",
    path: "config/routes.yaml",
    text: "routes:\n  - method: POST\n    name: save\n    enabled: true\n    path: /orders/{id}\n    handler: save",
  },
  { name: "comment", path: "src/routes.ts", text: '// router.post("/orders/{id}", save);' },
  { name: "docstring", path: "src/routes.py", text: '"""\n@router.post("/orders/{id}")\n"""' },
  {
    name: "template expression",
    path: "src/routes.ts",
    text: 'const value = `router.post("/fake", save); ${router.post("/orders/{id}", save)}`;',
  },
  {
    name: "late declaration",
    path: "src/a/b/c/d/e/routes.ts",
    text: "export const unrelated = 937;\n".repeat(128) + 'router.post("/orders/{id}", save);',
  },
] as const;

// Captured from scoreContentForSearch at 3dacabe67 before preparation reuse.
const PREPARATION_BASELINE = [
  {
    name: "single",
    nonRouteScore: 14,
    score: 236,
    wrongMethodScore: 51,
  },
  {
    name: "adjacent declarations",
    nonRouteScore: 14,
    score: 76,
    wrongMethodScore: 51,
  },
  {
    name: "four-line fluent",
    nonRouteScore: 14,
    score: 236,
    wrongMethodScore: 51,
  },
  {
    name: "five-line fluent",
    nonRouteScore: 14,
    score: 76,
    wrongMethodScore: 51,
  },
  {
    name: "annotation",
    nonRouteScore: 14,
    score: 236,
    wrongMethodScore: 51,
  },
  {
    name: "distant annotation",
    nonRouteScore: 14,
    score: 76,
    wrongMethodScore: 51,
  },
  {
    name: "configured",
    nonRouteScore: 14,
    score: 236,
    wrongMethodScore: 51,
  },
  {
    name: "distant configured",
    nonRouteScore: 14,
    score: 76,
    wrongMethodScore: 51,
  },
  {
    name: "nested configured",
    nonRouteScore: 14,
    score: 236,
    wrongMethodScore: 51,
  },
  {
    name: "yaml",
    nonRouteScore: 14,
    score: 236,
    wrongMethodScore: 51,
  },
  {
    name: "empty yaml indicator",
    nonRouteScore: 14,
    score: 236,
    wrongMethodScore: 51,
  },
  {
    name: "distant yaml",
    nonRouteScore: 14,
    score: 76,
    wrongMethodScore: 51,
  },
  {
    name: "comment",
    nonRouteScore: 14,
    score: 76,
    wrongMethodScore: 51,
  },
  {
    name: "docstring",
    nonRouteScore: 14,
    score: 76,
    wrongMethodScore: 51,
  },
  {
    name: "template expression",
    nonRouteScore: 14,
    score: 236,
    wrongMethodScore: 51,
  },
  {
    name: "late declaration",
    nonRouteScore: 14,
    score: 236,
    wrongMethodScore: 51,
  },
];

afterEach(() => vi.restoreAllMocks());

describe("route content scoring reuses per-file line segmentation", () => {
  it("segments each physical source line once across overlapping declaration windows", () => {
    const text = "export const unrelated = 937;\n".repeat(64);
    const lineCount = repositorySourceLines(text, "src/routes.ts").length;
    const spy = vi.spyOn(String.prototype, "matchAll");
    scoreContentForSearch(QUERY, text, POLICY, "src/routes.ts");
    const starts = spy.mock.calls.filter(([pattern]) =>
      pattern.source.startsWith("\\b(?:router|app|server|r)\\."),
    );
    expect(starts).toHaveLength(lineCount);
  });

  it("stops preparation at the first accepted window instead of scanning the remaining file", () => {
    const text = 'router.post("/orders/{id}", save);\n' + "export const later = 211;\n".repeat(64);
    const spy = vi.spyOn(String.prototype, "matchAll");
    expect(scoreContentForSearch(QUERY, text, POLICY, "src/routes.ts")).toBe(
      PREPARATION_BASELINE[0]?.score,
    );
    const starts = spy.mock.calls.filter(([pattern]) =>
      pattern.source.startsWith("\\b(?:router|app|server|r)\\."),
    );
    expect(starts).toHaveLength(4);
  });

  it("preserves scores captured from the production scorer before preparation reuse", () => {
    const scores = CASES.map((row) => ({
      name: row.name,
      score: scoreContentForSearch(QUERY, row.text, POLICY, row.path),
      wrongMethodScore: scoreContentForSearch(
        { ...QUERY, text: QUERY.text.replace("POST", "PATCH") },
        row.text,
        POLICY,
        row.path,
      ),
      nonRouteScore: scoreContentForSearch(
        { ...QUERY, text: "Explain order persistence" },
        row.text,
        POLICY,
        row.path,
      ),
    }));
    expect(scores).toEqual(PREPARATION_BASELINE);
  });

  it("keeps a late deep route declaration ahead of nearby route-related prose", () => {
    const paths = ["src/a/b/c/d/e/routes.ts", "src/routes-notes.ts"];
    const texts = [CASES.at(-1)?.text ?? "", "POST orders save handler declaration persistence"];
    const contentScores = new Map(
      paths.map((path, index) => [
        path,
        scoreContentForSearch(QUERY, texts[index] ?? "", POLICY, path),
      ]),
    );
    const ranked = orderCandidatesForSearch({
      files: paths.map((relativePath) => ({ relativePath, sizeBytes: 4096 })),
      query: QUERY,
      policy: POLICY,
      ignoredByDiscovery: 0,
      deniedByDiscovery: 0,
      contentScores,
    });
    expect(ranked.files.map((file) => file.relativePath)).toEqual(paths);
  });
});
