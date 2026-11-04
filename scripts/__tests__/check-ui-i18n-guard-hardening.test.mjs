import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";

import {
  checkUiI18nGuard,
  isLiteralScanSource,
  isUiProductionSource,
  LITERAL_BASELINE,
  LITERAL_LEDGER_GENERATION,
  ledgerGrowthProblems,
  readBaseLiteralLedger,
  untranslatedLiteralsInSource,
} from "../check-ui-i18n-guard.mjs";

const texts = (source, file = "fixture.ts") =>
  untranslatedLiteralsInSource(source, file).findings.map((finding) => finding.text);

// --- registry fields through the AST ---------------------------------------------------------

test("sees a registry value the formatter moved onto its own line", () => {
  const source = 'export const A = {\n  label:\n    "Open the workspace settings",\n};\n';
  expect(texts(source)).toEqual(["Open the workspace settings"]);
});

test("sees both branches of a conditional registry value", () => {
  const source =
    'export const a = (on: boolean) => ({ label: on ? "Open file" : "Close file" });\n';
  expect(texts(source).sort()).toEqual(["Close file", "Open file"]);
});

test("sees a registry field with a quoted key", () => {
  expect(texts('export const A = { "title": "Hello there" };\n')).toEqual(["Hello there"]);
});

test("reports a same-line registry value exactly once", () => {
  expect(texts('export const A = { label: "Open file" };\n')).toEqual(["Open file"]);
});

test.each([
  ["a machine token", 'export const A = { label: "governed-assist" };\n'],
  ["a translated value", 'export const A = (t) => ({ label: t("feature.title") });\n'],
  ["a field outside the copy set", 'export const A = {\n  id:\n    "Open the settings",\n};\n'],
])("does not report %s", (_case, source) => {
  expect(texts(source)).toEqual([]);
});

test.each([
  [
    "above the property",
    'export const A = {\n  // i18n-exempt: internal fixture never rendered\n  label:\n    "Open the workspace settings",\n};\n',
  ],
  [
    "on the value line",
    'export const A = {\n  label:\n    "Open the workspace settings", // i18n-exempt: internal fixture never rendered\n};\n',
  ],
])("honours an exemption marker %s of a multi-line value", (_case, source) => {
  const scan = untranslatedLiteralsInSource(source, "fixture.ts");
  expect(scan.findings).toEqual([]);
  expect(scan.weakExemptions).toEqual([]);
});

test("rejects a wordless exemption on a multi-line registry value", () => {
  const source =
    'export const A = {\n  // i18n-exempt: no\n  label:\n    "Open the settings",\n};\n';
  expect(untranslatedLiteralsInSource(source, "fixture.ts").weakExemptions).toHaveLength(1);
});

// --- single lowercase words as JSX text ------------------------------------------------------

test("sees a single lowercase word rendered as JSX text", () => {
  expect(texts("export const A = () => <span>optional</span>;\n", "fixture.tsx")).toEqual([
    "optional",
  ]);
});

test.each([["code"], ["kbd"], ["pre"], ["samp"]])(
  "leaves a lowercase token inside <%s> alone, it is shown verbatim in every language",
  (tag) => {
    const source = `export const A = () => <${tag}>npm</${tag}>;\n`;
    expect(texts(source, "fixture.tsx")).toEqual([]);
  },
);

test("keeps treating a lowercase machine token in an attribute as code", () => {
  expect(texts('export const A = () => <X title="governed-assist" />;\n', "fixture.tsx")).toEqual(
    [],
  );
});

// --- keiko-editor is in scope for literals -----------------------------------------------------

const EDITOR_FILE = "packages/keiko-editor/src/components/Thing.tsx";

test.each([
  [EDITOR_FILE, true],
  ["packages/keiko-editor/src/commands.ts", true],
  ["packages/keiko-editor/src/components/Thing.test.tsx", false],
  ["packages/keiko-editor/src/types.d.ts", false],
  ["packages/keiko-editor/README.md", false],
  ["packages/keiko-ui/src/app/components/A.tsx", true],
  ["packages/keiko-server/src/a.ts", false],
])("isLiteralScanSource(%s) is %s", (file, expected) => {
  expect(isLiteralScanSource(file)).toBe(expected);
});

test("does not make the editor a catalog-owning UI source", () => {
  expect(isUiProductionSource(EDITOR_FILE)).toBe(false);
});

