#!/usr/bin/env node
// #4430: repeatable recursive-search measurement on the real filesystem of the host it runs on.
//
// Epic #4429 needs the same content measured on native Windows 11 and on macOS. This script
// writes one deterministic synthetic corpus into a fresh temporary directory and runs Keiko's real
// `searchText` and Knowledge Pod `walkSource` from the built packages over it. It covers the
// scenarios of #4430 that need no personal data:
//
//   nested     facts at depth 5-7 in mixed formats, one CRLF file (the #4161 shape)
//   connected  two connected subfolders whose facts one question needs together
//   casing     `SCAN.TXT`, `Readme.MD` and a `.gitignore` whose rules differ in case from the files
//   protected  an exclusively locked file (Windows), an Office `~$` owner file and a read-denied file
//   no-match   a question no file answers
//   repo       optional: a large repository such as a `git archive` of Keiko (`--repo <dir>`)
//
// Never point `--repo` or `--parent` at a cloud-synchronized folder such as OneDrive: reading a
// cloud-only placeholder downloads it. The synthetic corpus is written to the temporary directory.
//
// Output is body-free: scenario and question ids, counts, durations, closed outcomes and the host
// class. The last line is `measure-recursive-search: PASS` or `FAIL`; durations never decide it.
//
// Usage (after `npm run build:packages`):
//   node scripts/testing/measure-recursive-search.mjs [--files <n>] [--repo <dir>] [--parent <dir>]
//     [--keep]

