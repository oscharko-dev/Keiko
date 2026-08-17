import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";

import {
  DE_CATALOG,
  EN_CATALOG,
  I18N_EXEMPT_MIN_REASON,
  LITERAL_BASELINE,
  changedFilesFromGit,
  changedFilesFromInput,
  checkUiI18nGuard,
  hasI18nRelevantAddedLine,
  hasUserFacingTextLine,
  isTranslatableCopy,
  isUiProductionSource,
  untranslatedLiteralsInLine,
  untranslatedLiteralsInSource,
} from "../check-ui-i18n-guard.mjs";

const UI_FILE = "packages/keiko-ui/src/app/components/NewFeature.tsx";

async function writeRepoFile(repoRoot, file, contents) {
  const absolutePath = join(repoRoot, file);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents, "utf8");
}

async function withFixture(files, callback) {
  const repoRoot = await mkdtemp(join(tmpdir(), "keiko-i18n-guard-"));

  try {
    // The literal ledger is a required repository artifact (the guard fails loudly without it rather
    // than defaulting to "no known debt"), so every fixture repo carries one. A test that needs
    // pre-existing debt supplies its own via `baselineFixture`.
    const withBaseline = { [LITERAL_BASELINE]: '{ "files": {} }\n', ...files };
    for (const [file, contents] of Object.entries(withBaseline)) {
      await writeRepoFile(repoRoot, file, contents);
    }

    return await callback(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

function baselineFixture(entries) {
  return { [LITERAL_BASELINE]: `${JSON.stringify({ files: entries }, null, 2)}\n` };
}

const matchingCatalogs = {
  [EN_CATALOG]: 'export const EN_MESSAGES = {\n  "feature.title": "Title",\n} as const;\n',
  [DE_CATALOG]:
    'import type { MessageCatalog } from "./i18n-messages.en";\n\nexport const DE_MESSAGES = {\n  "feature.title": "Titel",\n} satisfies MessageCatalog;\n',
};

test("recognizes production UI source under the Keiko UI app tree", () => {
  expect(isUiProductionSource(UI_FILE)).toBe(true);
  expect(isUiProductionSource("packages/keiko-ui/src/app/components/NewFeature.test.tsx")).toBe(
    false,
  );
  // Strengthened, not relaxed: a `.ts` file under the UI tree IS production UI source. The previous
  // expectation (`false`) encoded the structural blind spot that let the whole window-type registry —
  // every window title, description and launcher-field label the three window-launching surfaces
  // render — ship as English literals with this gate reporting OK on every change to it.
  expect(isUiProductionSource("packages/keiko-ui/src/app/components/copy.ts")).toBe(true);
  expect(isUiProductionSource("packages/keiko-ui/src/lib/run-summary.ts")).toBe(true);
  expect(isUiProductionSource("packages/keiko-ui/src/app/components/copy.d.ts")).toBe(false);
  // The i18n layer itself is never a subject: catalogs, the provider, and `*-i18n.ts` helpers.
  expect(isUiProductionSource(EN_CATALOG)).toBe(false);
  expect(isUiProductionSource("packages/keiko-ui/src/lib/i18n-messages.optional.en.ts")).toBe(
    false,
  );
  expect(isUiProductionSource("packages/keiko-ui/src/lib/optional-widget-i18n.ts")).toBe(false);
  expect(
    isUiProductionSource("packages/keiko-ui/src/app/components/desktop/widgets/feature-i18n.ts"),
  ).toBe(false);
  expect(isUiProductionSource("src/server.ts")).toBe(false);
});

test("passes when changed files are outside UI production source", async () => {
  await withFixture(matchingCatalogs, (repoRoot) => {
    const result = checkUiI18nGuard({
      repoRoot,
      changedFiles: ["docs/architecture.md"],
    });

    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });
});

test("passes changed UI helper files without user-facing text", async () => {
  await withFixture(
    {
      ...matchingCatalogs,
      [UI_FILE]:
        "export function clampValue(value, min, max) {\n  return Math.max(min, Math.min(max, value));\n}\n",
    },
    (repoRoot) => {
      const result = checkUiI18nGuard({
        repoRoot,
        changedFiles: [UI_FILE],
      });

      expect(result.ok).toBe(true);
      expect(result.problems).toEqual([]);
      expect(result.i18nRelevantFiles).toEqual([]);
    },
  );
});

test("recognizes user-facing JSX, a11y attributes, and return strings", () => {
  expect(hasUserFacingTextLine("<p>Hard-coded text</p>")).toBe(true);
  expect(hasUserFacingTextLine("<section><p>Nested text</p></section>")).toBe(true);
  expect(hasUserFacingTextLine("<p>Wrong closing tag</span>")).toBe(false);
  expect(hasUserFacingTextLine('<p data-note="a > b">Visible text</p>')).toBe(true);
  expect(hasUserFacingTextLine("<><p>Fragment text</p></>")).toBe(true);
  expect(hasUserFacingTextLine('<p>{t("feature.title")}</p>')).toBe(false);
  expect(hasUserFacingTextLine('<button aria-label="Open">')).toBe(true);
  expect(hasUserFacingTextLine('return "Enter a name.";')).toBe(true);
  expect(
    hasUserFacingTextLine(
      "async (event: SubmitEvent<HTMLFormElement>): Promise<void> => undefined;",
    ),
  ).toBe(false);
  expect(hasUserFacingTextLine('<g transform="translate(10 10)">')).toBe(false);
  expect(hasUserFacingTextLine("// Called when the user opens a file.")).toBe(false);
});

// SonarCloud S8786 regression: USER_FACING_ATTRIBUTE_PATTERN's quoted-value alternatives used to
// sandwich the required letter between two unbounded [^"]* groups that both overlap the letter
// class, so an unterminated quoted attribute value made the engine try every split between the
// two groups — O(n^2) worst case. A 20,000-character attribute value with no closing quote must
// stay well under budget now that the leading group excludes letters.
test("stays fast on an unterminated attribute value with no closing quote", () => {
  const line = `title="${"a".repeat(20_000)}`;
  const start = Date.now();
  const result = hasUserFacingTextLine(line);
  expect(Date.now() - start).toBeLessThan(300);
  expect(result).toBe(false);
});

// SonarCloud S8786 regression (found while fixing the sibling above): the return-string check used
// a `"[^"]*\s[A-Za-z][^"]*"`-shaped alternation whose two unbounded groups both overlap the `\s`
// half of the pivot, so an unterminated quoted return value made the engine try every split between
// them — O(n^2) worst case (314ms observed at just 20,000 characters before the fix). A 100,000
// character return value with no closing quote must now resolve in well under budget.
test("stays fast on an unterminated return string with no closing quote", () => {
  const line = `return "${"a ".repeat(100_000)}`;
  const start = Date.now();
  const result = hasUserFacingTextLine(line);
  expect(Date.now() - start).toBeLessThan(300);
  expect(result).toBe(false);
});

test("still finds a whitespace/letter pivot that isn't the first whitespace in the return string", () => {
  // The first space (before "2") is not part of a valid pivot; only the second space (before "a")
  // is. A leading-quantifier fix that merely excludes letters (like the sibling attribute fix)
  // would stop scanning at the first space and miss this — the correct fix must not do that.
  expect(hasUserFacingTextLine('return "1 2 a";')).toBe(true);
  expect(hasUserFacingTextLine('return "1 2 3";')).toBe(false);
});

test("requires catalog review only for i18n-relevant added lines", () => {
  expect(hasI18nRelevantAddedLine('return <p>{t("feature.title")}</p>;')).toBe(true);
  expect(hasI18nRelevantAddedLine("return <p>{t(`feature.title`)}</p>;")).toBe(true);
  expect(hasI18nRelevantAddedLine("const t = useTranslate();")).toBe(true);
  expect(hasI18nRelevantAddedLine("const t = useOptionalWidgetTranslate();")).toBe(true);
  expect(hasI18nRelevantAddedLine("const t = useCodingWorkbenchTranslate();")).toBe(true);
  expect(hasI18nRelevantAddedLine("const i18n = useI18n();")).toBe(true);
  expect(hasI18nRelevantAddedLine('<I18nTranslate id="feature.title" />')).toBe(true);
  expect(hasI18nRelevantAddedLine("type T = OptionalWidgetTranslate;")).toBe(true);
  expect(hasI18nRelevantAddedLine('<button aria-label="Open">')).toBe(true);
  expect(hasI18nRelevantAddedLine("readonly titleRef: RefObject<HTMLElement | null>;")).toBe(false);
  expect(hasI18nRelevantAddedLine("// Improve compatibility with the current renderer.")).toBe(
    false,
  );
});

// `return \`...\`` looks identical to the heuristic whether the string is rendered to a user or only
// ever passed to `console.warn` — a redacted operator diagnostic has exactly this shape. The
// `i18n-exempt` marker the ledger scan already trusts for "provably not user-facing" now suppresses
// relevance here too, own-line only (this pre-filter sees a diffed, filtered list of added lines, not
// full source, so an "or the line above" lookup is not reliably available).
test("an i18n-exempt marker suppresses relevance for a diagnostic-only string return", () => {
  const line =
    "return `shell-shortcuts: refused override (${id})`; // i18n-exempt: console-only operator diagnostic, never rendered";
  expect(hasI18nRelevantAddedLine(line)).toBe(false);
});

// The counterpart: recognising the marker must not become a way to smuggle real UI copy past the
// gate. An identically-shaped return with no marker is still caught.
test("still requires review for the same shape with no i18n-exempt marker", () => {
  expect(hasI18nRelevantAddedLine("return `shell-shortcuts: refused override (${id})`;")).toBe(
    true,
  );
});

// And the marker cannot be used wordlessly here either — the ledger scan's own invariant, which this
// return-statement position is not covered by that scan's own weak-exemption check.
test("a wordless i18n-exempt does not suppress relevance for a string return", () => {
  expect(
    hasI18nRelevantAddedLine(
      "return `shell-shortcuts: refused override (${id})`; // i18n-exempt: x",
    ),
  ).toBe(true);
});

test("detects changed files from the push event before SHA", () => {
  const calls = [];
  const files = changedFilesFromGit(
    "repo",
    (_repoRoot, range) => {
      calls.push(range);
      return range === "abc1234..HEAD"
        ? { ok: true, error: "", files: [UI_FILE, EN_CATALOG, DE_CATALOG] }
        : { ok: false, error: "missing range", files: [] };
    },
    {
      GITHUB_EVENT_NAME: "push",
      KEIKO_I18N_GUARD_BASE_SHA: "abc1234",
    },
  );

  expect(files).toEqual([UI_FILE, EN_CATALOG, DE_CATALOG]);
  expect(calls[0]).toBe("abc1234..HEAD");
});

test("falls back to the dev diff when the push event before SHA is unreachable", () => {
  const calls = [];

  const files = changedFilesFromGit(
    "repo",
    (_repoRoot, range) => {
      calls.push(range);
      return range === "origin/dev...HEAD"
        ? { ok: true, error: "", files: [UI_FILE] }
        : { ok: false, error: "missing range", files: [] };
    },
    {
      GITHUB_EVENT_NAME: "push",
      KEIKO_I18N_GUARD_BASE_SHA: "deadbee",
    },
  );

  expect(files).toEqual([UI_FILE]);
  expect(calls).toEqual(["deadbee..HEAD", "deadbee...HEAD", "origin/dev...HEAD"]);
});

test("detects changed files from workflow_dispatch base ref safely", () => {
  const calls = [];
  const files = changedFilesFromGit(
    "repo",
    (_repoRoot, range) => {
      calls.push(range);
      return range === "origin/release-1209...HEAD"
        ? { ok: true, error: "", files: [UI_FILE] }
        : { ok: false, error: "missing range", files: [] };
    },
    {
      GITHUB_EVENT_NAME: "workflow_dispatch",
      KEIKO_I18N_GUARD_BASE_REF: "release-1209",
    },
  );

  expect(files).toEqual([UI_FILE]);
  expect(calls[0]).toBe("origin/release-1209...HEAD");
});

test("uses only the parent commit fallback for event runs without a base", () => {
  const calls = [];
  const files = changedFilesFromGit(
    "repo",
    (_repoRoot, range) => {
      calls.push(range);
      return range === "HEAD^1..HEAD"
        ? { ok: true, error: "", files: [UI_FILE] }
        : { ok: false, error: "missing range", files: [] };
    },
    {
      GITHUB_EVENT_NAME: "workflow_dispatch",
    },
  );

  expect(files).toEqual([UI_FILE]);
  expect(calls).toEqual(["HEAD^1..HEAD"]);
});

test("prefers pull request base ref over synchronize before SHA", () => {
  const calls = [];
  const files = changedFilesFromGit(
    "repo",
    (_repoRoot, range) => {
      calls.push(range);
      return range === "origin/dev...HEAD"
        ? { ok: true, error: "", files: [EN_CATALOG, DE_CATALOG] }
        : { ok: false, error: "missing range", files: [] };
    },
    {
      GITHUB_EVENT_NAME: "pull_request",
      KEIKO_I18N_GUARD_BASE_REF: "dev",
      KEIKO_I18N_GUARD_BASE_SHA: "abc1234",
    },
  );

  expect(files).toEqual([EN_CATALOG, DE_CATALOG]);
  expect(calls[0]).toBe("origin/dev...HEAD");
});

test("rejects unsafe git env values before spawning git", () => {
  expect(() =>
    changedFilesFromGit("repo", () => ({ ok: true, error: "", files: [] }), {
      KEIKO_I18N_GUARD_BASE_REF: "--help",
    }),
  ).toThrow(/unsafe base ref/);
});

test("fails closed when changed files cannot be determined from git", () => {
  expect(() =>
    changedFilesFromGit("repo", () => ({ ok: false, error: "missing range", files: [] }), {
      GITHUB_EVENT_NAME: "push",
    }),
  ).toThrow(/could not determine changed files/);
});

test("reads explicit changed files from argv", () => {
  const files = changedFilesFromInput("repo", ["node", "script.mjs", "--files", UI_FILE], {});

  expect(files).toEqual([UI_FILE]);
});

test("reads explicit changed files from env", () => {
  const files = changedFilesFromInput("repo", ["node", "script.mjs"], {
    KEIKO_I18N_GUARD_CHANGED_FILES: `${UI_FILE}\ndocs/architecture.md`,
  });

  expect(files).toEqual([UI_FILE, "docs/architecture.md"]);
});

test("fails UI source changes that do not update both catalogs", async () => {
  await withFixture(
    {
      ...matchingCatalogs,
      [UI_FILE]:
        'import { useTranslate } from "@/lib/i18n";\nexport function NewFeature() { const t = useTranslate(); return <p>{t("feature.title")}</p>; }\n',
    },
    (repoRoot) => {
      const result = checkUiI18nGuard({
        repoRoot,
        changedFiles: [UI_FILE],
      });

      expect(result.ok).toBe(false);
      expect(result.problems.join("\n")).toMatch(/i18n-messages\.en\.ts/);
      expect(result.problems.join("\n")).toMatch(/i18n-messages\.de\.ts/);
    },
  );
});

// The split-file `*-i18n.en.ts` / `*-i18n.de.ts` convention has one instance in this package; the
// dominant one is a single `*-i18n.ts` holding both language maps, which the guard used to miss —
// it told such a feature to update shared catalogs its component never reads. These pin that the
// single-file form satisfies the requirement WITHOUT weakening the English-and-German guarantee.
const SINGLE_FILE_CATALOG = "packages/keiko-ui/src/app/feature/feature-i18n.ts";
const SINGLE_FILE_UI = "packages/keiko-ui/src/app/feature/Feature.tsx";
const SINGLE_FILE_SOURCE =
  'import { useTranslate } from "@/lib/i18n";\n' +
  'export function Feature() { const t = useTranslate(); return <p>{t("feature.title")}</p>; }\n';

function singleFileCatalog(englishKeys, germanKeys) {
  const render = (entries) =>
    Object.entries(entries)
      .map(([key, value]) => `  "${key}": "${value}",`)
      .join("\n");
  return (
    `const FEATURE_EN_MESSAGES = {\n${render(englishKeys)}\n} as const;\n\n` +
    `const FEATURE_DE_MESSAGES = {\n${render(germanKeys)}\n} as const;\n`
  );
}

test("accepts a single-file feature catalog carrying both language maps", async () => {
  await withFixture(
    {
      ...matchingCatalogs,
      [SINGLE_FILE_UI]: SINGLE_FILE_SOURCE,
      [SINGLE_FILE_CATALOG]: singleFileCatalog(
        { "feature.title": "Title" },
        { "feature.title": "Titel" },
      ),
    },
    (repoRoot) => {
      const result = checkUiI18nGuard({
        repoRoot,
        changedFiles: [SINGLE_FILE_UI, SINGLE_FILE_CATALOG],
      });

      expect(result.problems).toEqual([]);
      expect(result.ok).toBe(true);
    },
  );
});

// A keyed lookup declared AFTER the two catalogs — e.g. a closed Record mapping a server reason code
// onto a catalog key — is not catalog content. The parity slice used to run to end of file, so those
// code names read as German-only entries and broke parity in a file whose catalogs are identical.
const TRAILING_LOOKUP =
  "\nconst GUIDANCE_KEYS: Readonly<Record<string, string>> = {\n" +
  '  "pdf-needs-ocr": "feature.title",\n' +
  '  "unsupported-format": "feature.title",\n' +
  "};\n";

test("ignores a non-catalog keyed lookup declared after the two language maps", async () => {
  await withFixture(
    {
      ...matchingCatalogs,
      [SINGLE_FILE_UI]: SINGLE_FILE_SOURCE,
      [SINGLE_FILE_CATALOG]:
        singleFileCatalog({ "feature.title": "Title" }, { "feature.title": "Titel" }) +
        TRAILING_LOOKUP,
    },
    (repoRoot) => {
      const result = checkUiI18nGuard({
        repoRoot,
        changedFiles: [SINGLE_FILE_UI, SINGLE_FILE_CATALOG],
      });

      expect(result.problems).toEqual([]);
      expect(result.ok).toBe(true);
    },
  );
});

// The counterpart: bounding the slice must not stop the guard from seeing a REAL parity break in the
// same file shape. A German half missing a key still fails even with a trailing lookup present.
test("still fails a real parity break when a non-catalog lookup follows the maps", async () => {
  await withFixture(
    {
      ...matchingCatalogs,
      [SINGLE_FILE_UI]: SINGLE_FILE_SOURCE,
      [SINGLE_FILE_CATALOG]:
        singleFileCatalog(
          { "feature.title": "Title", "feature.subtitle": "Subtitle" },
          { "feature.title": "Titel" },
        ) + TRAILING_LOOKUP,
    },
    (repoRoot) => {
      const result = checkUiI18nGuard({
        repoRoot,
        changedFiles: [SINGLE_FILE_UI, SINGLE_FILE_CATALOG],
      });

      expect(result.ok).toBe(false);
      expect(result.problems.join("\n")).toMatch(/feature\.subtitle/);
    },
  );
});

test("fails a single-file feature catalog whose German half is missing a key", async () => {
  await withFixture(
    {
      ...matchingCatalogs,
      [SINGLE_FILE_UI]: SINGLE_FILE_SOURCE,
      [SINGLE_FILE_CATALOG]: singleFileCatalog(
        { "feature.title": "Title", "feature.subtitle": "Subtitle" },
        { "feature.title": "Titel" },
      ),
    },
    (repoRoot) => {
      const result = checkUiI18nGuard({
        repoRoot,
        changedFiles: [SINGLE_FILE_UI, SINGLE_FILE_CATALOG],
      });

      expect(result.ok).toBe(false);
      expect(result.problems.join("\n")).toMatch(/feature\.subtitle/);
    },
  );
});

test("fails a single-file feature catalog that declares only one language map", async () => {
  await withFixture(
    {
      ...matchingCatalogs,
      [SINGLE_FILE_UI]: SINGLE_FILE_SOURCE,
      [SINGLE_FILE_CATALOG]:
        'const FEATURE_EN_MESSAGES = {\n  "feature.title": "Title",\n} as const;\n',
    },
    (repoRoot) => {
      const result = checkUiI18nGuard({
        repoRoot,
        changedFiles: [SINGLE_FILE_UI, SINGLE_FILE_CATALOG],
      });

      expect(result.ok).toBe(false);
      expect(result.problems.join("\n")).toMatch(/both an English and a German message map/);
    },
  );
});

// A `-i18n.ts` file can also be a key-mapping HELPER routing through the shared catalogs
// (`managed-language-i18n.ts`, `problems-i18n.ts`, …): no local language map, values typed against
// the shared catalog's MessageKey. These pin that the guard classifies such a file by content —
// exempt from the local-map requirement, while NOT letting it satisfy the catalog-update
// requirement in place of the shared catalogs its keys actually live in.
const KEY_HELPER_FILE = "packages/keiko-ui/src/app/feature/feature-keys-i18n.ts";
const KEY_HELPER_SOURCE =
  'import type { I18nTranslate } from "@/lib/i18n";\n' +
  'import type { MessageKey } from "@/lib/i18n-messages.en";\n\n' +
  'const FEATURE_KEYS = {\n  title: "feature.title",\n} as const satisfies Readonly<Record<string, MessageKey>>;\n\n' +
  "export function featureTranslate(t: I18nTranslate) {\n" +
  "  return (key: keyof typeof FEATURE_KEYS) => t(FEATURE_KEYS[key]);\n" +
  "}\n";

test("accepts a shared-catalog key helper with the -i18n.ts suffix and no local maps", async () => {
  await withFixture(
    {
      ...matchingCatalogs,
      [SINGLE_FILE_UI]: SINGLE_FILE_SOURCE,
      [KEY_HELPER_FILE]: KEY_HELPER_SOURCE,
    },
    (repoRoot) => {
      const result = checkUiI18nGuard({
        repoRoot,
        changedFiles: [SINGLE_FILE_UI, KEY_HELPER_FILE, EN_CATALOG, DE_CATALOG],
      });

      expect(result.problems).toEqual([]);
      expect(result.ok).toBe(true);
    },
  );
});

// A feature-scoped catalog has the same two seams as the shared one: a hook for components, and the
// translate TYPE as a parameter for the non-component modules that cannot call a hook. The guard
// listed `useCodingWorkbenchTranslate` but not `CodingWorkbenchTranslate`, so a label module that
// routes every string through `t(...)` was still reported as "does not use the i18n API".
const SCOPED_SEAM_FILE = "packages/keiko-ui/src/app/feature/feature-labels.ts";
const SCOPED_SEAM_SOURCE =
  'import type { CodingWorkbenchTranslate } from "./coding-workbench-i18n";\n\n' +
  "export function stateLabel(t: CodingWorkbenchTranslate): string {\n" +
  '  return t("codingWorkbench.state.idle");\n' +
  "}\n";

test("accepts a non-component module that takes a feature-scoped translate function", async () => {
  await withFixture(
    {
      ...matchingCatalogs,
      [SINGLE_FILE_UI]: SINGLE_FILE_SOURCE,
      [SCOPED_SEAM_FILE]: SCOPED_SEAM_SOURCE,
    },
    (repoRoot) => {
      const result = checkUiI18nGuard({
        repoRoot,
        changedFiles: [SINGLE_FILE_UI, SCOPED_SEAM_FILE, EN_CATALOG, DE_CATALOG],
      });

      expect(result.problems).toEqual([]);
      expect(result.ok).toBe(true);
    },
  );
});

// The counterpart: recognising the scoped seam must not become a way to opt out of i18n. Naming the
// type buys a file nothing on the per-literal ledger, which is the rule that actually protects the
// rendered positions — here a registry `label` field.
test("still rejects a hardcoded registry label in a module that names the scoped translate type", async () => {
  await withFixture(
    {
      ...matchingCatalogs,
      [SINGLE_FILE_UI]: SINGLE_FILE_SOURCE,
      [SCOPED_SEAM_FILE]:
        'import type { CodingWorkbenchTranslate } from "./coding-workbench-i18n";\n\n' +
        'export const ROWS = [{ id: "idle", label: "Run is idle" }];\n',
    },
    (repoRoot) => {
      const result = checkUiI18nGuard({
        repoRoot,
        changedFiles: [SINGLE_FILE_UI, SCOPED_SEAM_FILE, EN_CATALOG, DE_CATALOG],
      });

      expect(result.ok).toBe(false);
      expect(result.problems.join("\n")).toMatch(/untranslated user-facing literal/);
    },
  );
});

// Whole-gate regression pin for the shellShortcutState.ts refusal diagnostic (0.3.0 audit, #2802):
// a module whose ONLY "user-facing-shaped" line is a marked, redacted, console-only operator
// diagnostic must not be forced to adopt the i18n API — the string is never rendered.
const DIAGNOSTIC_ONLY_FILE = "packages/keiko-ui/src/app/feature/feature-diagnostic.ts";
const DIAGNOSTIC_ONLY_SOURCE =
  "export function featureRefusalDiagnostic(id) {\n" +
  "  // i18n-exempt: console-only operator diagnostic, never rendered to the end user\n" +
  "  return `feature: refused override (${id})`;\n" +
  "}\n\n" +
  "export function surfaceFeatureRefusal(id) {\n" +
  "  const message = featureRefusalDiagnostic(id);\n" +
  '  if (typeof console !== "undefined") console.warn(message);\n' +
  "}\n";

test("does not require the i18n API for a module whose only literal is a marked operator diagnostic", async () => {
  await withFixture(
    {
      ...matchingCatalogs,
      [SINGLE_FILE_UI]: SINGLE_FILE_SOURCE,
      [DIAGNOSTIC_ONLY_FILE]: DIAGNOSTIC_ONLY_SOURCE,
    },
    (repoRoot) => {
      const result = checkUiI18nGuard({
        repoRoot,
        changedFiles: [SINGLE_FILE_UI, DIAGNOSTIC_ONLY_FILE, EN_CATALOG, DE_CATALOG],
      });

      expect(result.i18nRelevantFiles).not.toContain(DIAGNOSTIC_ONLY_FILE);
      expect(result.problems).toEqual([]);
      expect(result.ok).toBe(true);
    },
  );
});

// The counterpart at whole-gate level: the same shape with NO marker still fails, so the exemption
// cannot be read as "diagnostic strings are exempt from i18n by convention".
test("still requires the i18n API for the same diagnostic shape with no i18n-exempt marker", async () => {
  await withFixture(
    {
      ...matchingCatalogs,
      [SINGLE_FILE_UI]: SINGLE_FILE_SOURCE,
      [DIAGNOSTIC_ONLY_FILE]: DIAGNOSTIC_ONLY_SOURCE.replace(
        "  // i18n-exempt: console-only operator diagnostic, never rendered to the end user\n",
        "",
      ),
    },
    (repoRoot) => {
      const result = checkUiI18nGuard({
        repoRoot,
        changedFiles: [SINGLE_FILE_UI, DIAGNOSTIC_ONLY_FILE, EN_CATALOG, DE_CATALOG],
      });

      expect(result.i18nRelevantFiles).toContain(DIAGNOSTIC_ONLY_FILE);
      expect(result.ok).toBe(false);
      expect(result.problems.join("\n")).toMatch(/do not use the i18n API/);
    },
  );
});

// And a wordless marker on that same file must not succeed either — the escape hatch cannot be used
// wordlessly at this position any more than at a JSX/attribute/label position.
test("still requires the i18n API when the marker's reason is too short", async () => {
  await withFixture(
    {
      ...matchingCatalogs,
      [SINGLE_FILE_UI]: SINGLE_FILE_SOURCE,
      [DIAGNOSTIC_ONLY_FILE]: DIAGNOSTIC_ONLY_SOURCE.replace(
        "console-only operator diagnostic, never rendered to the end user",
        "x",
      ),
    },
    (repoRoot) => {
      const result = checkUiI18nGuard({
        repoRoot,
        changedFiles: [SINGLE_FILE_UI, DIAGNOSTIC_ONLY_FILE, EN_CATALOG, DE_CATALOG],
      });

      expect(result.ok).toBe(false);
      expect(result.problems.join("\n")).toMatch(/do not use the i18n API/);
    },
  );
});

test("a key helper does not satisfy the catalog-update requirement by itself", async () => {
  await withFixture(
    {
      ...matchingCatalogs,
      [SINGLE_FILE_UI]: SINGLE_FILE_SOURCE,
      [KEY_HELPER_FILE]: KEY_HELPER_SOURCE,
    },
    (repoRoot) => {
      const result = checkUiI18nGuard({
        repoRoot,
        changedFiles: [SINGLE_FILE_UI, KEY_HELPER_FILE],
      });

      expect(result.ok).toBe(false);
      expect(result.problems.join("\n")).toMatch(/was not updated/);
    },
  );
});

// The invariant this pins is "a UI file that touches the i18n module and STILL hardcodes text must
// fail". It is unchanged; the reason reported for it is now stronger. `I18nTranslate` is a real i18n
// seam (a non-component module receives the translate function as a parameter — how the window-type
// registry localizes), so the file-level "does not use the i18n API" heuristic no longer fires on it.
// The per-literal rule catches the same file and names the exact untranslated string instead, which is
// the failure the author can act on. The file-level heuristic keeps its own coverage below, in the
// case where the file has no i18n seam at all.
test("fails UI source changes that only import the i18n module", async () => {
  await withFixture(
    {
      ...matchingCatalogs,
      [UI_FILE]:
        'import type { I18nTranslate } from "@/lib/i18n";\nexport function NewFeature() { return <p>Hard-coded text</p>; }\n',
    },
    (repoRoot) => {
      const result = checkUiI18nGuard({
        repoRoot,
        changedFiles: [UI_FILE, EN_CATALOG, DE_CATALOG],
      });

      expect(result.ok).toBe(false);
      expect(result.problems.join("\n")).toMatch(/untranslated user-facing literal/);
      expect(result.problems.join("\n")).toMatch(/"Hard-coded text"/);
    },
  );
});

test("fails mixed UI diffs when one file hard-codes text", async () => {
  await withFixture(
    {
      ...matchingCatalogs,
      [UI_FILE]:
        'import { useTranslate } from "@/lib/i18n";\nexport function NewFeature() { const t = useTranslate(); return <p>{t("feature.title")}</p>; }\n',
      "packages/keiko-ui/src/app/components/AnotherFeature.tsx":
        "export function AnotherFeature() { return <p>Hard-coded text</p>; }\n",
    },
    (repoRoot) => {
      const result = checkUiI18nGuard({
        repoRoot,
        changedFiles: [
          UI_FILE,
          "packages/keiko-ui/src/app/components/AnotherFeature.tsx",
          EN_CATALOG,
          DE_CATALOG,
        ],
      });

      expect(result.ok).toBe(false);
      expect(result.problems.join("\n")).toMatch(/AnotherFeature\.tsx/);
    },
  );
});

test("fails UI source changes that only contain raw translate syntax", async () => {
  await withFixture(
    {
      ...matchingCatalogs,
      [UI_FILE]:
        'export function NewFeature() {\n  return <svg><g transform="translate(10 10)"><text>Label</text></g></svg>;\n}\n',
    },
    (repoRoot) => {
      const result = checkUiI18nGuard({
        repoRoot,
        changedFiles: [UI_FILE, EN_CATALOG, DE_CATALOG],
      });

      expect(result.ok).toBe(false);
      expect(result.problems.join("\n")).toMatch(/do not use the i18n API/);
    },
  );
});

test("passes UI source changes with i18n usage and both catalogs", async () => {
  await withFixture(
    {
      ...matchingCatalogs,
      [UI_FILE]:
        'import { useTranslate } from "@/lib/i18n";\nexport function NewFeature() { const t = useTranslate(); return <p>{t("feature.title")}</p>; }\n',
    },
    (repoRoot) => {
      const result = checkUiI18nGuard({
        repoRoot,
        changedFiles: [UI_FILE, EN_CATALOG, DE_CATALOG],
      });

      expect(result.ok).toBe(true);
      expect(result.problems).toEqual([]);
    },
  );
});

test("fails when English and German catalog keys drift", async () => {
  await withFixture(
    {
      [EN_CATALOG]:
        'export const EN_MESSAGES = {\n  "feature.title": "Title",\n  "feature.subtitle": "Subtitle",\n} as const;\n',
      [DE_CATALOG]:
        'import type { MessageCatalog } from "./i18n-messages.en";\n\nexport const DE_MESSAGES = {\n  "feature.title": "Titel",\n} satisfies MessageCatalog;\n',
      [UI_FILE]:
        'import { useTranslate } from "@/lib/i18n";\nexport function NewFeature() { const t = useTranslate(); return <p>{t("feature.title")}</p>; }\n',
    },
    (repoRoot) => {
      const result = checkUiI18nGuard({
        repoRoot,
        changedFiles: [UI_FILE, EN_CATALOG, DE_CATALOG],
      });

      expect(result.ok).toBe(false);
      expect(result.problems.join("\n")).toMatch(/feature\.subtitle/);
    },
  );
});

async function withGitFixture(callback) {
  const repoRoot = await mkdtemp(join(tmpdir(), "keiko-i18n-guard-git-"));
  const savedBaseSha = process.env.KEIKO_I18N_GUARD_BASE_SHA;
  const run = (args) => spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: "pipe" });

  try {
    run(["init", "-q"]);
    run(["config", "user.email", "test@example.com"]);
    run(["config", "user.name", "Test"]);
    for (const [file, contents] of Object.entries({
      [LITERAL_BASELINE]: '{ "files": {} }\n',
      ...matchingCatalogs,
    })) {
      await writeRepoFile(repoRoot, file, contents);
    }
    await writeRepoFile(
      repoRoot,
      UI_FILE,
      'import { useTranslate } from "@/lib/i18n";\nexport function NewFeature() {\n  const t = useTranslate();\n  return (\n    <p>\n      {t("feature.title")}\n    </p>\n  );\n}\n',
    );
    run(["add", "-A"]);
    run(["commit", "-q", "-m", "base"]);
    const baseSha = run(["rev-parse", "HEAD"]).stdout.trim();
    process.env.KEIKO_I18N_GUARD_BASE_SHA = baseSha;

    return await callback(repoRoot, run);
  } finally {
    if (savedBaseSha === undefined) delete process.env.KEIKO_I18N_GUARD_BASE_SHA;
    else process.env.KEIKO_I18N_GUARD_BASE_SHA = savedBaseSha;
    await rm(repoRoot, { recursive: true, force: true });
  }
}

test("passes a pure refactor of an already-translated file with no new user-facing text", async () => {
  const result = await withGitFixture(async (repoRoot, run) => {
    // The unchanged t("feature.title") call stays on its own line, untouched, exactly like a real
    // diff hunk that only edits nearby structural code (e.g. adding a ref/tabIndex to a heading).
    await writeRepoFile(
      repoRoot,
      UI_FILE,
      'import { useRef } from "react";\nimport { useTranslate } from "@/lib/i18n";\nexport function NewFeature() {\n  const t = useTranslate();\n  const ref = useRef(null);\n  return (\n    <p ref={ref}>\n      {t("feature.title")}\n    </p>\n  );\n}\n',
    );

    run(["add", "-A"]);
    run(["commit", "-q", "-m", "refactor"]);

    return checkUiI18nGuard({ repoRoot, changedFiles: [UI_FILE] });
  });

  expect(result.ok).toBe(true);
  expect(result.problems).toEqual([]);
});

test("passes when an existing translation key moves into a different JSX element", async () => {
  const result = await withGitFixture(async (repoRoot, run) => {
    await writeRepoFile(
      repoRoot,
      UI_FILE,
      'import { useTranslate } from "@/lib/i18n";\nexport function NewFeature() {\n  const t = useTranslate();\n  return (\n    <output>\n      {t("feature.title")}\n    </output>\n  );\n}\n',
    );
    run(["add", "-A"]);
    run(["commit", "-q", "-m", "use semantic output"]);

    return checkUiI18nGuard({ repoRoot, changedFiles: [UI_FILE] });
  });

  expect(result.ok).toBe(true);
  expect(result.problems).toEqual([]);
});

test("fails a change that adds a genuinely new translation key without updating catalogs", async () => {
  const result = await withGitFixture(async (repoRoot, run) => {
    await writeRepoFile(
      repoRoot,
      UI_FILE,
      'import { useTranslate } from "@/lib/i18n";\nexport function NewFeature() {\n  const t = useTranslate();\n  return (\n    <>\n      <p>{t("feature.title")}</p>\n      <p>{t("feature.subtitle")}</p>\n    </>\n  );\n}\n',
    );
    run(["add", "-A"]);
    run(["commit", "-q", "-m", "add subtitle"]);

    return checkUiI18nGuard({ repoRoot, changedFiles: [UI_FILE] });
  });

  expect(result.ok).toBe(false);
  expect(result.problems.join("\n")).toMatch(/i18n-messages\.en\.ts/);
});

test("fails a change that adds new hard-coded user-facing text", async () => {
  const result = await withGitFixture(async (repoRoot, run) => {
    await writeRepoFile(
      repoRoot,
      UI_FILE,
      'import { useTranslate } from "@/lib/i18n";\nexport function NewFeature() {\n  const t = useTranslate();\n  return (\n    <>\n      <p>{t("feature.title")}</p>\n      <p>Hard-coded text</p>\n    </>\n  );\n}\n',
    );
    run(["add", "-A"]);
    run(["commit", "-q", "-m", "add hard-coded text"]);

    return checkUiI18nGuard({ repoRoot, changedFiles: [UI_FILE] });
  });

  expect(result.ok).toBe(false);
  expect(result.problems.join("\n")).toMatch(/i18n-messages\.en\.ts/);
});

const FEATURE_EN = "packages/keiko-ui/src/app/components/widgets/example/example-i18n.en.ts";
const FEATURE_DE = "packages/keiko-ui/src/app/components/widgets/example/example-i18n.de.ts";
const FEATURE_UI_FILE = "packages/keiko-ui/src/app/components/widgets/example/ExamplePanel.tsx";
const featureUiSource =
  'const t = useCodingWorkbenchTranslate();\nexport const label = t("example.title");\n';

test("accepts a changed feature catalog pair in place of the shared catalogs", async () => {
  await withFixture(
    {
      ...matchingCatalogs,
      [FEATURE_UI_FILE]: featureUiSource,
      [FEATURE_EN]: 'export const EN = {\n  "example.title": "Example",\n} as const;\n',
      [FEATURE_DE]: 'export const DE = {\n  "example.title": "Beispiel",\n} as const;\n',
    },
    (repoRoot) => {
      const result = checkUiI18nGuard({
        repoRoot,
        changedFiles: [FEATURE_UI_FILE, FEATURE_EN, FEATURE_DE],
      });

      expect(result.problems).toEqual([]);
      expect(result.ok).toBe(true);
    },
  );
});

test("flags a feature catalog changed without its language counterpart", async () => {
  await withFixture(
    {
      ...matchingCatalogs,
      [FEATURE_UI_FILE]: featureUiSource,
      [FEATURE_EN]: 'export const EN = {\n  "example.title": "Example",\n} as const;\n',
    },
    (repoRoot) => {
      const result = checkUiI18nGuard({
        repoRoot,
        changedFiles: [FEATURE_UI_FILE, FEATURE_EN],
      });

      expect(result.ok).toBe(false);
      expect(result.problems.join("\n")).toContain("without its language counterpart");
    },
  );
});

test("flags mismatched keys across a changed feature catalog pair", async () => {
  await withFixture(
    {
      ...matchingCatalogs,
      [FEATURE_UI_FILE]: featureUiSource,
      [FEATURE_EN]:
        'export const EN = {\n  "example.title": "Example",\n  "example.extra": "Extra",\n} as const;\n',
      [FEATURE_DE]: 'export const DE = {\n  "example.title": "Beispiel",\n} as const;\n',
    },
    (repoRoot) => {
      const result = checkUiI18nGuard({
        repoRoot,
        changedFiles: [FEATURE_UI_FILE, FEATURE_EN, FEATURE_DE],
      });

      expect(result.ok).toBe(false);
      expect(result.problems.join("\n")).toContain("must expose the same keys");
    },
  );
});

// The optional-widget catalog pair (`useOptionalWidgetTranslate`) is a real English/German catalog
// that predates the `-i18n.{en,de}.ts` naming, so the guard used to send a component reading it to
// shared catalogs it never touches (#2768). These pin that the pair satisfies the requirement
// WITHOUT weakening the English-and-German guarantee: one half alone still fails.
const OPTIONAL_EN = "packages/keiko-ui/src/lib/i18n-messages.optional.en.ts";
const OPTIONAL_DE = "packages/keiko-ui/src/lib/i18n-messages.optional.de.ts";
const optionalUiSource =
  'const t = useOptionalWidgetTranslate();\nexport const label = t("quickAccess.title");\n';

test("accepts a changed optional-widget catalog pair in place of the shared catalogs", async () => {
  await withFixture(
    {
      ...matchingCatalogs,
      [UI_FILE]: optionalUiSource,
      [OPTIONAL_EN]:
        'export const OPTIONAL_WIDGET_EN_MESSAGES = {\n  "quickAccess.title": "Quick access",\n} as const;\n',
      [OPTIONAL_DE]:
        'export const OPTIONAL_WIDGET_DE_MESSAGES = {\n  "quickAccess.title": "Schnellzugriff",\n} satisfies OptionalWidgetMessageCatalog;\n',
    },
    (repoRoot) => {
      const result = checkUiI18nGuard({
        repoRoot,
        changedFiles: [UI_FILE, OPTIONAL_EN, OPTIONAL_DE],
      });

      expect(result.problems.join("\n")).toBe("");
      expect(result.ok).toBe(true);
    },
  );
});

test("rejects a one-sided optional-widget catalog change and names the missing half", async () => {
  await withFixture(
    {
      ...matchingCatalogs,
      [UI_FILE]: optionalUiSource,
      [OPTIONAL_EN]:
        'export const OPTIONAL_WIDGET_EN_MESSAGES = {\n  "quickAccess.title": "Quick access",\n} as const;\n',
    },
    (repoRoot) => {
      const result = checkUiI18nGuard({
        repoRoot,
        changedFiles: [UI_FILE, OPTIONAL_EN],
      });

      expect(result.ok).toBe(false);
      expect(result.problems.join("\n")).toContain("without its counterpart");
      expect(result.problems.join("\n")).toContain("i18n-messages.optional.de.ts");
    },
  );
});

// ---------------------------------------------------------------------------
// Untranslated user-facing literal detection.
//
// The guard's original question — "does this changed .tsx mention an i18n API anywhere in the file?" —
// cannot fail on the case it exists to prevent. These tests pin the per-literal rule that can.

const REGISTRY_FILE = "packages/keiko-ui/src/app/components/desktop/windows/Registry.ts";
const REGISTRY_SOURCE =
  'export const WINDOWS = [\n  { id: "files", label: "Files", desc: "Browse a folder" },\n];\n';

test("flags a user-facing literal in each of the three positions a user reads it", () => {
  expect(untranslatedLiteralsInLine('      <span className="pal-name">New window</span>')).toEqual([
    "New window",
  ]);
  expect(untranslatedLiteralsInLine('        aria-label="Browse source file"')).toEqual([
    "Browse source file",
  ]);
  expect(untranslatedLiteralsInLine('  { id: "unit", label: "Unit Test Agent" },')).toEqual([
    "Unit Test Agent",
  ]);
  expect(untranslatedLiteralsInLine('  descKey: "window.type.files.desc",')).toEqual([]);
  expect(untranslatedLiteralsInLine('      <span>{t("workspace.newWindow")}</span>')).toEqual([]);
  expect(untranslatedLiteralsInLine('  // label: "Commented out copy"')).toEqual([]);
});

// KEIKO-0299: the line-scoped scanner was blind to two real positions. The AST rewrite catches
// both, and these are the reproductions the finding requires.
test("catches JSX text whose opening and closing tags are on different lines", () => {
  const findings = untranslatedLiteralsInSource(`<div>\n  Hello there\n</div>`).findings;
  expect(findings.length).toBeGreaterThan(0);
  expect(findings[0].text).toContain("Hello there");
});

test("catches a string-literal JSX expression-container child in both quote styles", () => {
  for (const src of [`<p>{"No chats"}</p>`, `<p>{'No chats'}</p>`]) {
    const findings = untranslatedLiteralsInSource(src).findings;
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].text).toContain("No chats");
  }
});

