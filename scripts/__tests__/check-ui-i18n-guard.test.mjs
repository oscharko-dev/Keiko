import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";

import {
  DE_CATALOG,
  EN_CATALOG,
  changedFilesFromGit,
  changedFilesFromInput,
  checkUiI18nGuard,
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
  assert.equal(isUiProductionSource(UI_FILE), true);
  assert.equal(
    isUiProductionSource("packages/keiko-ui/src/app/components/NewFeature.test.tsx"),
    false,
  );
  assert.equal(isUiProductionSource("packages/keiko-ui/src/app/components/copy.ts"), false);
  assert.equal(isUiProductionSource(EN_CATALOG), false);
  assert.equal(isUiProductionSource("src/server.ts"), false);
});

test("passes when changed files are outside UI production source", async () => {
  await withFixture(matchingCatalogs, (repoRoot) => {
    const result = checkUiI18nGuard({
      repoRoot,
      changedFiles: ["docs/architecture.md"],
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.problems, []);
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

      assert.equal(result.ok, true);
      assert.deepEqual(result.problems, []);
      assert.deepEqual(result.i18nRelevantFiles, []);
    },
  );
});

test("recognizes user-facing JSX, a11y attributes, and return strings", () => {
  assert.equal(hasUserFacingTextLine("<p>Hard-coded text</p>"), true);
  assert.equal(hasUserFacingTextLine('<button aria-label="Open">'), true);
  assert.equal(hasUserFacingTextLine('return "Enter a name.";'), true);
  assert.equal(hasUserFacingTextLine('<g transform="translate(10 10)">'), false);
  assert.equal(hasUserFacingTextLine("// Called when the user opens a file."), false);
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

  assert.deepEqual(files, [UI_FILE, EN_CATALOG, DE_CATALOG]);
  assert.equal(calls[0], "abc1234..HEAD");
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

  assert.deepEqual(files, [UI_FILE]);
  assert.deepEqual(calls, ["deadbee..HEAD", "deadbee...HEAD", "origin/dev...HEAD"]);
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

  assert.deepEqual(files, [UI_FILE]);
  assert.equal(calls[0], "origin/release-1209...HEAD");
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

  assert.deepEqual(files, [UI_FILE]);
  assert.deepEqual(calls, ["HEAD^1..HEAD"]);
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

  assert.deepEqual(files, [EN_CATALOG, DE_CATALOG]);
  assert.equal(calls[0], "origin/dev...HEAD");
});

test("rejects unsafe git env values before spawning git", () => {
  assert.throws(
    () =>
      changedFilesFromGit("repo", () => ({ ok: true, error: "", files: [] }), {
        KEIKO_I18N_GUARD_BASE_REF: "--help",
      }),
    /unsafe base ref/,
  );
});

test("fails closed when changed files cannot be determined from git", () => {
  assert.throws(
    () =>
      changedFilesFromGit("repo", () => ({ ok: false, error: "missing range", files: [] }), {
        GITHUB_EVENT_NAME: "push",
      }),
    /could not determine changed files/,
  );
});

test("reads explicit changed files from argv", () => {
  const files = changedFilesFromInput("repo", ["node", "script.mjs", "--files", UI_FILE], {});

  assert.deepEqual(files, [UI_FILE]);
});

test("reads explicit changed files from env", () => {
  const files = changedFilesFromInput("repo", ["node", "script.mjs"], {
    KEIKO_I18N_GUARD_CHANGED_FILES: `${UI_FILE}\ndocs/architecture.md`,
  });

  assert.deepEqual(files, [UI_FILE, "docs/architecture.md"]);
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

      assert.equal(result.ok, false);
      assert.match(result.problems.join("\n"), /i18n-messages\.en\.ts/);
      assert.match(result.problems.join("\n"), /i18n-messages\.de\.ts/);
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

      assert.equal(result.ok, false);
      assert.match(result.problems.join("\n"), /do not use the i18n API/);
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

      assert.equal(result.ok, false);
      assert.match(result.problems.join("\n"), /AnotherFeature\.tsx/);
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

      assert.equal(result.ok, false);
      assert.match(result.problems.join("\n"), /do not use the i18n API/);
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

      assert.equal(result.ok, true);
      assert.deepEqual(result.problems, []);
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

      assert.equal(result.ok, false);
      assert.match(result.problems.join("\n"), /feature\.subtitle/);
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
  await withGitFixture(async (repoRoot, run) => {
    // The unchanged t("feature.title") call stays on its own line, untouched, exactly like a real
    // diff hunk that only edits nearby structural code (e.g. adding a ref/tabIndex to a heading).
    await writeRepoFile(
      repoRoot,
      UI_FILE,
      'import { useRef } from "react";\nimport { useTranslate } from "@/lib/i18n";\nexport function NewFeature() {\n  const t = useTranslate();\n  const ref = useRef(null);\n  return (\n    <p ref={ref}>\n      {t("feature.title")}\n    </p>\n  );\n}\n',
    );

    run(["add", "-A"]);
    run(["commit", "-q", "-m", "refactor"]);

    const result = checkUiI18nGuard({ repoRoot, changedFiles: [UI_FILE] });

    assert.equal(result.ok, true);
    assert.deepEqual(result.problems, []);
  });
});

test("fails a change that adds a genuinely new translation key without updating catalogs", async () => {
  await withGitFixture(async (repoRoot, run) => {
    await writeRepoFile(
      repoRoot,
      UI_FILE,
      'import { useTranslate } from "@/lib/i18n";\nexport function NewFeature() {\n  const t = useTranslate();\n  return (\n    <>\n      <p>{t("feature.title")}</p>\n      <p>{t("feature.subtitle")}</p>\n    </>\n  );\n}\n',
    );
    run(["add", "-A"]);
    run(["commit", "-q", "-m", "add subtitle"]);

    const result = checkUiI18nGuard({ repoRoot, changedFiles: [UI_FILE] });

    assert.equal(result.ok, false);
    assert.match(result.problems.join("\n"), /i18n-messages\.en\.ts/);
  });
});

test("fails a change that adds new hard-coded user-facing text", async () => {
  await withGitFixture(async (repoRoot, run) => {
    await writeRepoFile(
      repoRoot,
      UI_FILE,
      'import { useTranslate } from "@/lib/i18n";\nexport function NewFeature() {\n  const t = useTranslate();\n  return (\n    <>\n      <p>{t("feature.title")}</p>\n      <p>Hard-coded text</p>\n    </>\n  );\n}\n',
    );
    run(["add", "-A"]);
    run(["commit", "-q", "-m", "add hard-coded text"]);

    const result = checkUiI18nGuard({ repoRoot, changedFiles: [UI_FILE] });

    assert.equal(result.ok, false);
    assert.match(result.problems.join("\n"), /i18n-messages\.en\.ts/);
  });
});
