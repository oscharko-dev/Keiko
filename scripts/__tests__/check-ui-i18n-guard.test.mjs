import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";

import {
  DE_CATALOG,
  EN_CATALOG,
  changedFilesFromGit,
  changedFilesFromInput,
  checkUiI18nGuard,
  hasI18nRelevantAddedLine,
  hasUserFacingTextLine,
  isUiProductionSource,
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
    for (const [file, contents] of Object.entries(files)) {
      await writeRepoFile(repoRoot, file, contents);
    }

    return await callback(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
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
  expect(isUiProductionSource("packages/keiko-ui/src/app/components/copy.ts")).toBe(false);
  expect(isUiProductionSource(EN_CATALOG)).toBe(false);
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
      expect(result.problems.join("\n")).toMatch(/do not use the i18n API/);
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
    for (const [file, contents] of Object.entries(matchingCatalogs)) {
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