test("still ignores dynamic JSX expressions and machine tokens", () => {
  expect(untranslatedLiteralsInSource(`<span>{ready}</span>`).findings).toEqual([]);
  expect(untranslatedLiteralsInSource(`<span>{"open-directory"}</span>`).findings).toEqual([]);
});

// KEIKO-0299 (review-follow-up): the AST scanner used to collect ANY string-literal expression
// container, including those inside JsxAttribute values. `className={"Internal label"}` is code,
// not user-visible text, and the per-line attribute pass already inspects which attribute names
// are user-facing — double-counting under different rules would generate false ledger entries.
test("does not scan string literals inside JSX attribute expression containers", () => {
  expect(
    untranslatedLiteralsInSource(
      `<Widget className={"Internal label"} data-test-id={'internal token'} />`,
    ).findings,
  ).toEqual([]);
});

// KEIKO-0299 (review-follow-up): the initial ship of the AST scanner parsed EVERY UI source as
// TSX. That made TypeScript-generic syntax in ordinary `.ts` files (`<T>`, `ReadonlySet<...>`)
// look like JSX opening tags — the parser then emitted their surrounding source as a stream of
// JsxText nodes, generating dozens of false untranslated-copy entries for pure-code files. The
// fix picks ScriptKind by extension; these two cases pin that choice: identical source, parsed
// as TS, produces zero findings; parsed as TSX (via a `.tsx` filename), produces the JsxText
// interpretation.
test("parses .ts sources with the TypeScript grammar (no JSX interpretation)", () => {
  const generic = `const asType = <T,>(value: T): T => value;\nconst set: ReadonlySet<string> = new Set();\n`;
  expect(untranslatedLiteralsInSource(generic, "packages/x/y.ts").findings).toEqual([]);
});

