import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SCALE_CASES,
  buildScaleCorpus,
  evaluateScaleBudget,
  evaluateScaleCase,
  extractiveAnswer,
  p95CeilingMs,
  percentile,
  resolveFileCount,
  runRetrievalScaleCheck,
  seededRandom,
} from "../check-retrieval-scale.mjs";

// Epic #4429. The gate itself writes tens of thousands of files and runs the real pipeline; these
// tests own the corpus contract and the decision logic — the part that decides whether an answer at
// scale counts as correct — plus the non-tautology probe the gate depends on.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const budget = JSON.parse(
  readFileSync(join(repoRoot, "scripts", "check-retrieval-scale.budget.json"), "utf8"),
);

function packWith(path, content, startLine = 1) {
  return {
    files: [
      {
        scopePath: path,
        excerpts: [
          { atom: { scopePath: path, lineRange: { startLine, endLine: startLine + 9 } }, content },
        ],
      },
    ],
  };
}

function caseById(id) {
  const found = SCALE_CASES.find((testCase) => testCase.id === id);
  if (found === undefined) throw new Error(`unknown case ${id}`);
  return found;
}

describe("seededRandom", () => {
  it("repeats the same sequence for the same seed and differs for another seed", () => {
    const first = seededRandom(7);
    const second = seededRandom(7);
    const other = seededRandom(8);
    const a = [first(), first(), first()];
    expect([second(), second(), second()]).toEqual(a);
    expect([other(), other(), other()]).not.toEqual(a);
    for (const value of a) expect(value >= 0 && value < 1).toBe(true);
  });
});

describe("buildScaleCorpus", () => {
  const corpus = buildScaleCorpus({ fileCount: 1_000 });

  it("is deterministic", () => {
    expect(buildScaleCorpus({ fileCount: 1_000 })).toEqual(corpus);
  });

  it("writes the requested files plus every target", () => {
    expect(Object.keys(corpus)).toHaveLength(1_000 + SCALE_CASES.length);
    for (const testCase of SCALE_CASES) expect(corpus[testCase.path]).toBeDefined();
  });

  it("plants each target fact exactly once", () => {
    const vlan = caseById("deep-markdown-vlan");
    const holders = Object.entries(corpus).filter(([, content]) => content.includes("VLAN 4711"));
    expect(holders.map(([path]) => path)).toEqual([vlan.path]);
  });

  it("plants decoys that share the target wording with other values", () => {
    const decoys = Object.values(corpus).filter((content) => /VLAN 48\d\d/u.test(content));
    expect(decoys.length).toBeGreaterThan(0);
  });

  it("keeps CRLF, uppercase extensions, a large file and code in the corpus", () => {
    expect(corpus[caseById("crlf-contract").path]).toContain("\r\n");
    expect(corpus[caseById("uppercase-json").path]).toContain("budgetEuro");
    expect(corpus[caseById("fact-at-end-of-large-file").path].length).toBeGreaterThan(400_000);
    expect(Object.keys(corpus).filter((path) => path.endsWith(".ts")).length).toBeGreaterThan(50);
  });
});