async function withRepo(files, callback) {
  const repoRoot = await mkdtemp(join(tmpdir(), "keiko-i18n-hardening-"));
  try {
    for (const [file, contents] of Object.entries(files)) {
      const absolute = join(repoRoot, file);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, contents, "utf8");
    }
    return await callback(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

const EDITOR_SOURCE = "export const A = () => <span>Open the file</span>;\n";

test("fails a new hardcoded literal in the editor", async () => {
  const result = await withRepo(
    { [LITERAL_BASELINE]: '{ "files": {} }\n', [EDITOR_FILE]: EDITOR_SOURCE },
    (repoRoot) => checkUiI18nGuard({ repoRoot, changedFiles: [EDITOR_FILE] }),
  );
  expect(result.ok).toBe(false);
  expect(result.problems.join("\n")).toContain("Open the file");
});

test("tolerates a ledgered editor literal without demanding a catalog the editor does not own", async () => {
  const ledger = { files: { [EDITOR_FILE]: ["Open the file"] } };
  const result = await withRepo(
    { [LITERAL_BASELINE]: JSON.stringify(ledger), [EDITOR_FILE]: EDITOR_SOURCE },
    (repoRoot) => checkUiI18nGuard({ repoRoot, changedFiles: [EDITOR_FILE] }),
  );
  expect(result.problems).toEqual([]);
});

// --- the ledger may only shrink ----------------------------------------------------------------

const ledgerDoc = (files, scannerGeneration = LITERAL_LEDGER_GENERATION) => ({
  scannerGeneration,
  files,
});

test("accepts a ledger that shrinks or stays equal", () => {
  const base = ledgerDoc({ "a.tsx": ["One", "Two"] });
  expect(ledgerGrowthProblems(base, base)).toEqual([]);
  expect(ledgerGrowthProblems(base, ledgerDoc({ "a.tsx": ["One"] }))).toEqual([]);
});

test("rejects a new literal added to the ledger", () => {
  const problems = ledgerGrowthProblems(
    ledgerDoc({ "a.tsx": ["One"] }),
    ledgerDoc({ "a.tsx": ["One", "Sneaked in"] }),
  );
  expect(problems.join("\n")).toContain("Sneaked in");
});

test("rejects a known literal copied into a second file, that is more debt", () => {
  const problems = ledgerGrowthProblems(
    ledgerDoc({ "a.tsx": ["One"] }),
    ledgerDoc({ "a.tsx": ["One"], "b.tsx": ["One"] }),
  );
  expect(problems.join("\n")).toContain("One");
});

test("accepts a known literal moving to another file, a rename adds no debt", () => {
  expect(
    ledgerGrowthProblems(ledgerDoc({ "a.tsx": ["One"] }), ledgerDoc({ "b.tsx": ["One"] })),
  ).toEqual([]);
});

test("allows growth only in the change that raises the scanner generation", () => {
  const base = ledgerDoc({ "a.tsx": ["One"] }, LITERAL_LEDGER_GENERATION - 1);
  const head = ledgerDoc({ "a.tsx": ["One", "Newly visible"] });
  expect(ledgerGrowthProblems(base, head)).toEqual([]);
});

test("treats a base ledger without a generation as generation one", () => {
  const head = ledgerDoc({ "a.tsx": ["Newly visible"] });
  expect(ledgerGrowthProblems({ files: {} }, head)).toEqual([]);
});

test.each([
  ["behind the scanner", LITERAL_LEDGER_GENERATION - 1],
  ["ahead of the scanner", LITERAL_LEDGER_GENERATION + 1],
])("rejects a ledger whose generation is %s", (_case, generation) => {
  const problems = ledgerGrowthProblems(
    ledgerDoc({ "a.tsx": ["One"] }),
    ledgerDoc({ "a.tsx": ["One"] }, generation),
  );
  expect(problems.join("\n")).toMatch(/generation/iu);
});

// --- reading the base ledger -------------------------------------------------------------------

async function withLedgerRepo(callback) {
  const repoRoot = await mkdtemp(join(tmpdir(), "keiko-i18n-ledger-"));
  const run = (args) => spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: "pipe" });
  const commitLedger = async (doc) => {
    const absolute = join(repoRoot, LITERAL_BASELINE);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, JSON.stringify(doc), "utf8");
    run(["add", "-A"]);
    run(["commit", "-q", "-m", "ledger"]);
  };
  try {
    run(["init", "-q", "-b", "dev"]);
    run(["config", "user.email", "test@example.com"]);
    run(["config", "user.name", "Test"]);
    run(["config", "commit.gpgsign", "false"]);
    return await callback(repoRoot, run, commitLedger);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

test("reads the ledger at the fork point, so dev shrinking later is not read as branch growth", async () => {
  const doc = await withLedgerRepo(async (repoRoot, run, commitLedger) => {
    await commitLedger({ files: { "a.tsx": ["One", "Two"] } });
    run(["checkout", "-q", "-b", "feature"]);
    await commitLedger({ files: { "a.tsx": ["One", "Two"], "b.tsx": ["Three"] } });
    run(["checkout", "-q", "dev"]);
    await commitLedger({ files: { "a.tsx": ["One"] } });
    run(["checkout", "-q", "feature"]);
    return readBaseLiteralLedger(repoRoot, { KEIKO_I18N_GUARD_BASE_REF: "dev" });
  });
  expect(doc.files).toEqual({ "a.tsx": ["One", "Two"] });
});

test("reads the ledger at an explicit base SHA", async () => {
  const doc = await withLedgerRepo(async (repoRoot, run, commitLedger) => {
    await commitLedger({ files: { "a.tsx": ["One"] } });
    const baseSha = run(["rev-parse", "HEAD"]).stdout.trim();
    await commitLedger({ files: { "a.tsx": ["One", "Two"] } });
    return readBaseLiteralLedger(repoRoot, { KEIKO_I18N_GUARD_BASE_SHA: baseSha });
  });
  expect(doc.files).toEqual({ "a.tsx": ["One"] });
});

test("fails closed when no base ledger can be read", async () => {
  await withLedgerRepo(async (repoRoot, _run, commitLedger) => {
    await commitLedger({ files: {} });
    expect(() => readBaseLiteralLedger(repoRoot, { KEIKO_I18N_GUARD_BASE_REF: "missing" })).toThrow(
      /base ledger/iu,
    );
  });
});
