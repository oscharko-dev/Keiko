// Deterministic retrieval-latency gate (enterprise retrieval M3). Mirrors the standalone
// budget-script pattern of editor-bundle-size.mjs: pure exported helpers (unit-tested in
// scripts/__tests__/) plus a runner that measures `searchText` over a FIXED synthetic in-memory
// repository and fails (process.exit(1)) when the p95 exceeds a generous committed budget.
//
// Why a script (not an in-suite vitest assertion): wall-clock inside the parallel test runner is
// noisy and would gate on machine load. A standalone script with a fixed fixture, warmup discard,
// and a generous percentile ceiling catches algorithmic (e.g. O(n^2)) regressions with low flake.
// It is deterministic in WORKLOAD (byte-identical fixture, no RNG, no clock in the fixture build);
// only the measured durations vary, and the budget is a ceiling, not an exact match.

import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { TextEncoder } from "node:util";

import { DEFAULT_SEARCH_LIMITS, searchText } from "@oscharko-dev/keiko-workspace";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUDGET_PATH = resolve(HERE, "check-retrieval-latency.budget.json");
const MEM_ROOT = "/bench";

// ─── Pure helpers (unit-tested) ─────────────────────────────────────────────────

// Nearest-rank percentile over a copy of `samples` (ascending). `p` is 0..100. Empty → 0.
export function percentile(samples, p) {
  if (samples.length === 0) {
    return 0;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index];
}

export function evaluateLatencyBudget({ observedMs, budgetMs }) {
  return { ok: observedMs <= budgetMs, observedMs, budgetMs };
}

// ─── Synthetic fixture (deterministic, in-memory) ───────────────────────────────

function buildFixtureFiles(fileCount) {
  const files = {
    "README.md":
      "# Bench fixture\n\nA synthetic polyglot repository used only for the latency gate.\n",
    "pom.xml":
      "<project>\n  <properties>\n    <maven.compiler.release>21</maven.compiler.release>\n  </properties>\n</project>\n",
    "go.mod": "module bench/svc\n\ngo 1.23.0\n",
  };
  for (let i = 0; i < fileCount; i += 1) {
    const dir = `src/mod${String(i % 64)}`;
    files[`${dir}/file${String(i)}.ts`] =
      `// module ${String(i)}\nexport function handler${String(i)}(input: string): string {\n  return input.repeat(${String((i % 5) + 1)});\n}\n`;
  }
  return files;
}

function toAbs(rel) {
  return rel === MEM_ROOT ? MEM_ROOT : `${MEM_ROOT}/${rel}`.replace(/\/+/g, "/");
}

function dirEntry(name, isDirectory) {
  return { name, isDirectory, isFile: !isDirectory, isSymbolicLink: false };
}

// Minimal in-memory WorkspaceFs (mirrors the test-only _memfs); inlined here because that helper is
// internal to keiko-workspace and not part of the public surface.
//
// Lookups are O(1) over precomputed maps. The first version of this fixture resolved every path
// with `keys.find(...)` — O(fileCount) per fs call — which made the measured p95 ~86% fixture
// overhead: real algorithmic regressions in searchText would have hidden inside fixture noise,
// and fixture-sensitive refactors would have looked like product regressions. The gate must
// spend its time in keiko-workspace code, not in its own harness.
function buildFixtureIndex(files) {
  const contentByAbs = new Map();
  const childrenByDir = new Map();
  const ensureDir = (dirAbs) => {
    let children = childrenByDir.get(dirAbs);
    if (children === undefined) {
      children = new Map();
      childrenByDir.set(dirAbs, children);
    }
    return children;
  };
  ensureDir(MEM_ROOT);
  for (const [rel, content] of Object.entries(files)) {
    contentByAbs.set(toAbs(rel), content);
    const parts = rel.split("/");
    let parent = MEM_ROOT;
    for (let i = 0; i < parts.length; i += 1) {
      const isLast = i === parts.length - 1;
      ensureDir(parent).set(parts[i], !isLast);
      const childAbs = `${parent}/${parts[i]}`;
      if (!isLast) {
        ensureDir(childAbs);
      }
      parent = childAbs;
    }
  }
  return { contentByAbs, childrenByDir };
}