test("still parses .tsx sources as TSX", () => {
  const jsx = `<p>\n  Hello there\n</p>`;
  const findings = untranslatedLiteralsInSource(jsx, "packages/x/y.tsx").findings;
  expect(findings.length).toBeGreaterThan(0);
});

// KEIKO-0299 (review-follow-up): boundary inputs the scanner must not throw on. Empty source,
// whitespace-only source, and a source with an unterminated JSX element (mid-edit state) all
// need to produce a valid `{findings, weakExemptions}` shape instead of a parser exception.
test("returns an empty result for empty and whitespace-only sources", () => {
  expect(untranslatedLiteralsInSource("").findings).toEqual([]);
  expect(untranslatedLiteralsInSource("").weakExemptions).toEqual([]);
  expect(untranslatedLiteralsInSource("   \n\n  \n").findings).toEqual([]);
});

test("does not throw on malformed TSX and returns a valid shape", () => {
  const malformed = `<div>{"Hello"`;
  const result = untranslatedLiteralsInSource(malformed, "packages/x/y.tsx");
  expect(result).toHaveProperty("findings");
  expect(result).toHaveProperty("weakExemptions");
  expect(Array.isArray(result.findings)).toBe(true);
});

// KEIKO-0299 (review-follow-up): the initial ship reclassified parsed JSX text via
// `isCommentLine(lines[line - 1])`, which discarded legitimate user copy whose source line
// happened to start with `*`, `//`, or `/*` (an indented `* Required fields` inside a multi-line
// paragraph is the canonical example). The parser already strips C-style comments from JsxText
// nodes, so no line-level reclassification is correct here.
test("does not discard parsed JSX text whose source line looks like a comment", () => {
  const src = `<p>\n  * Required fields\n</p>`;
  const findings = untranslatedLiteralsInSource(src, "packages/x/y.tsx").findings;
  expect(findings.length).toBeGreaterThan(0);
  expect(findings[0].text).toContain("Required fields");
});

