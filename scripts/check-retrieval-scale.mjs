// Epic #4429 — connected-retrieval SCALE gate.
//
// `check:retrieval-quality` proves ranking on small fixtures. Nothing proved that a folder with tens
// of thousands of files still yields the right evidence and the right answer: the #4430 end-to-end
// run found a server crash (#4456), a misleading continuity referent (#4458) and minute-long scans
// only at that scale. This gate writes one deterministic, distractor-dense corpus (default 20,000
// files; `KEIKO_RETRIEVAL_SCALE_FILES` widens a local or nightly run) and asks every question through
// the real connected-context pipeline (`runConnectedRetrievalEval`).
//
// Per question it requires: the expected file is in the sent pack, its excerpt carries the fact line,
// and a deterministic extractive answerer — which can only quote what the pack actually contains —
// answers with the expected value and citation and never with a decoy value planted elsewhere in the
// corpus. It also records wall-clock and heap peak against committed ceilings.
//
// Non-tautology: after the measured run the gate removes one target file and asks again. That probe
// must fail; if it passes, the gate cannot detect a lost fact and fails closed.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { clearInterval, setInterval } from "node:timers";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUDGET_PATH = resolve(HERE, "check-retrieval-scale.budget.json");
const FILES_ENV = "KEIKO_RETRIEVAL_SCALE_FILES";

// ─── Deterministic corpus (pure, unit-tested) ─────────────────────────────────────

const WORDS = [
  "Projekt",
  "Bericht",
  "Kunde",
  "Rechnung",
  "Termin",
  "Lieferung",
  "Abteilung",
  "Planung",
  "Budget",
  "Analyse",
  "Vertrag",
  "Angebot",
  "Protokoll",
  "Meeting",
  "Strategie",
  "Ziel",
  "Prozess",
  "Qualitaet",
  "Risiko",
  "Ressource",
  "Team",
  "Status",
  "Version",
  "Freigabe",
  "Pruefung",
  "Wartung",
  "Server",
  "Netzwerk",
  "Schulung",
  "Handbuch",
];
const DEPARTMENTS = [
  "Vertrieb",
  "Einkauf",
  "Personal",
  "IT",
  "Finanzen",
  "Produktion",
  "Marketing",
  "Recht",
];
const CITIES = ["Hamburg", "Berlin", "Koeln", "Leipzig", "Dresden", "Kassel", "Bonn", "Ulm"];

/** Linear congruential generator; the same seed always yields the same corpus. */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return state / 4_294_967_296;
  };
}

function sentence(random) {
  const length = 8 + Math.floor(random() * 10);
  return `${Array.from({ length }, () => WORDS[Math.floor(random() * WORDS.length)]).join(" ")}.`;
}

function paragraph(random, sentences) {
  return Array.from({ length: sentences }, () => sentence(random)).join(" ");
}

// Decoys share the target's wording with a different subject and value, so a correct answer has to
// come from the right file, not from the most keyword-dense one.
function decoySentence(index) {
  const city = CITIES[index % CITIES.length];
  const kind = index % 4;
  if (kind === 0)
    return `Das Admin-Netz des Standorts ${city} nutzt das VLAN ${String(4800 + (index % 97))}.`;
  if (kind === 1)
    return `Das freigegebene IT-Budget fuer ${String(2015 + (index % 9))} betraegt ${String(500 + index)}.000 Euro.`;
  if (kind === 2)
    return `Der Rahmenvertrag mit der ${city} Spedition GmbH laeuft bis zum 30.06.${String(2030 + (index % 5))}.`;
  return `Fuer die Wartung der Anlage P-${String(index % 50)} ist Herr ${city}er zustaendig.`;
}

function fillerDocument(random, index) {
  const body = `${paragraph(random, 4)}\n\n${paragraph(random, 3)}\n`;
  return index % 7 === 0 ? `${body}\n${decoySentence(index)}\n` : body;
}

function fillerPath(index) {
  const department = DEPARTMENTS[index % DEPARTMENTS.length];
  const year = 2015 + (Math.floor(index / DEPARTMENTS.length) % 12);
  const quarter = 1 + (Math.floor(index / 96) % 4);
  const extension = [".md", ".txt", ".csv", ".json"][index % 4];
  return `firma/${department}/${String(year)}/Q${String(quarter)}/akte-${String(Math.floor(index / 384))}/dok-${String(index)}${extension}`;
}

