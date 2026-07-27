const WORKER_PATH = "packages/keiko-local-knowledge/src/retrieval/usearch-index-worker.ts";
const LAUNCHER_PATH = "packages/keiko-local-knowledge/src/retrieval/usearch-ann-index.ts";
const KNOWLEDGE_PATH = "packages/keiko-local-knowledge/src/retrieval/vector-index.ts";
const MEMORY_PATH = "packages/keiko-server/src/memory-retrieval-signals.ts";
const REPO_PATH = "packages/keiko-server/src/grounded-repo-semantic-search.ts";

function count(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

function requirePattern(failures, sources, path, pattern, message) {
  if (!pattern.test(sources.get(path) ?? "")) failures.push(`${path}: ${message}`);
}

function checkNativeWorker(failures, sources) {
  const worker = sources.get(WORKER_PATH) ?? "";
  const launcher = sources.get(LAUNCHER_PATH) ?? "";
  if (count(worker, /new\s+runtime\.CompiledIndex\s*\(/gu) !== 1) {
    failures.push(`${WORKER_PATH}: exactly one reviewed native USearch constructor is required.`);
  }
  if (/\bindex\.(?:save|load|view)\s*\(/u.test(worker)) {
    failures.push(`${WORKER_PATH}: native index persistence APIs are forbidden.`);
  }
  if (/readonly\s+(?:save|load|view)\s*:/u.test(worker)) {
    failures.push(`${WORKER_PATH}: the native capability interface must remain search-only.`);
  }
  requirePattern(
    failures,
    sources,
    LAUNCHER_PATH,
    /new\s+URL\(\s*"\.\/usearch-index-worker\.js"\s*,\s*import\.meta\.url\s*\)/u,
    "the worker entrypoint must remain the reviewed usearch-index-worker module.",
  );
  if (count(launcher, /new\s+Worker\s*\(/gu) !== 1) {
    failures.push(`${LAUNCHER_PATH}: exactly one reviewed USearch worker launcher is required.`);
  }
}

function checkSharedComposition(failures, sources) {
  requirePattern(
    failures,
    sources,
    KNOWLEDGE_PATH,
    /\bsearchUsearchAnnIndex\s*\(/u,
    "Local Knowledge must compose the shared vector-index service.",
  );
  requirePattern(
    failures,
    sources,
    MEMORY_PATH,
    /\bsearchUsearchAnnIndex\s*\(/u,
    "memory retrieval must compose the shared vector-index service.",
  );
}

function checkRepositorySearch(failures, sources) {
  const repo = sources.get(REPO_PATH) ?? "";
  if (
    /requestOpenAIEmbedding(?:Batch)?\b|function\s+legacyHits\b|documentVectorCache\b/u.test(repo)
  ) {
    failures.push(`${REPO_PATH}: retired ask-time whole-file embedding is forbidden.`);
  }
}

function checkRetiredProductionCapabilities(failures, sources) {
  for (const [path, source] of sources) {
    if (path.endsWith(".test.ts")) continue;
    if (/\bsqlite[-_]vec\b|\bvec0\s*\(/iu.test(source)) {
      failures.push(`${path}: retired sqlite-vec production integration is forbidden.`);
    }
    if (
      /packages\/keiko-local-knowledge\/src\/store(?:\/|\.ts$)/u.test(path) &&
      /\b(?:allowExtension|enableLoadExtension|loadExtension)\b/u.test(source)
    ) {
      failures.push(`${path}: SQLite extension authority must remain denied.`);
    }
  }
}

export function vectorIndexArchitectureFailures(sources) {
  const failures = [];
  checkNativeWorker(failures, sources);
  checkSharedComposition(failures, sources);
  checkRepositorySearch(failures, sources);
  checkRetiredProductionCapabilities(failures, sources);
  return failures;
}