// KEIKO-0299 (review-follow-up): a JSX child template expression (`` `Hello ${name}` ``) is
// neither a StringLiteral nor a NoSubstitutionTemplateLiteral, so the initial ship silently
// ignored the literal spans it carries. Extract them (head + each templateSpan.literal) so newly
// added user copy in that shape lands in the ledger; templates that contain only interpolations
// stay ignored because their combined literal text is empty.
test("collects literal spans from JSX child template expressions", () => {
  const src = "<p>{`Hello ${name}, welcome`}</p>";
  const findings = untranslatedLiteralsInSource(src, "packages/x/y.tsx").findings;
  expect(findings.length).toBeGreaterThan(0);
  expect(findings[0].text).toContain("Hello");
  expect(findings[0].text).toContain("welcome");
});

test("still ignores JSX child template expressions that contain only interpolations", () => {
  expect(
    untranslatedLiteralsInSource("<p>{`${prefix}${value}`}</p>", "packages/x/y.tsx").findings,
  ).toEqual([]);
});

// KEIKO-0299 (review-follow-up on 4b557d96): a template expression whose SUBSTITUTIONS contain
// literals (`` `${expanded ? "Collapse" : "Expand"} ${project.name}` ``) had its branch strings
// invisible to the ledger — the template-part scan sees only whitespace between the spans. Codex
// 3792964062. Recurse into each `span.expression` using the same helper so conditionals,
// templates, and logical fallbacks inside substitutions all surface.
test("collects literals inside template substitutions", () => {
  const src = '<span>{`${expanded ? "Collapse" : "Expand"} ${project.name}`}</span>';
  const texts = untranslatedLiteralsInSource(src, "packages/x/y.tsx")
    .findings.map((f) => f.text)
    .sort();
  expect(texts).toContain("Collapse");
  expect(texts).toContain("Expand");
});

