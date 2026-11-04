// Whole-tree content checks for the UI message catalogs, the half of `check:ui-i18n` that asks what a
// catalog SAYS rather than whether it changed. A catalog can satisfy every key-parity check and still
// show English to a German user: `"Loading…"` copied into the German map, or a `{name}` placeholder
// the German sentence dropped so the value never renders. Contract: docs/qa/ui-i18n-literal-gate.md
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const IDENTICAL_TERMS_FILE = "docs/qa/ui-i18n-identical-terms.json";

const TS_CATALOG_FILE =
  /(?:^|\/)(?:i18n-messages\.[^/]*|[^/]*-i18n(?:\.(?:en|de))?|autonomy-mode-labels)\.ts$/u;
const JSON_CATALOG_FILE = /-i18n\.messages\.json$/u;
// A language map names its language as one underscore-delimited token: EN_MESSAGES,
// VOICE_DE_MESSAGES, EN_FILES_WIDGET_MESSAGES.
const LANGUAGE_TOKEN = /(^|_)(EN|DE)(?=_|$)/u;
const FILE_LANGUAGE_SEGMENT = /\.(?:en|de)\.ts$/u;
const PLACEHOLDER = /\{(\w+)\}/gu;
// Punctuation and joiners, URLs, routes and globs read the same in every language.
const VERBATIM_VALUE = /^(?:https?:|mailto:|\/)|^\S*[/*]\S*$/u;

function languageOf(identifier) {
  return LANGUAGE_TOKEN.exec(identifier)?.[2]?.toLowerCase() ?? null;
}

function unwrapInitializer(node) {
  let current = node;
  while (
    current !== undefined &&
    (ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

function propertyKeyText(name) {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
    ? name.text
    : null;
}

// A value that is not a plain string (a concatenation, a function) keeps its key so parity still
// covers it, stored as `null` so the value comparisons skip what they cannot read.
function collectEntries(objectLiteral, prefix, entries) {
  for (const property of objectLiteral.properties) {
    if (ts.isSpreadAssignment(property) || property.name === undefined) continue;
    const key = propertyKeyText(property.name);
    if (key === null) continue;
    const dotted = `${prefix}${key}`;
    const value = ts.isPropertyAssignment(property)
      ? unwrapInitializer(property.initializer)
      : null;
    if (value !== null && ts.isObjectLiteralExpression(value)) {
      collectEntries(value, `${dotted}.`, entries);
    } else {
      entries.set(dotted, value !== null && ts.isStringLiteralLike(value) ? value.text : null);
    }
  }
  return entries;
}

function languageMapsInSource(source, file) {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const maps = [];
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const language = languageOf(node.name.text);
      const initializer = unwrapInitializer(node.initializer);
      if (
        language !== null &&
        initializer !== undefined &&
        ts.isObjectLiteralExpression(initializer)
      ) {
        maps.push({
          language,
          name: node.name.text,
          slot: node.name.text.replace(LANGUAGE_TOKEN, "$1"),
          entries: collectEntries(initializer, "", new Map()),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return maps;
}

function addMap(slots, label, map) {
  const slot = slots.get(label) ?? { label, en: undefined, de: undefined };
  slot[map.language] = map;
  slots.set(label, slot);
}

function jsonCatalogPair(repoRoot, file) {
  const catalog = JSON.parse(readFileSync(resolve(repoRoot, file), "utf8"));
  const en = new Map();
  const de = new Map();
  for (const [key, messages] of Object.entries(catalog)) {
    if (typeof messages?.en === "string") en.set(key, messages.en);
    if (typeof messages?.de === "string") de.set(key, messages.de);
  }
  return { label: file, en, de, problems: [] };
}

function slotToPair(slot) {
  const present = slot.en ?? slot.de;
  if (slot.en === undefined || slot.de === undefined) {
    return {
      label: slot.label,
      en: new Map(),
      de: new Map(),
      problems: [`${slot.label}: language map ${present.name} has no counterpart.`],
    };
  }
  return { label: slot.label, en: slot.en.entries, de: slot.de.entries, problems: [] };
}

export function readCatalogPairs(repoRoot, trackedFiles) {
  const slots = new Map();
  const pairs = [];
  for (const file of trackedFiles) {
    if (JSON_CATALOG_FILE.test(file)) {
      pairs.push(jsonCatalogPair(repoRoot, file));
    } else if (TS_CATALOG_FILE.test(file)) {
      const source = readFileSync(resolve(repoRoot, file), "utf8");
      const owner = file.replace(FILE_LANGUAGE_SEGMENT, ".ts");
      for (const map of languageMapsInSource(source, file)) {
        addMap(slots, `${owner} (${map.slot})`, map);
      }
    }
  }
  return [...pairs, ...Array.from(slots.values(), slotToPair)];
}

function placeholdersOf(value) {
  return new Set(Array.from(value.matchAll(PLACEHOLDER), (match) => match[1]));
}

function hasSamePlaceholders(left, right) {
  const leftSet = placeholdersOf(left);
  const rightSet = placeholdersOf(right);
  return leftSet.size === rightSet.size && [...leftSet].every((name) => rightSet.has(name));
}

export function isLocaleNeutralValue(value) {
  const words = value.replaceAll(PLACEHOLDER, "").trim();
  const letters = Array.from(words.matchAll(/\p{L}/gu)).length;
  return letters < 2 || VERBATIM_VALUE.test(words);
}

function keyParityProblems(pair) {
  const missing = (from, to, language) =>
    [...from.keys()]
      .filter((key) => !to.has(key))
      .map((key) => `${pair.label}: key "${key}" is missing from the ${language} map.`);
  return [...missing(pair.en, pair.de, "German"), ...missing(pair.de, pair.en, "English")];
}

function valueProblem(label, key, english, german, terms, used) {
  if (english.trim().length > 0 && german.trim().length === 0) {
    return `${label}: key "${key}" has an empty German value.`;
  }
  if (!hasSamePlaceholders(english, german)) {
    return `${label}: key "${key}" uses different placeholders in English (${JSON.stringify(english)}) and German (${JSON.stringify(german)}).`;
  }
  if (english !== german || isLocaleNeutralValue(english)) return null;
  if (terms.has(english)) {
    used.add(english);
    return null;
  }
  return `${label}: key "${key}" shows ${JSON.stringify(english)} in both languages. Translate it, or add it to ${IDENTICAL_TERMS_FILE} if German really uses the same term.`;
}

function pairValueProblems(pair, terms, used) {
  const problems = [];
  for (const [key, english] of pair.en) {
    const german = pair.de.get(key);
    if (typeof english !== "string" || typeof german !== "string") continue;
    const problem = valueProblem(pair.label, key, english, german, terms, used);
    if (problem !== null) problems.push(problem);
  }
  return problems;
}

export function catalogContentProblems(pairs, identicalTerms) {
  const terms = new Set(identicalTerms);
  const used = new Set();
  const problems = [];
  for (const pair of pairs) {
    problems.push(
      ...pair.problems,
      ...keyParityProblems(pair),
      ...pairValueProblems(pair, terms, used),
    );
  }
  const stale = identicalTerms.filter((term) => !used.has(term));
  if (stale.length > 0) {
    problems.push(
      `${IDENTICAL_TERMS_FILE} lists ${String(stale.length)} term(s) no catalog shows in both languages any more: ${stale.map((term) => JSON.stringify(term)).join(", ")}. Remove them.`,
    );
  }
  return problems;
}

// Fails loudly when the file is missing or malformed: an absent glossary would read as "no term may
// be identical" and bury every run under noise, which is how a gate gets switched off.
export function readIdenticalTerms(repoRoot) {
  const parsed = JSON.parse(readFileSync(resolve(repoRoot, IDENTICAL_TERMS_FILE), "utf8"));
  if (!Array.isArray(parsed.terms)) {
    throw new TypeError(`${IDENTICAL_TERMS_FILE} must contain a "terms" array.`);
  }
  return parsed.terms;
}