function encodedContent(contentByAbs, encoder, abs) {
  const content = contentByAbs.get(abs);
  if (content === undefined) {
    return undefined;
  }
  return encoder.encode(content);
}

function buildFixtureFs(files) {
  const { contentByAbs, childrenByDir } = buildFixtureIndex(files);
  const encoder = new TextEncoder();
  return {
    readFileUtf8: (abs) => {
      const content = contentByAbs.get(abs);
      if (content === undefined) {
        throw new Error(`ENOENT: ${abs}`);
      }
      return content;
    },
    stat: (abs) => {
      const content = contentByAbs.get(abs);
      if (content === undefined) {
        return { size: 0, isFile: false, isDirectory: true, isSymbolicLink: false };
      }
      return {
        size: Buffer.byteLength(content, "utf8"),
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
      };
    },
    readDir: (abs) => {
      const children = childrenByDir.get(abs);
      if (children === undefined) {
        return [];
      }
      return [...children.entries()].map(([name, isDirectory]) => dirEntry(name, isDirectory));
    },
    realPath: (abs) => abs,
    exists: (abs) => contentByAbs.has(abs) || childrenByDir.has(abs),
    readFileBytes: (abs, maxBytes) => {
      const encoded = encodedContent(contentByAbs, encoder, abs);
      if (encoded === undefined) {
        return Promise.reject(new Error(`ENOENT: ${abs}`));
      }
      return Promise.resolve(encoded.subarray(0, Math.min(encoded.length, Math.max(0, maxBytes))));
    },
    readFileRange: (abs, startByte, length) => {
      const encoded = encodedContent(contentByAbs, encoder, abs);
      if (encoded === undefined) {
        return Promise.reject(new Error(`ENOENT: ${abs}`));
      }
      const start = Math.max(0, startByte);
      return Promise.resolve(encoded.subarray(start, Math.min(encoded.length, start + length)));
    },
  };
}

function buildScope() {
  return {
    workspace: {
      root: MEM_ROOT,
      name: "bench",
      version: "0.0.0",
      testFramework: "unknown",
      sourceDirs: ["src"],
      testDirs: ["tests"],
      languages: ["typescript", "javascript"],
      ignoreLines: [],
    },
    scopeId: "bench",
    relativePaths: [],
  };
}

async function measureLatency(budget) {
  const files = buildFixtureFiles(budget.fixtureFileCount);
  const fs = buildFixtureFs(files);
  const scope = buildScope();
  const query = {
    kind: "natural-language",
    text: "Which Java version does this project use and where is the handler function?",
    caseSensitive: false,
    maxResults: 100,
    emittedAtMs: 0,
  };
  const run = async () => {
    await searchText(scope, query, DEFAULT_SEARCH_LIMITS, {
      fs,
      searchHints: { retrievalIntent: "project-metadata" },
    });
  };
  for (let i = 0; i < budget.warmupIterations; i += 1) {
    await run();
  }
  const samples = [];
  for (let i = 0; i < budget.iterations; i += 1) {
    const start = performance.now();
    await run();
    samples.push(performance.now() - start);
  }
  return samples;
}

export async function runRetrievalLatencyCheck({
  budgetPath = DEFAULT_BUDGET_PATH,
  log,
  fail,
} = {}) {
  const onLog = log ?? ((message) => console.log(message));
  const onFail =
    fail ??
    ((message) => {
      console.error(`retrieval-latency check failed: ${message}`);
      process.exit(1);
    });
  const budget = JSON.parse(readFileSync(budgetPath, "utf8"));
  const samples = await measureLatency(budget);
  const observedMs = percentile(samples, budget.percentile);
  const result = evaluateLatencyBudget({ observedMs, budgetMs: budget.budgetMs });
  onLog(
    `retrieval-latency: p${String(budget.percentile)}=${observedMs.toFixed(1)}ms over ${String(
      budget.iterations,
    )} iterations on a ${String(budget.fixtureFileCount)}-file fixture (budget ${String(
      budget.budgetMs,
    )}ms).`,
  );
  if (!result.ok) {
    onFail(
      `p${String(budget.percentile)} ${observedMs.toFixed(1)}ms exceeds budget ${String(budget.budgetMs)}ms`,
    );
  }
  return result;
}

// Run when invoked directly, not when imported by a test.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runRetrievalLatencyCheck();
}