test("collects a `??` fallback inside a template substitution", () => {
  const texts = untranslatedLiteralsInSource(
    '<p>{`Prefix ${label ?? "Fallback label"} suffix`}</p>',
    "packages/x/y.tsx",
  ).findings.map((f) => f.text);
  expect(texts).toContain("Fallback label");
});

// KEIKO-0299 (review-follow-up on 4d7d131a): a call expression like `definedOr(x, "this file")`
// returns its second argument verbatim when the first is undefined — the string IS user-visible
// copy. Codex 3792986615. Traverse call arguments too. Non-literal args produce empty results;
// obvious non-copy strings are filtered by `isTranslatableCopy` downstream.
test("collects literal arguments passed to a rendered call expression", () => {
  const src = '<p>{`Agent patch review for ${definedOr(name, "this file")}`}</p>';
  const texts = untranslatedLiteralsInSource(src, "packages/x/y.tsx").findings.map((f) => f.text);
  expect(texts).toContain("this file");
});

test("still ignores calls whose only literal arguments are machine tokens", () => {
  expect(
    untranslatedLiteralsInSource('<p>{translate("feature.title")}</p>', "packages/x/y.tsx")
      .findings,
  ).toEqual([]);
});

// KEIKO-0299 (review-follow-up on 7c976f77): a ConditionalExpression like
// `{busyKind === "index" ? "Indexing…" : "Index"}` is the other common JSX-child shape and
// used to be invisible to both the AST helper (it is neither StringLiteral nor
// NoSubstitutionTemplateLiteral nor TemplateExpression) and the per-line fallback (the braces
// reject the expression). Emit each branch as its own ledger entry so an added untranslated
// string in either branch fails the gate. Nested conditionals recurse.
test("collects each literal branch of a JSX child conditional expression", () => {
  const src = `<span>{cond ? "Indexing" : "Index"}</span>`;
  const findings = untranslatedLiteralsInSource(src, "packages/x/y.tsx").findings;
  const texts = findings.map((f) => f.text).sort();
  expect(texts).toContain("Indexing");
  expect(texts).toContain("Index");
});