function codeFile(random, index) {
  const name = `MODULE_${String(index)}_TIMEOUT_MS`;
  const value = 1_000 + Math.floor(random() * 50_000);
  return [
    `// Module ${String(index)} — generated scale fixture.`,
    `export const ${name} = ${String(value)};`,
    `export function run${String(index)}(input: number): number {`,
    `  return input * ${String(index % 13)} + ${name};`,
    "}",
    "",
  ].join("\n");
}

/**
 * Target facts, each with the question a person would ask, the answerer anchors, the value a correct
 * answer must contain and decoy values it must never contain.
 */
export const SCALE_CASES = [
  {
    id: "deep-markdown-vlan",
    path: "firma/IT/2024/Q3/akte-9/Netzwerk/Standorte/Nord/Bremen/Router-Konfiguration.md",
    fact: "Das Admin-Netz des Standorts Bremen nutzt das VLAN 4711 und den DHCP-Bereich 10.47.11.0/24.",
    question:
      "Welches VLAN nutzt das Admin-Netz am Standort Bremen und welcher DHCP-Bereich gilt dort?",
    anchors: ["Bremen", "VLAN"],
    expected: [/4711/u, /10\.47\.11\.0\/24/u],
    forbidden: [/VLAN 48\d\d/u],
  },
  {
    id: "uppercase-extension-budget",
    path: "firma/Finanzen/2025/Q2/Budget/Jahresbudget-2026.TXT",
    fact: "Das freigegebene IT-Budget fuer 2026 betraegt 1.284.500 Euro, davon 312.000 Euro fuer Cloud-Dienste.",
    question:
      "Wie hoch ist das freigegebene IT-Budget fuer 2026 und wie viel davon ist fuer Cloud-Dienste?",
    anchors: ["2026", "IT-Budget"],
    expected: [/1\.284\.500/u, /312\.000/u],
    forbidden: [/IT-Budget fuer 20(?:1\d|2[0-3])/u],
  },
  {
    id: "crlf-contract",
    path: "firma/Recht/2022/Q4/Vertraege/Rahmenvertrag-Nordlicht.md",
    fact: "Der Rahmenvertrag mit der Nordlicht Logistik GmbH laeuft bis zum 31.03.2028 und hat eine Kuendigungsfrist von sechs Monaten.",
    crlf: true,
    question:
      "Bis wann laeuft der Rahmenvertrag mit Nordlicht Logistik und welche Kuendigungsfrist gilt?",
    anchors: ["Nordlicht"],
    expected: [/31\.03\.2028/u, /sechs Monaten/u],
    forbidden: [/Spedition/u],
  },
  {
    id: "csv-row",
    path: "firma/Produktion/2026/Q1/Wartung/Wartungsplan.csv",
    table:
      "Anlage;Intervall;Verantwortlich\nPresse P-12;alle 400 Betriebsstunden;Herr Albers\nFraese F-3;monatlich;Frau Demir\nLackierstrasse L-1;quartalsweise;Herr Okafor\n",
    question: "Wer ist fuer die Wartung der Fraese F-3 verantwortlich und in welchem Intervall?",
    anchors: ["F-3"],
    expected: [/Demir/u, /monatlich/u],
    forbidden: [/Albers|Okafor/u],
  },
  {
    id: "uppercase-json",
    path: "firma/Marketing/2025/Q4/Kampagnen/Kampagne-Winter.JSON",
    json: { kampagne: "Winterlicht", start: "2025-11-20", budgetEuro: 48_000 },
    question: "Wie heisst die Winter-Kampagne und wie hoch ist ihr budgetEuro?",
    anchors: ["budgetEuro"],
    expected: [/48000/u],
    forbidden: [],
  },
  {
    id: "fact-at-end-of-large-file",
    path: "firma/IT/2023/Q2/Protokolle/Betriebsprotokoll-gross.md",
    fact: "Der Notfall-Rufnummer-Block des Rechenzentrums lautet RZ-NOT-9921.",
    padBytes: 400_000,
    question: "Wie lautet der Notfall-Rufnummer-Block des Rechenzentrums?",
    anchors: ["Notfall-Rufnummer-Block"],
    expected: [/RZ-NOT-9921/u],
    forbidden: [],
  },
  {
    id: "code-constant",
    path: "code/src/transport/sse-write.ts",
    code: "// Stalled readers are torn down after this window.\nexport const STALLED_READER_TIMEOUT_MS = 30_000;\n",
    question: "Welchen Wert hat STALLED_READER_TIMEOUT_MS?",
    anchors: ["STALLED_READER_TIMEOUT_MS"],
    expected: [/30_000/u],
    forbidden: [/MODULE_\d+_TIMEOUT_MS/u],
  },
];

