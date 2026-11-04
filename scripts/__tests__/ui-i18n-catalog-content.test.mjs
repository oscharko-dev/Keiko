import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";

import {
  catalogContentProblems,
  isLocaleNeutralValue,
  readCatalogPairs,
} from "../lib/ui-i18n-catalog-content.mjs";

const LIB = "packages/keiko-ui/src/lib";
const SHARED_EN = `${LIB}/i18n-messages.en.ts`;
const SHARED_DE = `${LIB}/i18n-messages.de.ts`;
const SINGLE = "packages/keiko-ui/src/app/feature-i18n.ts";
const JSON_CATALOG = "packages/keiko-ui/src/app/settings-i18n.messages.json";

async function withCatalogs(files, callback) {
  const repoRoot = await mkdtemp(join(tmpdir(), "keiko-i18n-content-"));
  try {
    for (const [file, contents] of Object.entries(files)) {
      const absolute = join(repoRoot, file);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, contents, "utf8");
    }
    return await callback(repoRoot, Object.keys(files));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

const sharedPair = (english, german) => ({
  [SHARED_EN]: `export const EN_MESSAGES = {\n${english}\n} as const;\n`,
  [SHARED_DE]: `export const DE_MESSAGES = {\n${german}\n} satisfies MessageCatalog;\n`,
});

async function problemsFor(files, glossary = []) {
  return withCatalogs(files, (repoRoot, tracked) =>
    catalogContentProblems(readCatalogPairs(repoRoot, tracked), glossary),
  );
}

test("accepts a fully translated pair", async () => {
  const problems = await problemsFor(
    sharedPair('"a.b": "Open {name}",', '"a.b": "{name} öffnen",'),
  );
  expect(problems).toEqual([]);
});

test("reports a key only one language declares, in either direction", async () => {
  const problems = await problemsFor(
    sharedPair('"a.b": "Open",\n"only.en": "Close",', '"a.b": "Öffnen",\n"only.de": "Schließen",'),
  );
  expect(problems.join("\n")).toContain("only.en");
  expect(problems.join("\n")).toContain("only.de");
});

test.each([
  ["a placeholder German dropped", "Open {name}", "Öffnen"],
  ["a placeholder German renamed", "Open {name}", "{titel} öffnen"],
  ["a placeholder German invented", "Open", "{name} öffnen"],
])("reports %s", async (_case, english, german) => {
  const problems = await problemsFor(sharedPair(`"a.b": "${english}",`, `"a.b": "${german}",`));
  expect(problems.join("\n")).toMatch(/a\.b.*placeholder/iu);
});

test("treats placeholder order as a translation choice, not drift", async () => {
  const problems = await problemsFor(
    sharedPair('"a.b": "{from} to {to}",', '"a.b": "nach {to} von {from}",'),
  );
  expect(problems).toEqual([]);
});

test("reports an empty German value against a non-empty English one", async () => {
  const problems = await problemsFor(sharedPair('"a.b": "Open",', '"a.b": "   ",'));
  expect(problems.join("\n")).toMatch(/a\.b.*empty/iu);
});

test("reports English copy left in the German catalog", async () => {
  const problems = await problemsFor(sharedPair('"a.b": "Loading…",', '"a.b": "Loading…",'));
  expect(problems.join("\n")).toContain("Loading…");
});

test("accepts an identical value the glossary claims and rejects the claim going stale", async () => {
  const pair = sharedPair('"a.b": "Coding Workbench",', '"a.b": "Coding Workbench",');
  expect(await problemsFor(pair, ["Coding Workbench"])).toEqual([]);
  const stale = await problemsFor(sharedPair('"a.b": "Open",', '"a.b": "Öffnen",'), [
    "Coding Workbench",
  ]);
  expect(stale.join("\n")).toContain("Coding Workbench");
});

test.each([
  [" — {reason}", true],
  [").", true],
  ["~{tokens}", true],
  ["https://docs.example.com", true],
  ["/guide", true],
  ["dist/**", true],
  ["Status", false],
  ["{duration} ms", false],
  ["Loading…", false],
])("classifies %j as locale neutral: %s", (value, neutral) => {
  expect(isLocaleNeutralValue(value)).toBe(neutral);
});

test("reads single-file catalogs whose maps carry the language in the identifier", async () => {
  const problems = await problemsFor({
    [SINGLE]: [
      'const VOICE_EN_MESSAGES = { "a": "Open {name}" } as const;',
      'const VOICE_DE_MESSAGES = { "a": "Öffnen" } satisfies Record<string, string>;',
      "",
    ].join("\n"),
  });
  expect(problems.join("\n")).toMatch(/placeholder/iu);
});

test("pairs several language maps in one file independently", async () => {
  const problems = await problemsFor({
    [SINGLE]: [
      'const EN_ONE_MESSAGES = { "a": "Open" };',
      'const DE_ONE_MESSAGES = { "a": "Öffnen" };',
      'const EN_TWO_MESSAGES = { "b": "Close" };',
      'const DE_TWO_MESSAGES = { "c": "Schließen" };',
      "",
    ].join("\n"),
  });
  const text = problems.join("\n");
  expect(text).toContain('"b"');
  expect(text).toContain('"c"');
  expect(text).not.toContain('"a"');
});

test("fails closed on a language map with no counterpart", async () => {
  const problems = await problemsFor({
    [SINGLE]: 'const VOICE_EN_MESSAGES = { "a": "Open" };\n',
  });
  expect(problems.join("\n")).toMatch(/counterpart/iu);
});

test("reads the JSON catalog form and reports its drift", async () => {
  const problems = await problemsFor({
    [JSON_CATALOG]: JSON.stringify({
      ok: { en: "Open", de: "Öffnen" },
      drift: { en: "Open {name}", de: "Öffnen" },
      same: { en: "Close it", de: "Close it" },
    }),
  });
  const text = problems.join("\n");
  expect(text).toContain("drift");
  expect(text).toContain("Close it");
  expect(text).not.toMatch(/\bok\b/u);
});

test("compares keys but not values for an entry that is not a plain string", async () => {
  const problems = await problemsFor({
    [SINGLE]: [
      'const EN_ONE_MESSAGES = { "a": "Open " + suffix, "b": (n) => n };',
      'const DE_ONE_MESSAGES = { "a": "Öffnen " + suffix };',
      "",
    ].join("\n"),
  });
  const text = problems.join("\n");
  expect(text).toContain('"b"');
  expect(text).not.toContain('"a"');
});

test("reads a nested map under dotted keys", async () => {
  const problems = await problemsFor({
    [SINGLE]: [
      'const EN_ONE_MESSAGES = { group: { "a": "Open {name}" } };',
      'const DE_ONE_MESSAGES = { group: { "a": "Öffnen" } };',
      "",
    ].join("\n"),
  });
  expect(problems.join("\n")).toContain("group.a");
});

test("ignores files that are not catalogs and declarations that are not maps", async () => {
  const pairs = await withCatalogs(
    {
      "packages/keiko-ui/src/app/Widget.tsx": 'const EN_LABELS = { "a": "Open" };\n',
      [SINGLE]: 'export const EN_SELECTOR = "x";\nexport { DE_MESSAGES } from "./other";\n',
    },
    (repoRoot, tracked) => readCatalogPairs(repoRoot, tracked),
  );
  expect(pairs).toEqual([]);
});