describe("extractiveAnswer", () => {
  it("quotes the first line with every anchor and cites its absolute line", () => {
    const pack = packWith("a/b.md", "Einleitung\nDas VLAN 4711 gilt in Bremen.\nEnde", 20);
    expect(extractiveAnswer(pack, ["Bremen", "VLAN"])).toBe(
      "Das VLAN 4711 gilt in Bremen. [a/b.md:21]",
    );
  });

  it("reads CRLF excerpts line by line", () => {
    const pack = packWith("c.md", "Kopf\r\nNordlicht bis 2028\r\nFuss");
    expect(extractiveAnswer(pack, ["Nordlicht"])).toBe("Nordlicht bis 2028 [c.md:2]");
  });

  it("refuses instead of guessing when no sent line carries the anchors", () => {
    const answer = extractiveAnswer(packWith("a.md", "Bremen\nVLAN"), ["Bremen", "VLAN"]);
    expect(answer).not.toMatch(/\[/u);
  });
});

describe("evaluateScaleCase", () => {
  const vlan = caseById("deep-markdown-vlan");
  const factPack = packWith(vlan.path, vlan.fact, 12);
  const correct = extractiveAnswer(factPack, vlan.anchors);

  it("accepts the right file, line, value and citation", () => {
    expect(evaluateScaleCase(vlan, factPack, correct).ok).toBe(true);
  });

  it("rejects a pack without the target file", () => {
    const result = evaluateScaleCase(vlan, packWith("other.md", vlan.fact), correct);
    expect(result).toMatchObject({ ok: false, fileHit: false });
  });

  it("rejects an excerpt that misses the fact line", () => {
    const result = evaluateScaleCase(vlan, packWith(vlan.path, "nur Einleitung"), correct);
    expect(result).toMatchObject({ ok: false, lineHit: false });
  });

  it("rejects an answer that quotes a decoy value", () => {
    const decoy = `Das Admin-Netz des Standorts Bremen nutzt das VLAN 4812. [${vlan.path}:12]`;
    expect(evaluateScaleCase(vlan, factPack, decoy)).toMatchObject({ ok: false, decoy: true });
  });

  it("rejects an uncited answer", () => {
    expect(evaluateScaleCase(vlan, factPack, vlan.fact)).toMatchObject({ ok: false, cited: false });
  });
});

describe("evaluateScaleBudget", () => {
  const ok = { id: "x", ok: true };

  it("passes correct answers within the budget", () => {
    const verdict = evaluateScaleBudget({
      results: [ok],
      durationsMs: [10],
      heapPeakMiB: 1,
      budget,
      fileCount: budget.fileCount,
    });
    expect(verdict.ok).toBe(true);
  });

  it("fails a wrong answer, a slow p95 and a heap peak over budget", () => {
    const verdict = evaluateScaleBudget({
      results: [
        ok,
        {
          id: "y",
          ok: false,
          fileHit: false,
          lineHit: false,
          valueHit: false,
          cited: false,
          decoy: false,
        },
      ],
      durationsMs: [p95CeilingMs(budget, budget.fileCount) + 1],
      heapPeakMiB: budget.heapPeakBudgetMiB + 1,
      budget,
      fileCount: budget.fileCount,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toHaveLength(3);
    expect(verdict.failures[0]).toContain("y: file not sent");
  });

  it("scales the latency ceiling with the connected file count", () => {
    const committed = p95CeilingMs(budget, budget.fileCount);
    const widened = p95CeilingMs(budget, 100_000);
    expect(widened).toBeGreaterThan(committed);
    const slowForSmall = { results: [ok], durationsMs: [committed + 1], heapPeakMiB: 1, budget };
    expect(evaluateScaleBudget({ ...slowForSmall, fileCount: budget.fileCount }).ok).toBe(false);
    expect(evaluateScaleBudget({ ...slowForSmall, fileCount: 100_000 }).ok).toBe(true);
  });

  it("uses nearest-rank percentiles", () => {
    expect(percentile([50, 10, 40, 20, 30], 95)).toBe(50);
    expect(percentile([], 95)).toBe(0);
  });
});

describe("resolveFileCount", () => {
  it("uses the committed count unless the environment widens it", () => {
    expect(resolveFileCount(budget, {})).toBe(budget.fileCount);
    expect(resolveFileCount(budget, { KEIKO_RETRIEVAL_SCALE_FILES: "100000" })).toBe(100_000);
  });

  it("refuses a count below the minimum or a malformed value", () => {
    expect(() => resolveFileCount(budget, { KEIKO_RETRIEVAL_SCALE_FILES: "10" })).toThrow(
      RangeError,
    );
    expect(() => resolveFileCount(budget, { KEIKO_RETRIEVAL_SCALE_FILES: "viele" })).toThrow(
      RangeError,
    );
  });
});

describe("runRetrievalScaleCheck", () => {
  const smallRun = { KEIKO_RETRIEVAL_SCALE_FILES: String(budget.minimumFileCount) };

  // A fake pipeline that reads the materialized target file, so the regression probe — which removes
  // the first target — is observable without the real retrieval stack.
  async function fakeEval({ root, query, answerer }) {
    const { existsSync, readFileSync: read } = await import("node:fs");
    const testCase = SCALE_CASES.find((candidate) => candidate.question === query);
    const target = join(root, testCase.path);
    const pack = existsSync(target) ? packWith(testCase.path, read(target, "utf8")) : { files: [] };
    return { pack, answer: { assistantContent: await answerer.answer(query, pack) } };
  }

  it("passes when every answer is correct and the probe detects the removed fact", async () => {
    const failures = [];
    const outcome = await runRetrievalScaleCheck({
      env: smallRun,
      log: () => undefined,
      fail: (message) => failures.push(message),
      runEval: fakeEval,
    });
    expect(failures).toEqual([]);
    expect(outcome.probe.detected).toBe(true);
    expect(outcome.results.every((result) => result.ok)).toBe(true);
  });

  it("fails closed when the pipeline answers even after the fact was removed", async () => {
    const vlan = caseById("deep-markdown-vlan");
    const failures = [];
    await runRetrievalScaleCheck({
      env: smallRun,
      log: () => undefined,
      fail: (message) => failures.push(message),
      runEval: async (input) => {
        const result = await fakeEval(input);
        if (input.query !== vlan.question || result.pack.files.length > 0) return result;
        const pack = packWith(vlan.path, vlan.fact);
        return {
          pack,
          answer: { assistantContent: await input.answerer.answer(input.query, pack) },
        };
      },
    });
    expect(failures.join(" ")).toContain("regression probe passed");
  });
});