test("recurses into nested conditionals and template branches", () => {
  const src = '<span>{a ? (b ? "First one" : "Second one") : `Third ${x} one`}</span>';
  const texts = untranslatedLiteralsInSource(src, "packages/x/y.tsx")
    .findings.map((f) => f.text)
    .sort();
  expect(texts).toContain("First one");
  expect(texts).toContain("Second one");
  expect(texts.some((t) => t.includes("Third") && t.includes("one"))).toBe(true);
});

test("still ignores JSX child conditionals whose branches are only expressions", () => {
  expect(
    untranslatedLiteralsInSource("<span>{cond ? a : b}</span>", "packages/x/y.tsx").findings,
  ).toEqual([]);
});

// KEIKO-0299 (review-follow-up on 44b9ef9b): `{label ?? "Default"}`, `{a || "Fallback"}`,
// `{ready && "Ready now"}` — the logical-fallback shapes that used to be invisible to both
// the AST scanner and the per-line fallback.
test("collects literal operands of `??`, `||`, and `&&` in JSX children", () => {
  for (const src of [
    '<span>{label ?? "Default label"}</span>',
    '<span>{label || "Fallback label"}</span>',
    '<span>{ready && "Ready now"}</span>',
  ]) {
    const texts = untranslatedLiteralsInSource(src, "packages/x/y.tsx")
      .findings.map((f) => f.text)
      .join(" | ");
    expect(texts.length).toBeGreaterThan(0);
  }
});