import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { availableParallelism, release, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

import { isMainModule } from "../lib/is-main-module.mjs";

export const DEFAULT_FILLER_FILES = 5000;
const FILLER_WORDS =
  "project report customer invoice meeting delivery department planning analysis contract offer minutes strategy goal process quality risk resource team status version release review maintenance server network training handbook".split(
    " ",
  );
const DEPARTMENTS = ["sales", "purchasing", "people", "it", "finance", "production", "marketing"];
const FILLER_EXTENSIONS = [".md", ".txt", ".csv", ".json"];
export const LOCKED_FILE = "profile/Documents/Report.docx.txt";
export const OWNER_FILE = "profile/Documents/~$Report.docx";
export const DENIED_FILE = "profile/Documents/denied.txt";

// ─── Pure helpers (unit-tested) ─────────────────────────────────────────────────

export function createRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

function sentence(random) {
  const length = 8 + Math.floor(random() * 10);
  const words = Array.from(
    { length },
    () => FILLER_WORDS[Math.floor(random() * FILLER_WORDS.length)],
  );
  return `${words.join(" ")}.`;
}

function paragraph(random, count) {
  return Array.from({ length: count }, () => sentence(random)).join(" ");
}

function fillerText(random, extension, label) {
  if (extension === ".csv") {
    const rows = Array.from(
      { length: 12 },
      (_, i) => `${String(i)};${FILLER_WORDS[i]};${String(i * 7)}`,
    );
    return `row;item;amount\n${rows.join("\n")}\n`;
  }
  if (extension === ".json") {
    return `${JSON.stringify({ label, note: sentence(random) }, null, 2)}\n`;
  }
  return `# ${label}\n\n${paragraph(random, 5)}\n\n${paragraph(random, 4)}\n`;
}

export function fillerFiles(count, random) {
  const files = [];
  for (let index = 0; index < count; index += 1) {
    const department = DEPARTMENTS[index % DEPARTMENTS.length];
    const year = 2019 + (Math.floor(index / DEPARTMENTS.length) % 8);
    const quarter = 1 + (Math.floor(index / 56) % 4);
    const extension = FILLER_EXTENSIONS[index % FILLER_EXTENSIONS.length];
    const label = `${department} ${String(year)} Q${String(quarter)} document ${String(index)}`;
    files.push({
      path: `archive/${department}/${String(year)}/Q${String(quarter)}/notes/doc-${String(index)}${extension}`,
      text: fillerText(random, extension, label),
    });
  }
  return files;
}

function factFiles(random) {
  return [
    {
      path: "archive/it/2024/Q3/notes/network/router-config.md",
      text: `# Router\n\n${paragraph(random, 3)}\n\nThe admin network of the harbour site uses VLAN 4711 for the router.\n\n${paragraph(random, 3)}\n`,
    },
    {
      path: "archive/finance/2025/Q2/notes/budget/Annual-Budget-2026.TXT",
      text: `${paragraph(random, 4)}\nThe approved IT budget for 2026 is 1,284,500 euros, of which 312,000 euros are for cloud services.\n${paragraph(random, 4)}\n`,
    },
    {
      path: "archive/people/2023/Q1/notes/policies/Remote-Work-Policy.md",
      text: `# Remote work\r\n\r\n${paragraph(random, 3)}\r\nEmployees may work remotely on at most three days per week.\r\n${paragraph(random, 2)}\r\n`,
    },
    {
      path: "archive/marketing/2025/Q4/notes/campaigns/Winter-Campaign.JSON",
      text: `${JSON.stringify({ campaign: "Winterlight", start: "2025-11-20", campaignBudgetEuro: 48000 }, null, 2)}\n`,
    },
  ];
}

function scenarioFiles(random) {
  return [
    {
      path: "team-alpha/README.md",
      text: `# Project Atlas\n\n${paragraph(random, 3)}\n\nProject Atlas is led by Lena Brandt and goes live in June 2027.\n`,
    },
    {
      path: "team-beta/docs/status/Status.md",
      text: `# Boreas status\n\n${paragraph(random, 3)}\n\nProject Boreas has a remaining budget of 87,300 euros.\n`,
    },
    {
      path: "cases/SCAN.TXT",
      text: "Scanned invoice number INV-7731 belongs to the harbour order.\n",
    },
    { path: "cases/Readme.MD", text: "The readme code word is HELIOTROPE.\n" },
    {
      path: "cases/Debug.LOG",
      text: "Ignored decoy: invoice INV-7731 and code word HELIOTROPE.\n",
    },
    {
      path: "Build/output.txt",
      text: "Ignored decoy: invoice INV-7731 and code word HELIOTROPE.\n",
    },
    { path: ".gitignore", text: "*.log\nbuild/\n" },
    { path: LOCKED_FILE, text: "The locked report mentions QUASAR-5521.\n" },
    { path: OWNER_FILE, text: "owner-lock\n" },
    { path: DENIED_FILE, text: "The denied note mentions QUASAR-5521.\n" },
    { path: "profile/Documents/after-lock.txt", text: "The sibling note mentions QUASAR-5521.\n" },
  ];
}

const QUESTIONS = [
  {
    id: "nested-vlan",
    scenario: "nested",
    text: "Which VLAN does the admin network of the harbour site use?",
    expected: ["archive/it/2024/Q3/notes/network/router-config.md"],
  },
  {
    id: "nested-budget",
    scenario: "nested",
    text: "What is the approved IT budget for 2026?",
    expected: ["archive/finance/2025/Q2/notes/budget/Annual-Budget-2026.TXT"],
  },
  {
    id: "nested-crlf",
    scenario: "nested",
    text: "On how many days per week may employees work remotely?",
    expected: ["archive/people/2023/Q1/notes/policies/Remote-Work-Policy.md"],
  },
  {
    id: "nested-json",
    scenario: "nested",
    text: "What is the campaign budget of the Winterlight campaign?",
    expected: ["archive/marketing/2025/Q4/notes/campaigns/Winter-Campaign.JSON"],
  },
  {
    id: "connected-join",
    scenario: "connected",
    relativePaths: ["team-alpha", "team-beta"],
    text: "Who leads Project Atlas and what remaining budget does Project Boreas have?",
    expected: ["team-alpha/README.md", "team-beta/docs/status/Status.md"],
  },
  {
    id: "casing-scan",
    scenario: "casing",
    text: "Which order does the scanned invoice number INV-7731 belong to?",
    expected: ["cases/SCAN.TXT"],
    forbidden: ["cases/Debug.LOG", "Build/output.txt"],
  },
  {
    id: "casing-readme",
    scenario: "casing",
    text: "What is the readme code word HELIOTROPE?",
    expected: ["cases/Readme.MD"],
    forbidden: ["cases/Debug.LOG", "Build/output.txt"],
  },
  {
    id: "protected-sibling",
    scenario: "protected",
    text: "Which note mentions QUASAR-5521?",
    expected: ["profile/Documents/after-lock.txt"],
  },
  {
    id: "no-match",
    scenario: "no-match",
    text: "xylofrob qwindle marzipane vortrix",
    expected: [],
    expectNoAtoms: true,
  },
];

export function buildCorpusSpec({ fillerCount = DEFAULT_FILLER_FILES, seed = 4430 } = {}) {
  const random = createRandom(seed);
  return {
    files: [...fillerFiles(fillerCount, random), ...factFiles(random), ...scenarioFiles(random)],
    questions: QUESTIONS,
  };
}

export const REPO_QUESTIONS = [
  { id: "repo-cold", text: "Explain the workspace index snapshot encryption", expectAtoms: true },
  { id: "repo-new", text: "How does the gateway readiness check work?", expectAtoms: true },
  { id: "repo-definition", text: "Where is the ScoredLineCollector defined?", expectAtoms: true },
  {
    id: "repo-route",
    text: "Which handler serves POST /api/chats/messages/grounded?",
    expectAtoms: true,
  },
  { id: "repo-no-match", text: "xylofrob qwindle marzipane vortrix", expectNoAtoms: true },
];

export function atomPaths(atoms) {
  const paths = new Set();
  for (const atom of atoms) {
    const path = atom.scopePath ?? atom.path;
    if (typeof path === "string") paths.add(path.replaceAll("\\", "/"));
  }
  return paths;
}

function evaluateFiles(question, paths) {
  const missing = (question.expected ?? []).filter((path) => !paths.has(path));
  if (missing.length > 0)
    return { pass: false, reason: "expected-file-missing", missing: missing.length };
  const forbiddenHits = (question.forbidden ?? []).filter((path) => paths.has(path));
  if (forbiddenHits.length > 0) {
    return { pass: false, reason: "ignored-file-returned", forbiddenHits: forbiddenHits.length };
  }
  return { pass: true };
}

export function evaluateQuestion(question, outcome) {
  if (outcome.failed) return { pass: false, reason: "search-failed" };
  const files = evaluateFiles(question, outcome.paths);
  if (!files.pass) return files;
  if (question.expectNoAtoms === true && outcome.atomCount > 0)
    return { pass: false, reason: "unexpected-match" };
  if (question.expectAtoms === true && outcome.atomCount === 0)
    return { pass: false, reason: "no-match" };
  return files;
}

export function evaluateWalk(walk) {
  if (walk.failed) return { pass: false, reason: "walk-failed" };
  const missing = ["cases/SCAN.TXT", "cases/Readme.MD"].filter((path) => !walk.paths.has(path));
  if (missing.length > 0)
    return { pass: false, reason: "case-insensitive-glob-missed", missing: missing.length };
  return { pass: true };
}

export function evaluateProtection(protection, outcome) {
  if (!protection.applied) return { pass: true, observed: "not-applied" };
  // A match cap alone also makes coverage incomplete; only the io-error reason discloses the files.
  const disclosed =
    outcome.coverageIncomplete === true && outcome.coverageReasons?.includes("io-error");
  return disclosed
    ? { pass: true, observed: "disclosed" }
    : { pass: false, reason: "unreadable-file-undisclosed" };
}

export function parseArguments(argv) {
  const options = {
    fillerCount: DEFAULT_FILLER_FILES,
    repo: undefined,
    parent: tmpdir(),
    keep: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--keep") options.keep = true;
    else if (argument === "--files") options.fillerCount = parsePositiveInteger(argv[++index]);
    else if (argument === "--repo") options.repo = requireValue(argument, argv[++index]);
    else if (argument === "--parent") options.parent = requireValue(argument, argv[++index]);
    else throw new Error(`unknown argument: ${String(argument)}`);
  }
  return options;
}

function parsePositiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new Error("--files needs a non-negative integer");
  return parsed;
}