function caseContent(testCase, random) {
  if (testCase.table !== undefined) return testCase.table;
  if (testCase.json !== undefined) return `${JSON.stringify(testCase.json, null, 2)}\n`;
  if (testCase.code !== undefined) return testCase.code;
  const padding = testCase.padBytes === undefined ? "" : paddingText(random, testCase.padBytes);
  const text = `# Dokument\n\n${paragraph(random, 3)}\n\n${padding}${testCase.fact}\n\n${paragraph(random, 2)}\n`;
  return testCase.crlf === true ? text.replaceAll("\n", "\r\n") : text;
}

function paddingText(random, bytes) {
  const lines = [];
  let size = 0;
  while (size < bytes) {
    const line = `${sentence(random)}\n`;
    lines.push(line);
    size += line.length;
  }
  return `${lines.join("")}\n`;
}

/** Builds the corpus as a path → content map; `fileCount` counts filler plus code files. */
export function buildScaleCorpus({ fileCount, seed = 4429, codeShare = 0.1 }) {
  const random = seededRandom(seed);
  const files = {};
  const codeCount = Math.floor(fileCount * codeShare);
  for (let index = 0; index < fileCount - codeCount; index += 1) {
    files[fillerPath(index)] = fillerDocument(random, index);
  }
  for (let index = 0; index < codeCount; index += 1) {
    files[`code/src/modules/group-${String(index % 40)}/module-${String(index)}.ts`] = codeFile(
      random,
      index,
    );
  }
  for (const testCase of SCALE_CASES) files[testCase.path] = caseContent(testCase, random);
  return files;
}

// ─── Extractive answerer and evaluation (pure, unit-tested) ───────────────────────

/** Quotes the first sent excerpt line that contains every anchor, with its citation. */
export function extractiveAnswer(pack, anchors) {
  for (const file of pack.files) {
    for (const excerpt of file.excerpts) {
      const start = excerpt.atom.lineRange?.startLine ?? 1;
      const lines = excerpt.content.split(/\r?\n/u);
      const index = lines.findIndex((line) => anchors.every((anchor) => line.includes(anchor)));
      if (index >= 0) return `${lines[index].trim()} [${file.scopePath}:${String(start + index)}]`;
    }
  }
  return "Dazu liegen in den gesendeten Auszuegen keine Informationen vor.";
}

export function evaluateScaleCase(testCase, pack, answer) {
  const sentPaths = pack.files.map((file) => file.scopePath);
  const fileHit = sentPaths.includes(testCase.path);
  const lineHit =
    fileHit &&
    extractiveAnswer(
      { files: pack.files.filter((f) => f.scopePath === testCase.path) },
      testCase.anchors,
    ).includes(`[${testCase.path}:`);
  const valueHit = testCase.expected.every((pattern) => pattern.test(answer));
  const decoy = testCase.forbidden.some((pattern) => pattern.test(answer));
  const cited = answer.includes(`[${testCase.path}:`);
  return {
    id: testCase.id,
    fileHit,
    lineHit,
    valueHit,
    cited,
    decoy,
    ok: fileHit && lineHit && valueHit && cited && !decoy,
  };
}

export function percentile(samples, p) {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/**
 * Each question walks the whole connected folder, so its duration grows with the file count: the
 * ceiling is a fixed base plus a per-thousand-files allowance, which keeps a widened nightly run
 * meaningful instead of failing on size alone.
 */
export function p95CeilingMs(budget, fileCount) {
  return budget.p95BaseMs + Math.ceil(fileCount / 1_000) * budget.p95MsPerThousandFiles;
}

export function evaluateScaleBudget({ results, durationsMs, heapPeakMiB, budget, fileCount }) {
  const failures = results
    .filter((result) => !result.ok)
    .map((result) => `${result.id}: ${describeMiss(result)}`);
  const p95 = percentile(durationsMs, 95);
  const ceiling = p95CeilingMs(budget, fileCount);
  if (p95 > ceiling)
    failures.push(
      `p95 ${p95.toFixed(0)}ms exceeds ${String(ceiling)}ms for ${String(fileCount)} files`,
    );
  if (heapPeakMiB > budget.heapPeakBudgetMiB)
    failures.push(
      `heap peak ${String(heapPeakMiB)}MiB exceeds ${String(budget.heapPeakBudgetMiB)}MiB`,
    );
  return { ok: failures.length === 0, p95, failures };
}

function describeMiss(result) {
  const parts = [];
  if (!result.fileHit) parts.push("file not sent");
  if (!result.lineHit) parts.push("fact line not in excerpt");
  if (!result.valueHit) parts.push("expected value missing from answer");
  if (!result.cited) parts.push("citation missing");
  if (result.decoy) parts.push("decoy value in answer");
  return parts.join(", ");
}

// ─── Runner ───────────────────────────────────────────────────────────────────────

export function resolveFileCount(budget, env = process.env) {
  const raw = env[FILES_ENV];
  if (raw === undefined || raw === "") return budget.fileCount;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < budget.minimumFileCount) {
    throw new RangeError(`${FILES_ENV} must be an integer >= ${String(budget.minimumFileCount)}`);
  }
  return parsed;
}