// KEIKO-0299 (review-follow-up on 44b9ef9b): user-facing attribute EXPRESSIONS. The per-line
// pass only sees `aria-label="Copy"`; an `aria-label={cond ? "Copied" : "Copy code block"}` or
// `title={hasSources ? undefined : "Attach a source…"}` used to be invisible. The AST pass now
// restricts to the same attribute-name set the per-line policy targets.
test("collects literals from user-facing attribute value expressions", () => {
  const texts = untranslatedLiteralsInSource(
    '<button aria-label={copied ? "Copied" : "Copy code block"}>x</button>',
    "packages/x/y.tsx",
  )
    .findings.map((f) => f.text)
    .sort();
  expect(texts).toContain("Copied");
  expect(texts).toContain("Copy code block");
});

test("collects a `??` fallback in a user-facing attribute expression", () => {
  const texts = untranslatedLiteralsInSource(
    '<div title={label ?? "Attach a source"} />',
    "packages/x/y.tsx",
  ).findings.map((f) => f.text);
  expect(texts).toContain("Attach a source");
});

test("still ignores expression values on non-user-facing attributes", () => {
  expect(
    untranslatedLiteralsInSource(
      '<div className={cond ? "primary" : "secondary"} />',
      "packages/x/y.tsx",
    ).findings,
  ).toEqual([]);
});

// KEIKO-0299 (review-follow-up on a0ee79ae): `&&` short-circuits. The LEFT operand only
// controls evaluation and is NEVER rendered as user copy; only the right operand is. A
// literal on the left (`{"Feature enabled" && value}`) is code, not rendered text, and must
// not enter the ledger. Coderabbit 3792888551.
test("does not collect the left operand of `&&` in JSX children", () => {
  expect(
    untranslatedLiteralsInSource('<span>{"Feature enabled" && value}</span>', "packages/x/y.tsx")
      .findings,
  ).toEqual([]);
});

test("still collects the right operand of `&&` in JSX children", () => {
  const findings = untranslatedLiteralsInSource(
    '<span>{ready && "Ready now"}</span>',
    "packages/x/y.tsx",
  ).findings;
  expect(findings.map((f) => f.text)).toContain("Ready now");
});

// KEIKO-0299 (review-follow-up on a0ee79ae): each recursively-extracted literal must carry its
// own source position, not the outer expression's start line. A multi-line conditional whose
// branches sit on different lines has to report those lines exactly so an exemption on one
// branch does not silently cover the other and the ledger diff points reviewers at the right
// spot. Coderabbit 3792888549.
test("assigns each conditional branch its own source line", () => {
  const src = '<span>{\n  cond\n    ? "First branch"\n    : "Second branch"\n}</span>';
  const byText = new Map(
    untranslatedLiteralsInSource(src, "packages/x/y.tsx").findings.map((f) => [f.text, f.line]),
  );
  expect(byText.get("First branch")).toBe(3);
  expect(byText.get("Second branch")).toBe(4);
});

test("assigns each attribute-expression branch its own source line", () => {
  const src = '<button aria-label={\n  cond\n    ? "Copied"\n    : "Copy code block"\n}>x</button>';
  const byText = new Map(
    untranslatedLiteralsInSource(src, "packages/x/y.tsx").findings.map((f) => [f.text, f.line]),
  );
  expect(byText.get("Copied")).toBe(3);
  expect(byText.get("Copy code block")).toBe(4);
});

// KEIKO-0299 (review-follow-up on af74e79b): custom components spell accessible-name props in
// camelCase (`<KeikoSelect ariaLabel="…">`), so the AST attribute pass now recognises both
// kebab-case ARIA names AND their camelCase equivalents plus the label-field set custom
// components use for the same role. Codex 3792890962.
test("collects literals from camelCase user-facing attribute expressions", () => {
  const texts = untranslatedLiteralsInSource(
    '<KeikoSelect ariaLabel={busy ? "Working now" : "Select source"} />',
    "packages/x/y.tsx",
  )
    .findings.map((f) => f.text)
    .sort();
  expect(texts).toContain("Working now");
  expect(texts).toContain("Select source");
});

test("collects literals from `label` and `description` prop expressions on custom components", () => {
  const texts = untranslatedLiteralsInSource(
    '<Item label={cond ? "Enabled" : "Disabled"} description={fallback ?? "Long description"} />',
    "packages/x/y.tsx",
  ).findings.map((f) => f.text);
  expect(texts).toContain("Enabled");
  expect(texts).toContain("Disabled");
  expect(texts).toContain("Long description");
});

// KEIKO-0299 (review-follow-up on 9547abd1): a directly-quoted camelCase prop like
// `<KeikoSelect ariaLabel="Relationship type" />` has a StringLiteral initializer (not a
// JsxExpression), so the AST attribute pass silently dropped it. The per-line fallback only
// recognises kebab-case attribute names before `=`, and LABEL_FIELD_NAME_RE expects `:`, so
// nothing caught it. Codex 3792941801.
test("collects directly quoted camelCase prop literals", () => {
  const texts = untranslatedLiteralsInSource(
    '<KeikoSelect ariaLabel="Relationship type" label="Source" />',
    "packages/x/y.tsx",
  ).findings.map((f) => f.text);
  expect(texts).toContain("Relationship type");
  expect(texts).toContain("Source");
});

// Values here MUST pass `isTranslatableCopy` (multi-word letter phrases) so that if `testId` or
// `className` were mistakenly added to `USER_FACING_ATTRIBUTE_NAMES`, the assertion would fail.
// Single lowercase tokens (`"primary"`, `"relationship-picker"`) are rejected by
// `isTranslatableCopy` regardless of the attribute name, so they can't pin the name gate.
// Coderabbit 3793025303.
test("still ignores directly quoted values on non-user-facing camelCase props", () => {
  expect(
    untranslatedLiteralsInSource(
      '<KeikoSelect testId="Relationship picker" className="Primary button" />',
      "packages/x/y.tsx",
    ).findings,
  ).toEqual([]);
});

// KEIKO-0299 (review-follow-up on 23447289, codex 3793028199): transparent TypeScript
// wrappers (AsExpression, SatisfiesExpression, NonNullExpression) don't change runtime value,
// so a literal wrapped in them still renders as user copy. Recursion must unwrap them.
test("unwraps `as const` / `as string` around a rendered literal", () => {
  const texts = untranslatedLiteralsInSource(
    '<p>{"Delete account" as const}</p>',
    "packages/x/y.tsx",
  ).findings.map((f) => f.text);
  expect(texts).toContain("Delete account");
});

test("unwraps `satisfies` and `!` around a rendered literal", () => {
  for (const src of [
    '<p>{"Delete account" satisfies string}</p>',
    '<p>{("Delete account" as string | undefined)!}</p>',
  ]) {
    const texts = untranslatedLiteralsInSource(src, "packages/x/y.tsx").findings.map((f) => f.text);
    expect(texts).toContain("Delete account");
  }
});

test("unwraps `as` inside a user-facing attribute expression", () => {
  const texts = untranslatedLiteralsInSource(
    '<button aria-label={"Copy code block" as const}>x</button>',
    "packages/x/y.tsx",
  ).findings.map((f) => f.text);
  expect(texts).toContain("Copy code block");
});

// KEIKO-0299 (review-follow-up on 23447289, codex 3793028208): a JSX spread attribute
// `<button {...{ "aria-label": "…" }} />` reaches the element as JsxSpreadAttribute. When the
// spread expression is an inline ObjectLiteral, inspect its properties against the same
// user-facing name set so a spread rendering an accessible label enters the ledger.
test("collects user-facing literals in inline JSX spread attributes", () => {
  const texts = untranslatedLiteralsInSource(
    '<button {...{ "aria-label": "Delete account", label: "Delete" }} />',
    "packages/x/y.tsx",
  )
    .findings.map((f) => f.text)
    .sort();
  expect(texts).toContain("Delete account");
  expect(texts).toContain("Delete");
});

test("still ignores non-user-facing keys in JSX spread attributes", () => {
  expect(
    untranslatedLiteralsInSource(
      '<button {...{ testId: "Test button", className: "Primary large" }} />',
      "packages/x/y.tsx",
    ).findings,
  ).toEqual([]);
});

test("still ignores non-inline JSX spreads (dynamic props object)", () => {
  expect(
    untranslatedLiteralsInSource("<button {...restProps} />", "packages/x/y.tsx").findings,
  ).toEqual([]);
});

