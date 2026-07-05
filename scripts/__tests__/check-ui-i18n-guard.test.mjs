import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  DE_CATALOG,
  EN_CATALOG,
  checkUiI18nGuard,
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

test("fails UI source changes that do not use the i18n API", async () => {
  await withFixture(
    {
      ...matchingCatalogs,
      [UI_FILE]: "export function NewFeature() { return <p>Hard-coded text</p>; }\n",
    },
    (repoRoot) => {
      const result = checkUiI18nGuard({
        repoRoot,
        changedFiles: [UI_FILE, EN_CATALOG, DE_CATALOG],
      });

      assert.equal(result.ok, false);
      assert.match(result.problems.join("\n"), /no changed UI file uses the i18n API/);
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