function materialize(root, files) {
  const created = new Set();
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    const parent = dirname(target);
    if (!created.has(parent)) {
      mkdirSync(parent, { recursive: true });
      created.add(parent);
    }
    writeFileSync(target, content);
  }
}

function heapSampler() {
  let peak = process.memoryUsage().heapUsed;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().heapUsed);
  }, 50);
  return {
    stop: () => {
      clearInterval(timer);
      return Math.round(Math.max(peak, process.memoryUsage().heapUsed) / 1_048_576);
    },
  };
}

async function askCase(runEval, root, testCase) {
  const started = performance.now();
  const { pack, answer } = await runEval({
    root,
    files: {},
    query: testCase.question,
    answerer: {
      answer: (_question, sentPack) =>
        Promise.resolve(extractiveAnswer(sentPack, testCase.anchors)),
    },
  });
  const durationMs = performance.now() - started;
  return { result: evaluateScaleCase(testCase, pack, answer?.assistantContent ?? ""), durationMs };
}

async function runCases(runEval, root, log) {
  const results = [];
  const durationsMs = [];
  for (const testCase of SCALE_CASES) {
    const { result, durationMs } = await askCase(runEval, root, testCase); // NOSONAR javascript:S9382 -- one question at a time, so each duration and the heap peak are its own
    results.push(result);
    durationsMs.push(durationMs);
    log(
      `retrieval-scale: ${testCase.id} ${result.ok ? "ok" : "MISS"} in ${durationMs.toFixed(0)}ms`,
    );
  }
  return { results, durationsMs };
}

async function regressionProbe(runEval, root) {
  const probeCase = SCALE_CASES[0];
  unlinkSync(join(root, probeCase.path));
  const { result } = await askCase(runEval, root, probeCase);
  return { detected: !result.ok };
}

export async function runRetrievalScaleCheck({
  budgetPath = DEFAULT_BUDGET_PATH,
  env = process.env,
  log,
  fail,
  runEval,
} = {}) {
  const onLog = log ?? ((message) => console.log(message));
  const onFail =
    fail ??
    ((message) => {
      console.error(`retrieval-scale check failed: ${message}`);
      process.exit(1);
    });
  const budget = JSON.parse(readFileSync(budgetPath, "utf8"));
  const evaluate =
    runEval ??
    (await import("../packages/keiko-server/dist/grounded-eval-support.js"))
      .runConnectedRetrievalEval;
  const fileCount = resolveFileCount(budget, env);
  const root = mkdtempSync(join(tmpdir(), "keiko-retrieval-scale-"));
  try {
    materialize(root, buildScaleCorpus({ fileCount }));
    onLog(
      `retrieval-scale: corpus of ${String(fileCount)} files plus ${String(SCALE_CASES.length)} targets written.`,
    );
    const sampler = heapSampler();
    const { results, durationsMs } = await runCases(evaluate, root, onLog);
    const heapPeakMiB = sampler.stop();
    const verdict = evaluateScaleBudget({
      results,
      durationsMs,
      heapPeakMiB,
      budget,
      fileCount,
    });
    const probe = await regressionProbe(evaluate, root);
    onLog(
      `retrieval-scale: correct=${String(results.filter((r) => r.ok).length)}/${String(results.length)} p95=${verdict.p95.toFixed(0)}ms heapPeak=${String(heapPeakMiB)}MiB probeDetected=${String(probe.detected)}`,
    );
    const failures = [
      ...verdict.failures,
      ...(probe.detected ? [] : ["regression probe passed: a removed fact went unnoticed"]),
    ];
    if (failures.length > 0) onFail(failures.join("; "));
    return { results, durationsMs, heapPeakMiB, verdict, probe };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runRetrievalScaleCheck();
}