// KEIKO-0299 (review-follow-up on b5cb3f6c, codex 3793101250): `{items.map(() => "Delete
// account")}` — the ArrowFunction body IS user-visible copy that gets rendered per item, but
// the previous CallExpression recursion stopped at the function argument and never inspected
// its body. Handle expression-bodied and block-bodied arrows/functions.
test("collects literals from expression-bodied arrow callbacks", () => {
  const src = '<p>{items.map(() => "Delete account")}</p>';
  const texts = untranslatedLiteralsInSource(src, "packages/x/y.tsx").findings.map((f) => f.text);
  expect(texts).toContain("Delete account");
});

test("collects literals from block-bodied arrow callbacks via ReturnStatement", () => {
  const src = '<p>{items.map(() => { return "Return delete"; })}</p>';
  const texts = untranslatedLiteralsInSource(src, "packages/x/y.tsx").findings.map((f) => f.text);
  expect(texts).toContain("Return delete");
});

test("does not recurse into nested function scopes' return statements", () => {
  const src =
    '<p>{items.map(() => { const inner = () => "Inner return"; return "Outer return"; })}</p>';
  const texts = untranslatedLiteralsInSource(src, "packages/x/y.tsx").findings.map((f) => f.text);
  expect(texts).toContain("Outer return");
  expect(texts).not.toContain("Inner return");
});

// KEIKO-0299 (review-follow-up on 889eff53, codex 3793145626): `{["Delete account",
// "Cancel"]}` — React renders each element as user copy but ArrayLiteralExpression was
// invisible to the recursion. Now traverses each element.
test("collects literals from array elements rendered as JSX children", () => {
  const src = '<p>{["Delete account", "Cancel operation"]}</p>';
  const texts = untranslatedLiteralsInSource(src, "packages/x/y.tsx")
    .findings.map((f) => f.text)
    .sort();
  expect(texts).toContain("Delete account");
  expect(texts).toContain("Cancel operation");
});

// KEIKO-0299 (review-follow-up on 889eff53, codex 3793145631): template spans must be joined
// WITHOUT an inserted separator. `` `memoria.settings.mode.${x}Error` `` used to become
// `"memoria.settings.mode. Error"` (injected space made isTranslatableCopy see it as prose);
// now it becomes `"memoria.settings.mode.Error"` — a dotted machine token, correctly rejected.
test("does not flag dotted-key templates with interpolated tail", () => {
  const src = "<p>{t(`memoria.settings.mode.${errorKind}Error`)}</p>";
  const texts = untranslatedLiteralsInSource(src, "packages/x/y.tsx").findings.map((f) => f.text);
  expect(texts).not.toContain("memoria.settings.mode. Error");
  expect(texts).not.toContain("memoria.settings.mode.Error");
});

test("still flags real prose across template spans", () => {
  const src = "<p>{`Hello ${user} World`}</p>";
  const texts = untranslatedLiteralsInSource(src, "packages/x/y.tsx").findings.map((f) => f.text);
  expect(texts).toContain("Hello World");
});

// KEIKO-0299 (review-follow-up on af74e79b): a JSX child like `{"Welcome back, " + name}`
// renders the concatenation as user copy — the literal on either operand IS user-visible and
// must enter the ledger. Codex 3792890969.
test("collects literals from `+` string concatenation in JSX children", () => {
  const texts = untranslatedLiteralsInSource(
    '<p>{"Welcome back, " + name}</p>',
    "packages/x/y.tsx",
  ).findings.map((f) => f.text);
  expect(texts).toContain("Welcome back,");
});

test("collects literals on both sides of a JSX child `+`", () => {
  const texts = untranslatedLiteralsInSource(
    '<p>{"Hello, " + name + " your account"}</p>',
    "packages/x/y.tsx",
  ).findings.map((f) => f.text);
  expect(texts).toContain("Hello,");
  expect(texts).toContain("your account");
});

// KEIKO-0299 (review-follow-up): multi-line JSX text now collapses intra-node whitespace so a
// reformat or indentation change does not churn the ratcheted ledger. Same rendered copy, same
// ledger entry, either shape.
test("normalizes intra-node whitespace in multi-line JSX text", () => {
  const compact = untranslatedLiteralsInSource(
    `<p>Hello there friend</p>`,
    "packages/x/y.tsx",
  ).findings;
  const wrapped = untranslatedLiteralsInSource(
    `<p>\n  Hello\n  there\n  friend\n</p>`,
    "packages/x/y.tsx",
  ).findings;
  expect(compact.length).toBeGreaterThan(0);
  expect(wrapped.length).toBeGreaterThan(0);
  expect(wrapped[0].text).toBe(compact[0].text);
});

test("separates human copy from the machine tokens that share those positions", () => {
  for (const copy of ["Close", "New window", "Toggle light / dark theme", "Source file"]) {
    expect(isTranslatableCopy(copy)).toBe(true);
  }
  for (const token of [
    "governed-assist",
    "open-directory",
    "chat",
    "editor.command.runLint",
    "https://intranet/handbook",
    "/absolute/folder/path",
    "src/file.ts",
    "OK",
    "0 B",
    "100%",
    "${title} — ${subtitle}",
    '${f.prefix ?? ""}${option}',
  ]) {
    expect(isTranslatableCopy(token)).toBe(false);
  }
});

test("fails a changed .ts registry that carries an English label literal", async () => {
  await withFixture({ ...matchingCatalogs, [REGISTRY_FILE]: REGISTRY_SOURCE }, (repoRoot) => {
    const result = checkUiI18nGuard({ repoRoot, changedFiles: [REGISTRY_FILE] });

    expect(result.ok).toBe(false);
    const joined = result.problems.join("\n");
    expect(joined).toContain("untranslated user-facing literal");
    expect(joined).toContain('"Files"');
    expect(joined).toContain('"Browse a folder"');
  });
});

test("tolerates a literal already recorded in the ratcheted ledger", async () => {
  await withFixture(
    {
      ...matchingCatalogs,
      ...baselineFixture({ [REGISTRY_FILE]: ["Browse a folder", "Files"] }),
      [REGISTRY_FILE]: REGISTRY_SOURCE,
    },
    (repoRoot) => {
      const result = checkUiI18nGuard({ repoRoot, changedFiles: [REGISTRY_FILE] });

      expect(result.problems.join("\n")).toBe("");
      expect(result.ok).toBe(true);
    },
  );
});

test("still fails when a NEW literal joins a file that already carries known debt", async () => {
  await withFixture(
    {
      ...matchingCatalogs,
      ...baselineFixture({ [REGISTRY_FILE]: ["Files"] }),
      [REGISTRY_FILE]: REGISTRY_SOURCE,
    },
    (repoRoot) => {
      const result = checkUiI18nGuard({ repoRoot, changedFiles: [REGISTRY_FILE] });

      expect(result.ok).toBe(false);
      const joined = result.problems.join("\n");
      expect(joined).toContain('"Browse a folder"');
      expect(joined).not.toContain('2: "Files"');
    },
  );
});

test("requires the ledger to shrink when a literal is translated away", async () => {
  await withFixture(
    {
      ...matchingCatalogs,
      ...baselineFixture({ [REGISTRY_FILE]: ["Files"] }),
      [REGISTRY_FILE]: 'export const WINDOWS = [{ id: "files", labelKey: "window.files" }];\n',
    },
    (repoRoot) => {
      const result = checkUiI18nGuard({ repoRoot, changedFiles: [REGISTRY_FILE] });

      expect(result.ok).toBe(false);
      expect(result.problems.join("\n")).toContain("The ledger only shrinks");
    },
  );
});

test("honours a documented opt-out and rejects a wordless one", () => {
  const documented = untranslatedLiteralsInSource(
    '  const glyph = { label: "Item separator glyph" }; // i18n-exempt: internal join token, never rendered\n',
  );
  expect(documented.findings).toEqual([]);
  expect(documented.weakExemptions).toEqual([]);

  const wordless = untranslatedLiteralsInSource(
    "  <span>Raw copy</span> {/* i18n-exempt: n/a */}\n",
  );
  expect(wordless.findings).toEqual([]);
  expect(wordless.weakExemptions).toEqual([{ line: 1, reason: "n/a" }]);
  expect("n/a".length).toBeLessThan(I18N_EXEMPT_MIN_REASON);
});

test("reports a wordless opt-out as a gate failure with the offending line", async () => {
  await withFixture(
    {
      ...matchingCatalogs,
      [REGISTRY_FILE]: 'export const T = { title: "Open windows" }; // i18n-exempt: no\n',
    },
    (repoRoot) => {
      const result = checkUiI18nGuard({ repoRoot, changedFiles: [REGISTRY_FILE] });

      expect(result.ok).toBe(false);
      expect(result.problems.join("\n")).toContain('claims `// i18n-exempt:` with reason "no"');
    },
  );
});

test("treats a registry label literal as an i18n-relevant added line", () => {
  expect(hasI18nRelevantAddedLine('  { id: "files", label: "Files" },')).toBe(true);
  expect(hasI18nRelevantAddedLine('  label: t("window.field.folder"),')).toBe(true);
  expect(hasI18nRelevantAddedLine("  const total = left + right;")).toBe(false);
});
