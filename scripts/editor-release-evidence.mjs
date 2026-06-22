// Keiko Editor release-evidence bundle measurement (Issue #1209; ADR-0042 D3.6).
//
// ADR-0042 D3.6 assigns #1207 to "measure and enforce" the editor performance budgets that regress
// deterministically (the editor own-code gzip ceiling, the Monaco version pin, and the 0-bytes-in-
// first-load code-split isolation — all enforced by `scripts/editor-bundle-size.mjs`) and assigns
// #1209 to "record release evidence" for the budgets that require the real production bundle:
//
//   B1  Monaco/editor bytes in the static-export first-load JavaScript  — must be 0
//   B2  Lazy editor + Monaco runtime gzip total                          — ≤ 2,621,440 B (2.5 MB)
//   B3  Per Monaco worker chunk gzip                                     — ≤ 768,000 B  (750 KB)
//
// This script measures B1/B2/B3 against the production static export produced by `npm run build:ui`
// (`packages/keiko-ui/out`). It is deterministic (gzip level 9), read-only, and emits both a human
// table and a machine-readable JSON record (with `--json`) for the closure-evidence document.
//
// Worker-loading nuance (D4): the keiko-ui host disables every built-in Monaco TypeScript/JavaScript
// language-service feature (`editorMonacoRuntime.ts` `setModeConfiguration(GOVERNED_LANGUAGE_SERVICE
// _MODE)`) and the governed v1 worker factory ships only Monaco's editor worker. This script enforces
// B2/B3 against what SHIPS in the production static export. Loaded-worker diagnostics are kept as
// runtime evidence, but they cannot turn an oversized shipped export into a pass.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { URL } from "node:url";
import {
  extractInitialScriptSrcs,
  findForbiddenStaticExportMarkers,
  gzipSizeBytes,
} from "./editor-bundle-size.mjs";

// ─── Budgets (authoritative: ADR-0042 D3.6) ────────────────────────────────────────────────────────

export const RELEASE_EVIDENCE_BUDGETS = {
  // B2: lazy editor + Monaco runtime total, gzip. 2.5 MiB, matching
  // scripts/editor-bundle-size.budget.json `lazyEditorPlusMonacoRuntimeGzipBytesBudget`.
  lazyEditorPlusMonacoRuntimeGzipBytesBudget: 2_621_440,
  // B3: per Monaco worker chunk, gzip. 750 KB.
  perWorkerChunkGzipBytesBudget: 768_000,
};

// ─── Pure classification helpers (no I/O) ───────────────────────────────────────────────────────────

/**
 * Markers that identify a chunk as Monaco/editor runtime code. A superset of the first-load forbidden
 * markers in editor-bundle-size.mjs; any chunk containing one of these is part of the lazily-loaded
 * editor + Monaco runtime (B2) rather than the always-loaded app shell.
 */
export const EDITOR_RUNTIME_MARKERS = [
  "monaco-editor",
  "@monaco-editor/react",
  "@oscharko-dev/keiko-editor",
  "MonacoEnvironment",
  "editorWorkerService",
  "EditorSimpleWorker",
  "vs/editor/",
  "vs/language/",
  "vs/base/common/worker",
];

/**
 * Discriminators for each Monaco worker, verified against the monaco-editor 0.55.1 production chunks
 * in this static export. Each language worker has a top-level identifier that survives minification
 * and appears in exactly that worker's chunk; the editor worker carries the diff/link/colour
 * computers (`DiffComputer` + `computeLinks`) but, unlike the main-thread editor chunk, never
 * references the `@monaco-editor/react` host loader. Classification is priority-ordered: the
 * language-service workers share a common base (`getSelectionRanges`/`getFoldingRanges`), so the CSS
 * worker is the language worker that is none of ts/html/json.
 */
function hasAll(source, needles) {
  return needles.every((needle) => source.includes(needle));
}

export function classifyWorkerLabel(source) {
  // The main-thread chunks bundle the worker proxy interfaces (DiffComputer, computeLinks) and the
  // worker-environment setup, but are not themselves workers. A worker body never references the
  // `@monaco-editor/react` host loader nor installs `MonacoEnvironment` (the main thread does that),
  // so either marker disqualifies a chunk from being a worker.
  if (source.includes("@monaco-editor/react") || source.includes("MonacoEnvironment")) {
    return null;
  }
  if (source.includes("ScriptElementKind")) {
    return "ts"; // TypeScript language worker (bundles the TS services).
  }
  if (source.includes("doTagComplete")) {
    return "html"; // HTML language worker.
  }
  if (source.includes("getMatchingSchemas")) {
    return "json"; // JSON language worker.
  }
  if (hasAll(source, ["DiffComputer", "computeLinks"])) {
    return "editor"; // editor.worker: diff/link/colour/basic-completion computers.
  }
  if (source.includes("getSelectionRanges") && source.includes("getFoldingRanges")) {
    return "css"; // CSS/SCSS/LESS language worker (the language worker that is none of the above).
  }
  return null;
}