function requireValue(name, value) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} needs a value`);
  return value;
}

export function verdictLine(checks) {
  const failed = checks.filter((check) => !check.pass);
  return failed.length === 0
    ? "measure-recursive-search: PASS"
    : `measure-recursive-search: FAIL (${failed.map((check) => `${check.id}:${check.reason}`).join(", ")})`;
}

// ─── Runner (real filesystem) ───────────────────────────────────────────────────

async function writeCorpus(root, files) {
  for (const file of files) {
    const absolute = join(root, ...file.path.split("/"));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, file.text);
  }
}

function windowsAccount() {
  return `${process.env.USERDOMAIN ?? "."}\\${process.env.USERNAME ?? ""}`;
}

async function holdExclusiveLock(path) {
  const literal = path.replaceAll("'", "''");
  const script = `$f=[IO.File]::Open('${literal}','Open','ReadWrite','None');[Console]::Out.WriteLine('locked');[void][Console]::In.ReadLine();$f.Close()`;
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("locked")) resolve();
    });
    child.once("exit", () => reject(new Error("lock holder exited before locking")));
  });
  return async () => {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.stdin.end();
    await exited;
  };
}

async function applyProtections(root) {
  const denied = join(root, ...DENIED_FILE.split("/"));
  if (process.platform !== "win32") {
    await chmod(denied, 0o000);
    return { applied: true, kinds: ["denied"], release: () => chmod(denied, 0o600) };
  }
  spawnSync("attrib", ["+h", join(root, ...OWNER_FILE.split("/"))]);
  const deny = spawnSync("icacls", [denied, "/deny", `${windowsAccount()}:(R)`, "/Q"]);
  const unlock = await holdExclusiveLock(join(root, ...LOCKED_FILE.split("/")));
  return {
    applied: deny.status === 0,
    kinds: deny.status === 0 ? ["denied", "locked"] : ["locked"],
    release: async () => {
      await unlock();
      spawnSync("icacls", [denied, "/reset", "/Q"]);
    },
  };
}

async function loadPackages() {
  const workspace = await import("@oscharko-dev/keiko-workspace");
  const internalFs = await import("@oscharko-dev/keiko-workspace/internal/fs");
  const knowledge = await import("@oscharko-dev/keiko-local-knowledge");
  return {
    workspace,
    nodeWorkspaceFs: internalFs.nodeWorkspaceFs,
    walkSource: knowledge.walkSource,
  };
}

async function prepareSearch(packages, root) {
  const { workspace } = packages;
  // A connected folder need not be a repository, so detection starts at the root itself.
  const detected = workspace.detectWorkspaceAt(root);
  return {
    workspace: { ...detected, contentRedaction: "preserve" },
    index: workspace.createWorkspaceIndex(workspace.createInMemoryWorkspaceIndexStore()),
    limits: { ...workspace.DEFAULT_SEARCH_LIMITS, maxFilesScanned: null },
  };
}

async function measureQuestion(packages, search, question) {
  const query = {
    kind: "natural-language",
    text: question.text,
    caseSensitive: false,
    maxResults: 50,
    emittedAtMs: 0,
  };
  const scope = {
    workspace: search.workspace,
    scopeId: "measure",
    relativePaths: question.relativePaths ?? [],
  };
  const started = performance.now();
  try {
    const result = await packages.workspace.searchText(scope, query, search.limits, {
      workspaceIndex: search.index,
    });
    return {
      ms: Math.round(performance.now() - started),
      paths: atomPaths(result.atoms),
      atomCount: result.atoms.length,
      filesScanned: result.filesScanned,
      filesDiscovered: result.coverage.filesDiscovered,
      filesSkipped: result.coverage.filesSkipped,
      coverageIncomplete: result.coverage.incomplete,
      coverageReasons: result.coverage.reasons,
      unavailableEntries: result.coverage.unavailableEntriesByDiscovery ?? 0,
      reusedRecords: result.workspaceIndex?.reusedRecords,
    };
  } catch (error) {
    return {
      ms: Math.round(performance.now() - started),
      failed: true,
      errorClass: error?.constructor?.name,
    };
  }
}

function reportQuestion(scenario, question, outcome, verdict) {
  const { paths: _paths, ...counts } = outcome;
  console.log(
    JSON.stringify({ kind: "question", scenario, id: question.id, ...counts, ...verdict }),
  );
}

// The include globs are lower case on purpose: they must still select `SCAN.TXT` and `Readme.MD`.
const CASING_WALK = { includeGlobs: ["**/*.txt", "**/*.md"], excludeGlobs: [] };
// Without include globs every file is a candidate; the filler archive stays out so the walk's file
// limit cannot hide whether the Office `~$` owner file is ingested as a document.
const OWNER_FILE_WALK = { includeGlobs: [], excludeGlobs: ["archive/**"] };

function measureWalk(packages, root, globs) {
  const scope = { kind: "folder", rootPath: root, recursive: true, ...globs };
  const started = performance.now();
  const walk = { paths: new Set(), errors: {}, ownerFileIngested: false };
  try {
    for (const item of packages.walkSource(packages.nodeWorkspaceFs, scope))
      recordWalkItem(walk, item);
  } catch (error) {
    walk.failed = true;
    walk.errorClass = error?.constructor?.name;
  }
  walk.ms = Math.round(performance.now() - started);
  return walk;
}

function recordWalkItem(walk, item) {
  if (item.kind !== "file") {
    walk.errors[item.error.code] = (walk.errors[item.error.code] ?? 0) + 1;
    return;
  }
  const path = String(item.file.relativePath ?? item.file.scopePath ?? "").replaceAll("\\", "/");
  walk.paths.add(path);
  if (path.endsWith("~$Report.docx")) walk.ownerFileIngested = true;
}

async function runCorpus(packages, root, protection) {
  const search = await prepareSearch(packages, root);
  const checks = [];
  for (const question of QUESTIONS) {
    const outcome = await measureQuestion(packages, search, question);
    const verdict = evaluateQuestion(question, outcome);
    reportQuestion(question.scenario, question, outcome, verdict);
    checks.push({ id: question.id, ...verdict });
    if (question.scenario === "protected") {
      checks.push({ id: "protected-disclosure", ...evaluateProtection(protection, outcome) });
    }
  }
  const walk = measureWalk(packages, root, CASING_WALK);
  const walkVerdict = evaluateWalk(walk);
  reportWalk("knowledge-walk-casing", walk, walkVerdict);
  checks.push({ id: "knowledge-walk", ...walkVerdict });
  // Observation only: whether an Office owner file should be ingested is decided by #4437.
  reportWalk("knowledge-walk-owner-file", measureWalk(packages, root, OWNER_FILE_WALK), {});
  return checks;
}

function reportWalk(kind, walk, verdict) {
  const { paths, ...counts } = walk;
  console.log(JSON.stringify({ kind, files: paths.size, ...counts, ...verdict }));
}

async function runRepository(packages, repo) {
  const search = await prepareSearch(packages, repo);
  const checks = [];
  for (const question of REPO_QUESTIONS) {
    const outcome = await measureQuestion(packages, search, question);
    const verdict = evaluateQuestion(question, outcome);
    reportQuestion("repo", question, outcome, verdict);
    checks.push({ id: question.id, ...verdict });
  }
  return checks;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const packages = await loadPackages();
  const spec = buildCorpusSpec({ fillerCount: options.fillerCount });
  console.log(
    JSON.stringify({
      kind: "host",
      platform: process.platform,
      release: release(),
      node: process.version,
      cpus: availableParallelism(),
      corpusFiles: spec.files.length,
    }),
  );
  const root = await mkdtemp(join(options.parent, "keiko-recursive-search-"));
  let protection = { applied: false, release: () => Promise.resolve() };
  const checks = [];
  try {
    const written = performance.now();
    await writeCorpus(root, spec.files);
    protection = await applyProtections(root);
    console.log(
      JSON.stringify({
        kind: "corpus",
        writeMs: Math.round(performance.now() - written),
        protections: protection.kinds ?? [],
      }),
    );
    checks.push(...(await runCorpus(packages, root, protection)));
    if (options.repo !== undefined) checks.push(...(await runRepository(packages, options.repo)));
  } finally {
    await protection.release();
    if (!options.keep) await rm(root, { recursive: true, force: true });
  }
  const verdict = verdictLine(checks);
  console.log(verdict);
  process.exitCode = verdict.endsWith("PASS") ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  await main();
}