/** True when the chunk source contains any editor/Monaco runtime marker, or is a Monaco worker. */
export function isEditorRuntimeChunk(source) {
  return (
    EDITOR_RUNTIME_MARKERS.some((marker) => source.includes(marker)) ||
    classifyWorkerLabel(source) !== null
  );
}

/**
 * Evaluate B2/B3 from a classified chunk inventory. `chunks` is a list of
 * `{ path, gzipBytes, isEditorRuntime, workerLabel }`. The authoritative #1209/ADR-0042 budget
 * evidence is the shipped production static export; loaded-worker totals are diagnostics only.
 */
export function evaluateBundleBudgets(chunks, budgets = RELEASE_EVIDENCE_BUDGETS) {
  const editorRuntime = chunks.filter((c) => c.isEditorRuntime);
  const workers = chunks.filter((c) => c.workerLabel !== null);
  const disabledLanguageWorkers = workers.filter((c) => c.workerLabel !== "editor");
  const loadedRuntime = editorRuntime.filter(
    (c) => c.workerLabel === null || c.workerLabel === "editor",
  );

  const shipsTotal = editorRuntime.reduce((sum, c) => sum + c.gzipBytes, 0);
  const loadedTotal = loadedRuntime.reduce((sum, c) => sum + c.gzipBytes, 0);
  const largestWorker = workers.reduce((max, c) => (c.gzipBytes > max.gzipBytes ? c : max), {
    gzipBytes: 0,
    workerLabel: null,
    path: null,
  });
  const largestLoadedWorker = workers
    .filter((c) => c.workerLabel === "editor")
    .reduce((max, c) => (c.gzipBytes > max.gzipBytes ? c : max), {
      gzipBytes: 0,
      workerLabel: null,
      path: null,
    });

  return {
    b2: {
      budgetBytes: budgets.lazyEditorPlusMonacoRuntimeGzipBytesBudget,
      shipsTotalBytes: shipsTotal,
      loadedTotalBytes: loadedTotal,
      // B2 is enforced against the shipped production editor + Monaco runtime.
      ok: shipsTotal <= budgets.lazyEditorPlusMonacoRuntimeGzipBytesBudget,
      shipsOk: shipsTotal <= budgets.lazyEditorPlusMonacoRuntimeGzipBytesBudget,
      loadedOk: loadedTotal <= budgets.lazyEditorPlusMonacoRuntimeGzipBytesBudget,
    },
    b3: {
      budgetBytes: budgets.perWorkerChunkGzipBytesBudget,
      largestWorkerBytes: largestWorker.gzipBytes,
      largestWorkerLabel: largestWorker.workerLabel,
      largestLoadedWorkerBytes: largestLoadedWorker.gzipBytes,
      largestLoadedWorkerLabel: largestLoadedWorker.workerLabel,
      // B3 is enforced against the largest shipped worker chunk.
      ok: largestWorker.gzipBytes <= budgets.perWorkerChunkGzipBytesBudget,
      shipsOk: largestWorker.gzipBytes <= budgets.perWorkerChunkGzipBytesBudget,
      loadedOk: largestLoadedWorker.gzipBytes <= budgets.perWorkerChunkGzipBytesBudget,
    },
    workers: workers.map((c) => ({ label: c.workerLabel, gzipBytes: c.gzipBytes, path: c.path })),
    disabledLanguageWorkers: disabledLanguageWorkers.map((c) => ({
      label: c.workerLabel,
      gzipBytes: c.gzipBytes,
    })),
    editorRuntimeChunkCount: editorRuntime.length,
  };
}

// ─── Runner (I/O) ─────────────────────────────────────────────────────────────────────────────────

function walkJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkJsFiles(full));
    } else if (entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

function measureFirstLoad(repoRoot, outDir) {
  const indexHtml = join(outDir, "index.html");
  const scriptSrcs = extractInitialScriptSrcs(readFileSync(indexHtml, "utf8"));
  const files = [];
  for (const src of scriptSrcs) {
    const pathname = decodeURIComponent(new URL(src, "https://keiko.local").pathname).replace(
      /^\/+/,
      "",
    );
    const scriptPath = join(outDir, pathname);
    if (existsSync(scriptPath)) {
      files.push({
        path: relative(repoRoot, scriptPath).split(sep).join("/"),
        content: readFileSync(scriptPath, "utf8"),
      });
    }
  }
  const findings = findForbiddenStaticExportMarkers({ files });
  return { firstLoadScriptCount: files.length, monacoMarkerFindings: findings };
}

export function measureReleaseEvidence(repoRoot) {
  const outDir = join(repoRoot, "packages", "keiko-ui", "out");
  if (!existsSync(outDir)) {
    throw new Error(
      `Static export ${relative(repoRoot, outDir)} not found. Run \`npm run build:ui\` first.`,
    );
  }
  const chunkDir = join(outDir, "_next", "static", "chunks");
  const chunkFiles = walkJsFiles(chunkDir);
  const chunks = chunkFiles.map((path) => {
    const buffer = readFileSync(path);
    const source = buffer.toString("utf8");
    return {
      path: relative(repoRoot, path).split(sep).join("/"),
      rawBytes: buffer.length,
      gzipBytes: gzipSizeBytes(buffer),
      isEditorRuntime: isEditorRuntimeChunk(source),
      workerLabel: classifyWorkerLabel(source),
    };
  });

  const firstLoad = measureFirstLoad(repoRoot, outDir);
  const budgets = evaluateBundleBudgets(chunks);
  return {
    b1: {
      firstLoadScriptCount: firstLoad.firstLoadScriptCount,
      monacoMarkersInFirstLoad: firstLoad.monacoMarkerFindings.length,
      ok: firstLoad.monacoMarkerFindings.length === 0,
    },
    ...budgets,
    editorRuntimeChunks: chunks
      .filter((c) => c.isEditorRuntime || c.workerLabel !== null)
      .sort((a, b) => b.gzipBytes - a.gzipBytes)
      .map((c) => ({
        path: c.path,
        gzipBytes: c.gzipBytes,
        rawBytes: c.rawBytes,
        workerLabel: c.workerLabel,
      })),
  };
}

function fmtKiB(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function verdict(ok) {
  return ok ? "PASS" : "FAIL";
}

function printReport(record) {
  const lines = [];
  lines.push("Keiko Editor release-evidence bundle measurement (Issue #1209, ADR-0042 D3.6)");
  lines.push("");
  lines.push(
    `B1  first-load Monaco/editor bytes: ${verdict(record.b1.ok)} ` +
      `(${String(record.b1.monacoMarkersInFirstLoad)} markers across ${String(record.b1.firstLoadScriptCount)} first-load scripts; budget 0)`,
  );
  lines.push(
    `B2  shipped lazy editor + Monaco runtime: ${verdict(record.b2.ok)} ` +
      `${fmtKiB(record.b2.shipsTotalBytes)} / ${fmtKiB(record.b2.budgetBytes)}`,
  );
  lines.push(
    `    (loaded editor-session diagnostic: ${verdict(record.b2.loadedOk)} ` +
      `${fmtKiB(record.b2.loadedTotalBytes)} / ${fmtKiB(record.b2.budgetBytes)})`,
  );
  lines.push(
    `B3  largest shipped Monaco worker (${record.b3.largestWorkerLabel ?? "none"}): ` +
      `${verdict(record.b3.ok)} ${fmtKiB(record.b3.largestWorkerBytes)} / ${fmtKiB(record.b3.budgetBytes)}`,
  );
  lines.push(
    `    (loaded editor-worker diagnostic: ${verdict(record.b3.loadedOk)} ` +
      `${record.b3.largestLoadedWorkerLabel ?? "none"} ${fmtKiB(record.b3.largestLoadedWorkerBytes)} / ${fmtKiB(record.b3.budgetBytes)})`,
  );
  lines.push("");
  lines.push("Monaco worker chunks (gzip):");
  for (const w of record.workers.sort((a, b) => b.gzipBytes - a.gzipBytes)) {
    lines.push(`  ${w.label.padEnd(7)} ${fmtKiB(w.gzipBytes).padStart(11)}  ${w.path}`);
  }
  lines.push("");
  lines.push("Editor + Monaco runtime chunks (gzip, descending):");
  for (const c of record.editorRuntimeChunks) {
    const tag = c.workerLabel ? `[worker:${c.workerLabel}]` : "[runtime]";
    lines.push(`  ${fmtKiB(c.gzipBytes).padStart(11)}  ${tag.padEnd(16)} ${c.path}`);
  }
  return lines.join("\n");
}

if (process.argv[1] && process.argv[1].endsWith("editor-release-evidence.mjs")) {
  const repoRoot = process.cwd();
  const record = measureReleaseEvidence(repoRoot);
  if (process.argv.includes("--json")) {
    const outPath = join(repoRoot, "docs", "release", "1209-bundle-evidence.json");
    writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    console.log(`Wrote ${relative(repoRoot, outPath)}`);
  }
  console.log(printReport(record));
  const failed = !record.b1.ok || !record.b2.ok || !record.b3.ok;
  process.exit(failed ? 1 : 0);
}
