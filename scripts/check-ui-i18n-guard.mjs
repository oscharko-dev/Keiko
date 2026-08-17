#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { resolveHostExecutable } from "./lib/host-executable.mjs";

export const EN_CATALOG = "packages/keiko-ui/src/lib/i18n-messages.en.ts";
export const DE_CATALOG = "packages/keiko-ui/src/lib/i18n-messages.de.ts";

// The optional-widget catalog pair, read through `useOptionalWidgetTranslate`. It is a real
// English/German catalog — the quick-access palette, the browser/commands/terminal widgets and the
// search panel take every string from it — but it predates the `-i18n.{en,de}.ts` naming this guard
// recognises, so a component whose strings legitimately live here was told to update shared
// catalogs it never reads (#2768). Recognised by exact path rather than by loosening a pattern, and
// only when BOTH halves change: the requirement this guard exists to enforce is "English and German
// land together", which is exactly what that condition asserts.
//
// Key parity needs no separate check here, unlike the split-file feature catalogs: the German map is
// declared `satisfies OptionalWidgetMessageCatalog`, whose key type is derived from the English map,
// so a missing or extra German key is a type error before this gate ever runs.
export const OPTIONAL_WIDGET_EN_CATALOG = "packages/keiko-ui/src/lib/i18n-messages.optional.en.ts";
export const OPTIONAL_WIDGET_DE_CATALOG = "packages/keiko-ui/src/lib/i18n-messages.optional.de.ts";

const UI_SOURCE_PREFIXES = ["packages/keiko-ui/src/app/", "packages/keiko-ui/src/lib/"];
const I18N_USAGE_PATTERNS = [
  /\buseTranslate\s*\(/,
  /\buseOptionalWidgetTranslate\s*\(/,
  // Feature-scoped catalog hook for the dynamically loaded Coding Workbench (#2257 boundary).
  /\buseCodingWorkbenchTranslate\s*\(/,
  /\buseI18n\s*\(/,
  /<\s*I18nTranslate\b/,
  /\bOptionalWidgetTranslate\b/,
  // Non-hook seams. A module that is not a component cannot call a hook, so it takes the translate
  // function as a parameter (`I18nTranslate`) or calls the pure `translate`/`translateOptionalWidget`
  // entry points. Before these three patterns existed, the guard classified exactly those modules —
  // the window-type registry among them — as "does not use the i18n API", which is one half of why
  // hardcoded English in a `.ts` registry was invisible to it.
  /\bI18nTranslate\b/,
  // The feature-scoped analogue of `I18nTranslate`, for the same reason: a non-component module in
  // the Coding Workbench takes its catalog's translate function as a parameter rather than calling
  // the hook. The hook was listed above but the type was not, so a label module that routes every
  // string through `t(...)` was still reported as "does not use the i18n API".
  /\bCodingWorkbenchTranslate\b/,
  /\btranslateOptionalWidget\s*\(/,
  /\blocalizedWindow[A-Za-z]*\s*\(/,
  // Feature-scoped catalog hooks for the Problems panel (Issue #2213) and other panels that
  // ship their own EN/DE catalog under `packages/keiko-ui/src/app/components/desktop/widgets/panels/*-i18n.ts`.
  // These follow the same shape as `useTranslate` / `useCodingWorkbenchTranslate` above:
  // a hook that returns `(key, values?) => string`, backed by a matching-key EN and DE map.
  /\buseProblemsTranslate\s*\(/,
];
// Each quoted alternative used to open with an unbounded [^"]* that overlaps the required
// [A-Za-z] pivot and the unbounded [^"]* that follows it, so a quote-less run of letters made
// the engine explore every way to split the run between the two — O(n^2) worst case. Excluding
// letters from the leading quantifier removes the ambiguous split (it can only stop at the first
// letter) while still matching exactly when the quoted content contains at least one letter.
//
// The attribute-name alternation (6 branches) used to live in the same regex literal as the
// quoted-value alternation (3 branches, each with the S8786-hardened shape above); combined, that
// crossed SonarCloud S5843's complexity threshold. Splitting the name scan from the value check
// into two regexes applied in sequence — hasUserFacingAttribute below finds each
// `name\s*=\s*` occurrence via USER_FACING_ATTRIBUTE_NAME_RE and then tests
// USER_FACING_ATTRIBUTE_VALUE_RE against the text immediately following it — is behaviourally
// identical to the single combined pattern's `.test()`: both return true iff some position in the
// line has one of the 6 attribute names followed by one of the 3 quoted-letter value shapes.
// `data-tip` joined the list with the per-literal rule below: it is the design system's tooltip
// attribute, so its value is copy the user reads, exactly like `title`.
const USER_FACING_ATTRIBUTE_NAME_RE =
  /\b(?:aria-label|aria-description|aria-placeholder|alt|placeholder|title|data-tip)\s*=\s*/gu;
// Split from one 3-branch alternation into 3 separate patterns tried via `.some()`
// (typescript:S5843 — the combined form was still over the complexity threshold even after the
// name/value split above). Only ever used via `.test()` with no group captures, so trying the
// three quote-shapes independently is behaviorally identical to the single combined pattern.
const USER_FACING_ATTRIBUTE_VALUE_PATTERNS = [
  /^"[^"A-Za-z]*[A-Za-z][^"]*"/u,
  /^'[^'A-Za-z]*[A-Za-z][^']*'/u,
  /^`[^`A-Za-z]*[A-Za-z][^`]*`/u,
];

function matchesUserFacingAttributeValue(text) {
  return USER_FACING_ATTRIBUTE_VALUE_PATTERNS.some((pattern) => pattern.test(text));
}

function hasUserFacingAttribute(line) {
  USER_FACING_ATTRIBUTE_NAME_RE.lastIndex = 0;
  let nameMatch;
  while ((nameMatch = USER_FACING_ATTRIBUTE_NAME_RE.exec(line)) !== null) {
    const valueStart = nameMatch.index + nameMatch[0].length;
    if (matchesUserFacingAttributeValue(line.slice(valueStart))) {
      return true;
    }
  }
  return false;
}

// The single-quote span between `quote` and its next occurrence, or null when `text` does not start
// with a quote at all (an expression such as `aria-label={t("…")}` — already translated, and not a
// literal this guard has anything to say about).
function quotedValueAt(text) {
  const quote = text[0];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  const end = text.indexOf(quote, 1);
  return end < 0 ? null : text.slice(1, end);
}

function quotedValuesAfter(line, nameRe) {
  nameRe.lastIndex = 0;
  const values = [];
  let nameMatch;
  while ((nameMatch = nameRe.exec(line)) !== null) {
    const value = quotedValueAt(line.slice(nameMatch.index + nameMatch[0].length));
    if (value !== null) values.push(value);
  }
  return values;
}

// The option/command registries. Keiko's launcher grid, quick-access command list, KeikoSelect
// menus and agent picker are all driven by object literals whose `label`/`description`/`title`/
// `scope`/`cta` fields render verbatim, which is how a whole German-locale surface can be English
// without a single JSX literal in sight (issue: `AGENT_WORKFLOWS`, `WIN_TYPES`).
const LABEL_FIELD_NAME_RE =
  /\b(?:label|labelText|description|desc|title|cta|scope|group|menuTitle|ariaLabel|tip|hint|placeholder|summary)\s*:\s*/gu;
// This used to be a single alternation of `"[^"]*\s[A-Za-z][^"]*"`-shaped branches (and similarly
// for '...' and `...`). Unlike USER_FACING_ATTRIBUTE_PATTERN's pivot (a single [A-Za-z] class),
// this pivot is the two-character sequence `\s[A-Za-z]`, so excluding letters alone from the
// leading quantifier isn't sufficient — e.g. content "1 2 a" has an early space (before "2") that
// isn't part of a valid pivot, so a leading class that merely excludes letters would stop too
// early and miss the real (later) pivot. Since neither `[^"]*` run can cross an interior quote of
// the same type, the closing quote is always the first one found after the opening quote — so the
// safe fix is to find that fixed opening/closing quote span with a plain indexOf (no ambiguous
// backtracking possible) and test the small, unambiguous `/\s[A-Za-z]/` pivot only within that
// bounded substring, instead of letting a single regex re-explore the split over the whole line.
const RETURN_QUOTE_OPEN_PATTERN = /\breturn\s+(["'`])/gu;
const WHITESPACE_LETTER_PIVOT_PATTERN = /\s[A-Za-z]/u;

function hasUserFacingStringReturn(line) {
  RETURN_QUOTE_OPEN_PATTERN.lastIndex = 0;
  let match;
  while ((match = RETURN_QUOTE_OPEN_PATTERN.exec(line)) !== null) {
    const quote = match[1];
    const contentStart = match.index + match[0].length;
    const contentEnd = line.indexOf(quote, contentStart);
    if (
      contentEnd !== -1 &&
      WHITESPACE_LETTER_PIVOT_PATTERN.test(line.slice(contentStart, contentEnd))
    ) {
      return true;
    }
  }
  return false;
}
const I18N_KEY_REFERENCE_PATTERN = /\bt\s*\(\s*(?:"[^"]+"|'[^']+'|`[^`]+`)/u;

const FEATURE_CATALOG_EN_PATTERN = /-i18n\.en\.ts$/u;
const FEATURE_CATALOG_DE_PATTERN = /-i18n\.de\.ts$/u;
// The split-file convention above has exactly one instance (the Coding Workbench boundary). The
// dominant convention in this package is a SINGLE `*-i18n.ts` carrying both language maps, which
// this guard could not see: a feature using it was told to update the shared catalogs its component
// never reads. The requirement is unchanged — English and German must land together — so a
// single-file catalog satisfies it only when both maps are present AND expose identical keys, which
// `singleFileCatalogParityProblems` enforces exactly as the split-file parity check does.
//
// A third convention shares the `-i18n.ts` suffix without being a catalog: a key-mapping HELPER
// (e.g. `managed-language-i18n.ts`, `problems-i18n.ts`) that declares no language map of its own
// and types its values against the shared catalog's `MessageKey` — its strings live in
// `i18n-messages.en/de.ts`, which carry their own update and parity requirements. Such a helper is
// classified by content, not filename: zero `_EN_MESSAGES`/`_DE_MESSAGES` declarations plus a
// `MessageKey` reference. It neither satisfies the catalog-update requirement (its keys land in the
// shared catalogs, so those must change) nor gets the local parity check (there is nothing local to
// compare). A `-i18n.ts` file with exactly one map keeps failing closed as an incomplete catalog.
const FEATURE_CATALOG_SINGLE_SUFFIX = "-i18n.ts";
const CATALOG_LANGUAGE_MAP_PATTERN = /_(EN|DE)_MESSAGES\b/gu;

function isSharedCatalogKeyHelper(repoRoot, file) {
  let source;
  try {
    source = readText(repoRoot, file);
  } catch {
    // A deleted `-i18n.ts` cannot need local parity; classify it out of the catalog set.
    return true;
  }
  const declaredMaps = [...source.matchAll(CATALOG_LANGUAGE_MAP_PATTERN)];
  return declaredMaps.length === 0 && source.includes("MessageKey");
}

export function changedSingleFileFeatureCatalogs(changedFileSet, repoRoot) {
  return [...changedFileSet]
    .filter(
      (file) =>
        file.startsWith("packages/keiko-ui/src/") && file.endsWith(FEATURE_CATALOG_SINGLE_SUFFIX),
    )
    .filter((file) => repoRoot === undefined || !isSharedCatalogKeyHelper(repoRoot, file))
    .sort((left, right) => left.localeCompare(right));
}

export function changedFeatureCatalogPairs(changedFileSet) {
  const pairs = [];
  for (const file of changedFileSet) {
    if (!file.startsWith("packages/keiko-ui/src/") || !file.endsWith("-i18n.en.ts")) {
      continue;
    }
    const counterpart = file.replace(FEATURE_CATALOG_EN_PATTERN, "-i18n.de.ts");
    if (changedFileSet.has(counterpart)) pairs.push([file, counterpart]);
  }
  return pairs.sort((a, b) => a[0].localeCompare(b[0]));
}

export function unpairedFeatureCatalogs(changedFileSet) {
  const unpaired = [];
  for (const file of changedFileSet) {
    if (!file.startsWith("packages/keiko-ui/src/")) continue;
    if (file.endsWith("-i18n.en.ts")) {
      const de = file.replace(FEATURE_CATALOG_EN_PATTERN, "-i18n.de.ts");
      if (!changedFileSet.has(de)) unpaired.push(file);
    } else if (file.endsWith("-i18n.de.ts")) {
      const en = file.replace(FEATURE_CATALOG_DE_PATTERN, "-i18n.en.ts");
      if (!changedFileSet.has(en)) unpaired.push(file);
    }
  }
  return unpaired.sort((a, b) => a.localeCompare(b));
}

// Feature-scoped catalog pairs (e.g. the dynamically loaded Coding Workbench boundary from
// #2257) satisfy the catalog-update requirement exactly like the shared catalogs, as long as
// the English and German halves change together.
// `satisfied` when both halves changed; a one-sided change is named for what it is rather than
// falling through to the shared-catalog message, which would send the author to the wrong file.
function optionalWidgetCatalogState(changedFileSet) {
  const en = changedFileSet.has(OPTIONAL_WIDGET_EN_CATALOG);
  const de = changedFileSet.has(OPTIONAL_WIDGET_DE_CATALOG);
  if (en && de) return { satisfied: true, problem: undefined };
  if (en === de) return { satisfied: false, problem: undefined };
  const changed = en ? OPTIONAL_WIDGET_EN_CATALOG : OPTIONAL_WIDGET_DE_CATALOG;
  const missing = en ? OPTIONAL_WIDGET_DE_CATALOG : OPTIONAL_WIDGET_EN_CATALOG;
  return {
    satisfied: false,
    problem: `Optional-widget i18n catalog ${changed} changed without its counterpart ${missing}. Update the English and German halves together.`,
  };
}

function catalogUpdateProblems(changedFileSet, repoRoot) {
  const featureCatalogPairs = changedFeatureCatalogPairs(changedFileSet);
  const singleFileCatalogs = changedSingleFileFeatureCatalogs(changedFileSet, repoRoot);
  const sharedCatalogsTouched = changedFileSet.has(EN_CATALOG) && changedFileSet.has(DE_CATALOG);
  const optional = optionalWidgetCatalogState(changedFileSet);
  const problems = [];
  if (
    sharedCatalogsTouched ||
    optional.satisfied ||
    featureCatalogPairs.length > 0 ||
    singleFileCatalogs.length > 0
  ) {
    return { problems, featureCatalogPairs, singleFileCatalogs };
  }
  if (optional.problem !== undefined) {
    problems.push(optional.problem);
    return { problems, featureCatalogPairs, singleFileCatalogs };
  }
  for (const catalog of [EN_CATALOG, DE_CATALOG]) {
    if (!changedFileSet.has(catalog)) {
      problems.push(
        `UI source changed, but ${catalog} was not updated. Add English and German catalog entries for UI-facing text.`,
      );
    }
  }
  for (const file of unpairedFeatureCatalogs(changedFileSet)) {
    problems.push(
      `Feature i18n catalog ${file} changed without its language counterpart. Update the English and German halves together.`,
    );
  }
  return { problems, featureCatalogPairs, singleFileCatalogs };
}

// The split-file parity check compares two files; here both halves live in one file, so the same
// guarantee needs the maps sliced apart before their key sets are compared. Without this, a
// single-file catalog would satisfy the update requirement while carrying English-only additions —
// which would make this guard weaker for the convention most of the package actually uses.
// The SECOND catalog map's body, bounded by its own braces rather than running to end of file.
//
// The first map is naturally bounded by the second map's declaration, but the second had nothing
// after it, so every quoted key in the rest of the file counted as one of its entries. That held
// only while the trailing code was plain functions. A module that declares a keyed lookup AFTER its
// catalogs — e.g. a closed `Record<ReasonCode, MessageKey>` mapping a server reason code onto a
// catalog key — had those code names read as catalog entries present in one language and missing
// from the other, reporting a parity break in a file whose two catalogs are actually identical
// (0.3.0 audit, #2802). Bounding to the matching brace is strictly more precise: the whole catalog
// is still compared, and only non-catalog text stops being counted as part of it.
function catalogMapBody(source, markerIndex) {
  const open = source.indexOf("{", markerIndex);
  if (open < 0) return source.slice(markerIndex);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  // Unbalanced braces: fall back to the old end-of-file behaviour rather than silently comparing
  // an empty catalog, which would turn a malformed file into a PASS.
  return source.slice(markerIndex);
}

function singleFileCatalogParityProblems(repoRoot, singleFileCatalogs) {
  const problems = [];
  for (const file of singleFileCatalogs) {
    const source = readText(repoRoot, file);
    const boundaries = [...source.matchAll(CATALOG_LANGUAGE_MAP_PATTERN)];
    const english = boundaries.find((match) => match[1] === "EN");
    const german = boundaries.find((match) => match[1] === "DE");
    if (english?.index === undefined || german?.index === undefined) {
      problems.push(
        `Feature i18n catalog ${file} must declare both an English and a German message map.`,
      );
      continue;
    }
    const [first, second] =
      english.index < german.index ? [english.index, german.index] : [german.index, english.index];
    const mismatches = symmetricDifference(
      extractCatalogKeys(source.slice(first, second)),
      extractCatalogKeys(catalogMapBody(source, second)),
    );
    if (mismatches.length > 0) {
      problems.push(
        `Feature i18n catalog ${file} must expose the same keys in English and German. Mismatched keys: ${mismatches.join(", ")}.`,
      );
    }
  }
  return problems;
}

function featureCatalogParityProblems(repoRoot, featureCatalogPairs) {
  const problems = [];
  for (const [enFile, deFile] of featureCatalogPairs) {
    const pairMismatches = symmetricDifference(
      extractCatalogKeys(readText(repoRoot, enFile)),
      extractCatalogKeys(readText(repoRoot, deFile)),
    );
    if (pairMismatches.length > 0) {
      problems.push(
        `Feature i18n catalogs ${enFile} and ${deFile} must expose the same keys. Mismatched keys: ${pairMismatches.join(", ")}.`,
      );
    }
  }
  return problems;
}

function normalizePath(file) {
  return file.replaceAll("\\", "/").replace(/^\.\//, "");
}

// A catalog or a catalog-shaped helper is the i18n layer itself; every string in it is by definition
// already translated, so it is never a subject of these checks. Recognised by name so the set cannot
// drift with a directory move.
function isI18nInfrastructure(normalized) {
  const name = basename(normalized);
  if (normalized === EN_CATALOG || normalized === DE_CATALOG) return true;
  if (name === "i18n.tsx" || name === "optional-widget-i18n.ts") return true;
  if (name.startsWith("i18n-messages.")) return true;
  return /-i18n(?:\.(?:en|de))?\.tsx?$/u.test(name);
}

export function isUiProductionSource(file) {
  const normalized = normalizePath(file);

  // Issue: German locale coverage. `.ts` used to be excluded outright, which is why the window-type
  // registry — the single table every window-launching surface renders its copy from — was never
  // examined by this gate. TypeScript files hold registries, command tables and message builders;
  // "user-facing text only lives in .tsx" was never true.
  if (!normalized.endsWith(".tsx") && !normalized.endsWith(".ts")) {
    return false;
  }

  if (
    normalized.endsWith(".d.ts") ||
    normalized.includes("/__tests__/") ||
    /\.(test|spec)\.(tsx|ts)$/.test(normalized)
  ) {
    return false;
  }

  if (isI18nInfrastructure(normalized)) {
    return false;
  }

  return UI_SOURCE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

// The indentation class is HORIZONTAL whitespace, not `\s`: under `m`, `^` already anchors at every
// line start, so a `\s*` that can also consume newlines lets one match begin many lines above its
// quote — overlapping start positions the engine has to backtrack through, which is the super-linear
// shape SonarJS flags. `[ \t]*` matches the same real catalog lines with no ambiguity.
export function extractCatalogKeys(source) {
  return new Set(Array.from(source.matchAll(/^[ \t]*"([^"]+)":/gm), (match) => match[1]));
}

function readText(repoRoot, file) {
  return readFileSync(resolve(repoRoot, file), "utf8");
}

function hasI18nUsage(repoRoot, file) {
  const source = readText(repoRoot, file);
  return I18N_USAGE_PATTERNS.some((pattern) => pattern.test(source));
}

function nonCompliantUiFiles(repoRoot, uiFiles) {
  return uiFiles.filter((file) => !hasI18nUsage(repoRoot, file));
}

function isCommentLine(line) {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*");
}

function isAsciiLetter(character) {
  if (character === undefined) return false;
  const code = character.codePointAt(0);
  return code !== undefined && ((code >= 65 && code <= 90) || (code >= 97 && code <= 122));
}

function isTagNameCharacter(character) {
  if (isAsciiLetter(character)) return true;
  return (
    character !== undefined &&
    ((character >= "0" && character <= "9") || "_.:-".includes(character))
  );
}

function readTagName(line, start) {
  if (!isAsciiLetter(line[start])) return null;
  let end = start + 1;
  while (isTagNameCharacter(line[end])) end += 1;
  return { end, name: line.slice(start, end) };
}

function findTagEnd(line, start) {
  let quote = null;
  for (let index = start; index < line.length; index += 1) {
    const character = line[index];
    if (quote !== null) {
      if (character === quote && line[index - 1] !== "\\") quote = null;
    } else if (character === '"' || character === "'" || character === "`") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

function readJsxTag(line, start) {
  if (line[start] !== "<") return null;
  const closing = line[start + 1] === "/";
  const nameStart = start + (closing ? 2 : 1);
  const tagName = readTagName(line, nameStart);
  if (tagName === null) return null;
  const end = findTagEnd(line, tagName.end);
  return end < 0 ? null : { closing, end, name: tagName.name };
}

function isDirectUserFacingText(text) {
  if (text.includes("<") || text.includes("{") || text.includes("}")) return false;
  return Array.from(text).some(isAsciiLetter);
}

function userFacingJsxTexts(line) {
  let cursor = 0;
  const texts = [];
  while (cursor < line.length) {
    const openingStart = line.indexOf("<", cursor);
    if (openingStart < 0) return texts;
    const openingTag = readJsxTag(line, openingStart);
    cursor = openingStart + 1;
    if (openingTag === null || openingTag.closing) continue;

    const closingStart = line.indexOf("</", openingTag.end + 1);
    if (closingStart < 0) continue;
    const closingTag = readJsxTag(line, closingStart);
    const text = line.slice(openingTag.end + 1, closingStart);
    if (
      closingTag?.closing &&
      closingTag.name === openingTag.name &&
      isDirectUserFacingText(text)
    ) {
      texts.push(text);
    }
  }
  return texts;
}

function hasUserFacingJsxText(line) {
  return userFacingJsxTexts(line).length > 0;
}

export function hasUserFacingTextLine(line) {
  if (isCommentLine(line)) return false;
  return (
    hasUserFacingJsxText(line) || hasUserFacingAttribute(line) || hasUserFacingStringReturn(line)
  );
}

// ---------------------------------------------------------------------------
// Untranslated user-facing literal detection.
//
// Everything above answers "does this CHANGED .tsx mention an i18n API SOMEWHERE in the file?". That
// question cannot fail on the case it exists to prevent: a component may route ten strings through
// `useTranslate` and hardcode the eleventh and still pass, and a `.ts` file was not examined at all.
// The whole window-type table — every window title, description, launcher-field label and CTA the
// window launcher, the New Window dialog and the quick-access command list render — shipped as
// English literals in a `.ts` registry while this gate reported OK on every change to it.
//
// The rule below is per LITERAL and per POSITION, in the three positions a string literal is read by
// a user: JSX text, a user-facing attribute value, and a label/description field of an option or
// command registry. It is evaluated against a committed baseline ledger, the same ratchet idiom the
// coverage gate uses (ADR-0158 / docs/qa/coverage-truth-model.md): a literal already in the ledger is
// pre-existing debt that may only shrink, and any literal NOT in it fails the gate.
//
// Opt-out for a genuinely non-user-facing literal: put `// i18n-exempt: <reason>` at the end of the
// line, or on the line immediately above it. The marker lives in the source, so the claim and its
// reason appear in the diff a reviewer reads — unlike a silent allowlist. A reason shorter than
// I18N_EXEMPT_MIN_REASON characters is itself a gate failure, so the escape hatch cannot be used
// wordlessly.
//
// Full contract, scope and known limits: docs/qa/ui-i18n-literal-gate.md
// Both comment forms, because JSX children cannot carry a `//` comment: `// i18n-exempt: reason` in
// TypeScript positions, `{/* i18n-exempt: reason */}` next to JSX text. The reason capture stops at
// the first `*` (the start of `*/`) or the end of the line.
const I18N_EXEMPT_MARKER = /\/[/*]\s*i18n-exempt:([^*\n]*)/u;
export const I18N_EXEMPT_MIN_REASON = 12;

export function i18nExemptReason(line) {
  const match = I18N_EXEMPT_MARKER.exec(line);
  return match === null ? null : (match[1] ?? "").trim();
}

const COPY_URL_LIKE = /^(?:https?:|file:|mailto:|data:|tel:|\/|\.{1,2}\/|[A-Za-z]:[\\/])/u;
// A lowercase slug/dotted key/identifier is a machine token (`governed-assist`, `open-directory`,
// `chat`, `a.b.c`), never copy. Rejecting it also rejects lowercase single-word copy such as
// "optional"; that is a deliberate precision-over-recall trade so the gate cannot cry wolf on the
// hundreds of enum members, modes and CSS-ish tokens that sit in these same positions.
const COPY_LOWER_TOKEN = /^[a-z0-9]+(?:[-_.:][a-z0-9]+)*$/u;
const COPY_UPPER_CONST = /^[A-Z][A-Z0-9_]*$/u;
const COPY_NUMERIC_UNIT = /^\d+(?:[.,]\d+)?\s*[A-Za-z%]{0,6}$/u;
const COPY_SENTENCE_START = /^[A-Z][a-z]/u;

function letterCount(text) {
  let count = 0;
  for (const character of text) {
    if (isAsciiLetter(character)) count += 1;
  }
  return count;
}

// `${…}` segments are code, not copy. A template literal that is NOTHING but interpolations plus
// punctuation (`${title} — ${subtitle}`, `${f.prefix ?? ""}${option}`) composes strings the user reads
// but contributes no words of its own, so its parts are translated where they are produced; judging it
// on the letters inside the expressions would report the composer instead.
const INTERPOLATION_RE = /\$\{[^}]*\}/gu;

export function isTranslatableCopy(value) {
  const text = value.replaceAll(INTERPOLATION_RE, "").trim();
  if (letterCount(text) < 2) return false;
  if (COPY_URL_LIKE.test(text)) return false;
  if (COPY_LOWER_TOKEN.test(text)) return false;
  if (COPY_UPPER_CONST.test(text)) return false;
  if (COPY_NUMERIC_UNIT.test(text)) return false;
  const spaced = /\s/u.test(text);
  // A slash inside a single token is a path or a mime type; inside a phrase it is prose
  // ("Toggle light / dark theme"), so only the unspaced form is rejected.
  if (!spaced && /[\\/]/u.test(text)) return false;
  return spaced || COPY_SENTENCE_START.test(text);
}

export function untranslatedLiteralsInLine(line) {
  if (isCommentLine(line)) return [];
  return [
    ...userFacingJsxTexts(line),
    ...quotedValuesAfter(line, USER_FACING_ATTRIBUTE_NAME_RE),
    ...quotedValuesAfter(line, LABEL_FIELD_NAME_RE),
  ]
    .map((value) => value.trim())
    .filter(isTranslatableCopy);
}

function exemptReasonFor(lines, index) {
  const own = i18nExemptReason(lines[index] ?? "");
  if (own !== null) return own;
  return index > 0 ? i18nExemptReason(lines[index - 1] ?? "") : null;
}

// KEIKO-0299: JSX text was scanned per-line. `isDirectUserFacingText` rejected any text containing
// `{` or `}`, and `userFacingJsxTexts` required the opening tag, text and closing tag to sit on
// the same source line. Both multi-line JSX text (`<p>\n  Hello\n</p>`) and any
// `{"literal"}`/`{'literal'}` expression-container child were invisible to the scan, so the
// baseline ledger materially understated the untranslated surface. Now: parse with the TypeScript
// compiler API and collect JsxText plus string-literal expression-container CHILDREN directly. The
// two non-JSX passes below (user-facing attributes, label/description fields) still run per-line —
// they already work for the simple cases the baseline was calibrated against and are out of scope
// for this widening. The exported shape stays `{findings, weakExemptions}` so literalScanForFile's
// two call sites need no change.
//
// Parser kind is chosen from the file extension: `.tsx` is parsed as TSX, everything else (`.ts`,
// `.mts`, `.cts`) as TS. That distinction matters because TSX parses `<T>` as the opening tag of a
// JSX element, which turns generic-heavy TypeScript source into a stream of "JsxText" nodes and
// generates thousands of false untranslated-copy entries (the pre-fix regression that shipped in
// #3202 flagged parts of `coding-workbench-live-state.ts` as untranslated copy for exactly this
// reason).
//
// Expression-container children are collected only when their parent is a JsxElement or a
// JsxFragment. A string literal inside a JsxAttribute value (`className={"Internal label"}`)
// is code, not user-visible text, and the per-line attribute pass below already knows which
// attribute names are user-facing — collecting them here would double-count with different rules.

function isJsxExpressionChildOfElement(node) {
  const parent = node.parent;
  return parent !== undefined && (ts.isJsxElement(parent) || ts.isJsxFragment(parent));
}

// KEIKO-0299 (review-follow-up on 44b9ef9b): the per-line attribute pass only sees directly
// quoted values (`aria-label="Copy"`). A user-facing attribute whose value is an EXPRESSION
// (`aria-label={cond ? "Copied" : "Copy code block"}`, `title={hasSources ? undefined : "Attach"}`,
// `placeholder={label ?? "Fallback"}`) is invisible to it. The AST pass now collects literals
// from expression values on THIS specific set of attribute names, reusing the same recursion
// (`jsxChildExpressionLiteralTexts`) that handles conditional / template / logical shapes for
// JSX children.
//
// Names come from BOTH the kebab-case intrinsic-element policy (USER_FACING_ATTRIBUTE_NAME_RE
// above) AND the camelCase policy custom components use for the same accessible-name roles
// (LABEL_FIELD_NAME_RE below). Codex 3792890962 on #3202 called out `ariaLabel` on `KeikoSelect`
// as the concrete case that was missing — the AST scanner had only kebab-case ARIA names, so
// `ariaLabel={cond ? "Working now" : "Select source"}` slipped past both scanners. The unified
// set makes the AST policy match the per-line one at parity.
const USER_FACING_ATTRIBUTE_NAMES = new Set([
  // Kebab-case (HTML / ARIA on intrinsic elements — matches USER_FACING_ATTRIBUTE_NAME_RE).
  "aria-label",
  "aria-description",
  "aria-placeholder",
  // Codex 3793795574 on #3202: `aria-valuetext` is the human-readable text assistive tech
  // announces for `<progress>`, `<meter>`, and range widgets whose numeric value doesn't map
  // cleanly to speech ("Half complete", "About five minutes remaining"). Same policy as
  // `aria-label` — the AST scan MUST see it or new accessible copy bypasses the ledger.
  "aria-valuetext",
  // Codex 3793874125 on #3202: `aria-roledescription` is the author-supplied role text
  // assistive tech announces in place of the intrinsic role (`<section
  // aria-roledescription="Slide deck">` → "Slide deck" instead of "region"). Human-readable
  // by definition; same policy as `aria-label`.
  "aria-roledescription",
  "alt",
  "placeholder",
  "title",
  "data-tip",
  // camelCase (React props on custom components — matches LABEL_FIELD_NAME_RE, extended with
  // the ARIA-mirroring props components spell in camelCase).
  "ariaLabel",
  "ariaDescription",
  "ariaPlaceholder",
  "ariaValueText",
  "ariaRoleDescription",
  "label",
  "labelText",
  "description",
  "desc",
  "cta",
  "scope",
  "group",
  "menuTitle",
  "tip",
  "hint",
  "summary",
]);

function jsxAttributeName(attribute) {
  const name = attribute.name;
  if (name === undefined) return null;
  if (ts.isIdentifier(name)) return name.text;
  // JsxNamespacedName covers `xml:lang="…"`; we don't scan those.
  return null;
}

// `.ts`/`.mts`/`.cts` are parsed as TypeScript so that generic syntax (`<T>`, `ReadonlySet<...>`)
// is not misread as JSX. Everything else — including the no-filename call path used by the tests —
// falls back to TSX so an unknown extension does not silently drop JSX text on the floor. The
// production call site (`literalScanForFile`) always passes a real repo-relative path, so the
// no-filename branch is only exercised by direct unit-test callers using ad-hoc JSX fragments.
function scriptKindForFile(filename) {
  if (typeof filename !== "string") return ts.ScriptKind.TSX;
  if (/\.(ts|mts|cts)$/.test(filename)) return ts.ScriptKind.TS;
  return ts.ScriptKind.TSX;
}

function jsxTextResult(node, sourceFile) {
  const text = node.text;
  if (text.trim().length === 0) return null;
  const line = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile)).line + 1;
  return { line, text: text.trim() };
}

// Codex 3793229704: `<p>open <code>settings</code></p>` splits the phrase "open settings" into
// two `JsxText` fragments the classifier sees independently. Each fragment is one lowercase
// token, which `isTranslatableCopy` treats as a machine token and drops — the aggregate phrase
// never enters the ledger, letting newly added copy bypass the gate whenever a designer wraps a
// word in `<code>`/`<em>`/`<strong>`/etc. Aggregate JsxText that appear directly under a
// container OR under one of these text-level inline formatting elements, so the classifier can
// see the phrase the reader actually sees. Emit only when (a) the container spans multiple
// fragments and (b) no individual fragment already tripped the classifier — that keeps the
// baseline ledger stable for the shapes the per-fragment path already caught.
//
// The set follows the HTML spec's "phrasing content" that renders inline text without semantic
// structure; block-level elements (`<p>`, `<div>`, `<li>`, …) and interactive elements
// (`<a>`, `<button>`) terminate the aggregate because their contents form a separate phrase.
const INLINE_TEXT_FORMATTING_ELEMENTS = new Set([
  "span",
  "code",
  "em",
  "strong",
  "b",
  "i",
  "u",
  "small",
  "mark",
  "sub",
  "sup",
  "ins",
  "del",
  "kbd",
  "var",
  "cite",
  "abbr",
  "dfn",
  "samp",
  "s",
  "q",
  "bdo",
  "bdi",
  "time",
]);

function isInlineTextFormattingChild(child) {
  // Codex 3793830385 on #3202: JsxFragment (`<>...</>`) is a purely syntactic grouping — the
  // reader sees a contiguous phrase and any exemption logic works the same as inline text-
  // level formatting elements. Flatten fragments here so `<p>open <>settings</></p>` yields
  // "open settings" as one aggregate instead of two rejected lowercase tokens.
  if (ts.isJsxFragment(child)) return true;
  if (!ts.isJsxElement(child)) return false;
  const tagName = child.openingElement.tagName;
  if (!ts.isIdentifier(tagName)) return false;
  return INLINE_TEXT_FORMATTING_ELEMENTS.has(tagName.text);
}

// Split the container's children into consecutive "phrase segments". A boundary is anything that
// interrupts the rendered text stream: a non-inline element (block container / custom
// component), a non-literal expression brace (`{maybeVar}` — runtime value unknown), or any
// other non-textual child. Each returned segment carries adjacent text-like parts that DO
// render together AND the source line of its first contributing part (codex 3793398796): the
// aggregate finding is attributed to that line, not to the container's opening tag, so an
// `// i18n-exempt` marker adjacent to the phrase's own text can exempt it.
function collectAggregatedJsxTextSegments(container, sourceFile) {
  const collector = createSegmentCollector();
  for (const child of container.children) {
    absorbChildIntoSegments(child, sourceFile, collector);
  }
  return collector.finalize();
}

// Codex 3793772901 on #3202: a conditional literal like `<p>open {cond ? "settings" :
// "account"}</p>` renders as EITHER "open settings" OR "open account". The aggregator must
// emit BOTH aggregates so the ledger records every phrase the reader could see. The collector
// supports forking on encountering a conditional literal: from that point onwards the ACTIVE
// segments split into N copies (one per alternative). Subsequent parts append to all active
// copies. `startNewSegment` finalises whichever segments have content and resets to one fresh
// active segment. `finalize` finalises whatever is still active.
function createSegmentCollector() {
  const finalized = [];
  let active = [{ parts: [], firstLine: null }];
  return {
    appendPart(text, line) {
      for (const segment of active) {
        segment.parts.push(text);
        // Codex 3793398796 + 3793642835 on #3202: attribute the aggregate to the first
        // CONTENT line, not a leading whitespace-only fragment. Skip the update for
        // whitespace-only parts (`\n  ` between `<p>` and its first content).
        if (segment.firstLine === null && text.trim().length > 0) segment.firstLine = line;
      }
    },
    startNewSegment() {
      for (const segment of active) if (segment.parts.length > 0) finalized.push(segment);
      active = [{ parts: [], firstLine: null }];
    },
    forkAlternatives(alternatives, line) {
      const next = [];
      for (const segment of active) {
        for (const alternative of alternatives) {
          const clone = { parts: [...segment.parts, alternative], firstLine: segment.firstLine };
          if (clone.firstLine === null && alternative.trim().length > 0) clone.firstLine = line;
          next.push(clone);
        }
      }
      active = next;
    },
    finalize() {
      for (const segment of active) if (segment.parts.length > 0) finalized.push(segment);
      return finalized;
    },
  };
}

function absorbChildIntoSegments(child, sourceFile, collector) {
  if (ts.isJsxText(child)) {
    // Codex 3793642835 on #3202: keep the RAW JsxText so adjacency information reaches the
    // join. `<code>memoria.settings.{"mode"}</code>` — the JsxText `memoria.settings.` has no
    // trailing whitespace, so joining with the following `{"mode"}` literal must NOT insert a
    // space. Whitespace-only JsxText between inline elements (`<em>is</em> <strong>a</strong>`)
    // IS the space that separates the phrase words, so it must survive too — only empty
    // JsxText (zero raw chars) is skipped. Normalisation (trim+collapse) happens once at the
    // final aggregate.
    if (child.text.length === 0) return;
    collector.appendPart(child.text, lineOfNode(child, sourceFile));
    return;
  }
  // Codex 3793356672 on #3202: line-break phrasing elements (`<br/>`, `<wbr/>`) split copy at
  // whitespace boundaries — `<p>open<br/>settings</p>` renders "open settings". After the raw-
  // adjacency refactor (codex 3793642835) the join no longer inserts a space between parts, so
  // `br`/`wbr` must APPEND an explicit space to preserve the boundary the reader sees.
  if (isLineBreakPhrasingChild(child)) {
    collector.appendPart(" ", lineOfNode(child, sourceFile));
    return;
  }
  if (isInlineTextFormattingChild(child)) {
    // Inline formatting elements render adjacent to surrounding text; flatten their segments
    // into the parent's current segment. A boundary INSIDE the inline element (rare) still
    // breaks the parent aggregate. Preserve each inner part's firstLine so exemption markers
    // adjacent to the inline element's own text still apply to the aggregate.
    const inner = collectAggregatedJsxTextSegments(child, sourceFile);
    for (let i = 0; i < inner.length; i += 1) {
      for (const part of inner[i].parts) {
        collector.appendPart(part, inner[i].firstLine ?? lineOfNode(child, sourceFile));
      }
      if (i < inner.length - 1) collector.startNewSegment();
    }
    return;
  }
  if (ts.isJsxExpression(child)) {
    absorbJsxExpressionIntoSegments(child, sourceFile, collector);
    return;
  }
  // Non-inline element (block container, custom component) or any other kind of child.
  collector.startNewSegment();
}

const LINE_BREAK_PHRASING_ELEMENTS = new Set(["br", "wbr"]);

function isLineBreakPhrasingChild(child) {
  let tagName;
  if (ts.isJsxSelfClosingElement(child)) {
    tagName = child.tagName;
  } else if (ts.isJsxElement(child)) {
    tagName = child.openingElement.tagName;
  } else {
    return false;
  }
  return ts.isIdentifier(tagName) && LINE_BREAK_PHRASING_ELEMENTS.has(tagName.text);
}

// Codex 3793282537 on #3202: `<p>open {"settings"}</p>` renders the literal inside the
// expression brace as part of the containing phrase; the reader sees "open settings". Only
// DIRECT string literals participate — non-literal expressions (`{maybeVar}`,
// `{cond ? "a" : "b"}`) have runtime-unknowable values, so including them would fabricate a
// phrase that never actually renders; those get their own individual entries via the
// JsxExpression visitor path. A non-literal expression BREAKS the aggregate so we don't weld
// "open" and "settings" across `{maybe}`.
function absorbJsxExpressionIntoSegments(node, sourceFile, collector) {
  const expression = node.expression;
  if (expression === undefined) return;
  // Codex 3793744727 on #3202: `<p>open {"settings" as const}</p>` — the expression is a
  // transparent wrapper (`as` / `satisfies` / parens / `!` / `await`) around a StringLiteral.
  // Unwrap before deciding whether the expression participates in the containing phrase;
  // without this, the direct-node check would break the segment and lose the aggregate
  // (`open settings`) that the reader actually sees.
  const inner = unwrapTransparent(expression);
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) {
    // Codex 3793642835 on #3202: keep the literal RAW (no trim/collapse here). The final
    // aggregate normaliser handles whitespace; splitting up front loses adjacency information
    // with the surrounding JsxText siblings.
    if (inner.text.length > 0) collector.appendPart(inner.text, lineOfNode(inner, sourceFile));
    return;
  }
  if (tryForkConditionalAggregate(inner, sourceFile, collector)) return;
  if (tryForkLogicalAggregate(inner, sourceFile, collector)) return;
  collector.startNewSegment();
}

// Codex 3793772901 on #3202: `<p>open {cond ? "settings" : "account"}</p>` renders as EITHER
// "open settings" OR "open account". Fork the active segments so both aggregates land in the
// ledger. Only handled when BOTH branches unwrap to literals; partial-literal shapes
// (`cond ? "x" : maybeVar`) fall through — one runtime branch has an unknown value and
// fabricating a phrase across it would be wrong.
function tryForkConditionalAggregate(inner, sourceFile, collector) {
  if (!ts.isConditionalExpression(inner)) return false;
  const trueText = literalTextOfExpression(inner.whenTrue);
  const falseText = literalTextOfExpression(inner.whenFalse);
  if (trueText === null || falseText === null) return false;
  collector.forkAlternatives([trueText, falseText], lineOfNode(inner, sourceFile));
  return true;
}

// Codex 3793830382 on #3202: `<p>open {cond && "settings"}</p>` renders EITHER "open
// settings" (cond truthy) OR "open" (cond falsy — React drops the falsy value). Same for
// `??` (renders literal on null/undefined left) and `||` (renders literal on falsy left).
// Fork with `[literalText, ""]`: the literal alternative surfaces "open settings" as an
// aggregate; the empty alternative degrades to a single-content-part segment the ≥2 gate
// skips.
function tryForkLogicalAggregate(inner, sourceFile, collector) {
  if (!ts.isBinaryExpression(inner)) return false;
  if (!rightSideLiteralLogicalOps.has(inner.operatorToken.kind)) return false;
  const rightText = literalTextOfExpression(inner.right);
  if (rightText === null) return false;
  collector.forkAlternatives([rightText, ""], lineOfNode(inner, sourceFile));
  return true;
}

const rightSideLiteralLogicalOps = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

function literalTextOfExpression(expr) {
  const inner = unwrapTransparent(expr);
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text;
  return null;
}

function jsxAggregatedTextResults(node, sourceFile) {
  // Coderabbit 3793329579 on #3202: `<p><span>open <code>settings</code></span></p>` — the
  // visitor runs jsxAggregatedTextResults at BOTH `<p>` and `<span>`, and `absorbChild…`
  // flattens the inner `<span>`'s parts into the parent. Both emit "open settings" — the
  // ledger double-counts. Emit only from the OUTERMOST eligible container: if this node is an
  // inline formatting element whose parent is itself a JsxElement or JsxFragment, the parent
  // will absorb our segments and emit — skip here to avoid the duplicate.
  if (isInlineFormattingChildOfContainer(node)) return [];
  const containerLine =
    ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile)).line + 1;
  const emitted = [];
  for (const segment of collectAggregatedJsxTextSegments(node, sourceFile)) {
    // Codex 3793642835 on #3202: parts arrive RAW so their in-source adjacency is preserved.
    // Whitespace-only parts (JsxText between inline elements, injected `<br/>` boundary) count
    // as separators, not phrase fragments — filter them out of the ≥2 content-parts check
    // (single-fragment cases still stay non-emitting).
    const contentParts = segment.parts.filter((part) => part.trim().length > 0);
    if (contentParts.length < 2) continue;
    // Concatenate without a separator, then trim+collapse once — this way `memoria.settings.`
    // + `mode` yields `memoria.settings.mode` (adjacent) while `Hello ` + `World` yields
    // `Hello World` (the space came from the first part's trailing whitespace, not an injected
    // separator).
    const aggregate = segment.parts.join("").trim().replace(/\s+/gu, " ");
    if (aggregate.length === 0) continue;
    if (!isTranslatableCopy(aggregate)) continue;
    // Codex 3793469157 on #3202: dedupe against IDENTICAL individually-translatable parts, but
    // do NOT suppress the aggregate merely because SOME part is independently translatable —
    // otherwise appending untranslated copy (`<p>Open settings <code>now</code></p>`) would
    // silently pass. Compare normalised part text to the normalised aggregate.
    const normalisedParts = contentParts.map((part) => part.trim().replace(/\s+/gu, " "));
    if (normalisedParts.includes(aggregate)) continue;
    // Codex 3793398796 on #3202: attribute the finding to the first text fragment's line, not
    // the container's opening tag — so an `// i18n-exempt` marker adjacent to the phrase's
    // own text can exempt it. Fall back to the container line only if the segment somehow
    // recorded no source line (defensive; should not happen for a non-empty parts list).
    emitted.push({ line: segment.firstLine ?? containerLine, text: aggregate });
  }
  return emitted;
}

function isInlineFormattingChildOfContainer(node) {
  if (!isInlineTextFormattingChild(node)) return false;
  const parent = node.parent;
  return parent !== undefined && (ts.isJsxElement(parent) || ts.isJsxFragment(parent));
}

function jsxChildExpressionResults(node, sourceFile) {
  if (!node.expression || !isJsxExpressionChildOfElement(node)) return [];
  return jsxChildExpressionLiteralTexts(node.expression, sourceFile).filter(
    (entry) => entry.text.length > 0,
  );
}

function jsxAttributeExpressionResults(node, sourceFile) {
  const name = jsxAttributeName(node);
  if (name === null || !USER_FACING_ATTRIBUTE_NAMES.has(name)) return [];
  const initializer = node.initializer;
  if (initializer === undefined) return [];
  // Directly quoted camelCase prop (`<KeikoSelect ariaLabel="Relationship type" />`): the
  // initializer is a `StringLiteral`, NOT a `JsxExpression`. The per-line attribute pass only
  // recognises kebab-case attributes before `=`, and `LABEL_FIELD_NAME_RE` expects `:` (object
  // literal syntax), so this shape was invisible to both scanners before this branch landed
  // (codex 3792941801 on #3202). Real cases: `RelationshipCreateDialog.tsx`,
  // `VoiceDialogMode.tsx`.
  if (ts.isStringLiteral(initializer)) {
    const text = initializer.text.trim();
    if (text.length === 0) return [];
    return [{ line: lineOfNode(initializer, sourceFile), text }];
  }
  // Expression-valued: `ariaLabel={cond ? "a" : "b"}`. Reuse the JSX-child recursion so all the
  // conditional/template/logical shapes work the same way in attribute values as in children.
  if (ts.isJsxExpression(initializer) && initializer.expression !== undefined) {
    return jsxChildExpressionLiteralTexts(initializer.expression, sourceFile).filter(
      (entry) => entry.text.length > 0,
    );
  }
  return [];
}

// KEIKO-0299 (review-follow-up on 23447289, codex 3793028208): a JSX spread attribute
// `<button {...{ "aria-label": "Delete account" }} />` reaches the element as a
// `JsxSpreadAttribute` node — the visitor never called `jsxAttributeExpressionResults` on it,
// and the per-line fallback doesn't recognise the quoted-key colon syntax inside an object
// literal. When the spread's expression is an inline object literal, inspect its properties
// against the same user-facing name set so a spread rendering an accessible label enters the
// ledger. Non-inline spreads (`<button {...restProps} />`) stay ignored.
function jsxSpreadAttributeResults(node, sourceFile) {
  // Codex 3793436213 + 3793501037 on #3202: the spread expression may be wrapped by transparent
  // TypeScript (`{...(obj as const)}`) or composed with `?:` / `&&` / `||` / `??`
  // (`{...(danger ? { "aria-label": "…" } : {})}`). Collect every inline ObjectLiteralExpression
  // reachable through those shapes and scan each — otherwise newly-added accessible copy in the
  // wrapped / conditional form would silently bypass the ledger.
  const results = [];
  for (const objectExpression of collectSpreadObjectLiterals(node.expression)) {
    results.push(...jsxSpreadObjectLiteralResults(objectExpression, sourceFile));
  }
  return results;
}

function jsxSpreadObjectLiteralResults(objectExpression, sourceFile) {
  const results = [];
  for (const prop of objectExpression.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const key = objectPropertyKey(prop.name);
      if (key === null || !USER_FACING_ATTRIBUTE_NAMES.has(key)) continue;
      for (const entry of jsxChildExpressionLiteralTexts(prop.initializer, sourceFile)) {
        if (entry.text.length > 0) results.push(entry);
      }
      continue;
    }
    // Codex 3793642840 on #3202: nested spread inside a spread object — `<button {...{ ...{
    // "aria-label": "Delete account" }} } />`. The outer object is collected, but the
    // SpreadAssignment used to be skipped, so accessible copy in the inner object never
    // reached the ledger. Recurse through the spread expression using the same object-literal
    // collector that handles the outer spread (`?:`/`&&`/`||`/`??`/transparent-wrapper).
    if (ts.isSpreadAssignment(prop)) {
      for (const nested of collectSpreadObjectLiterals(prop.expression)) {
        results.push(...jsxSpreadObjectLiteralResults(nested, sourceFile));
      }
    }
  }
  return results;
}

// Walk through transparent wrappers, conditional (`?:`) branches, and short-circuit binary
// operators (`&&`, `||`, `??`) to gather every inline ObjectLiteralExpression that could reach
// the spread at runtime. Codex 3793501037 on #3202: this is the analogue of `binaryFallback…`
// for spreads, so the same "either operand could be picked" logic applies. Non-object leaves
// (identifiers, calls, `{}` empty literal, etc.) contribute nothing.
function collectSpreadObjectLiterals(expr) {
  const unwrapped = unwrapTransparent(expr);
  if (ts.isObjectLiteralExpression(unwrapped)) return [unwrapped];
  if (ts.isConditionalExpression(unwrapped)) {
    return [
      ...collectSpreadObjectLiterals(unwrapped.whenTrue),
      ...collectSpreadObjectLiterals(unwrapped.whenFalse),
    ];
  }
  if (ts.isBinaryExpression(unwrapped)) {
    const kind = unwrapped.operatorToken.kind;
    if (
      kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      kind === ts.SyntaxKind.BarBarToken ||
      kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return [
        ...collectSpreadObjectLiterals(unwrapped.left),
        ...collectSpreadObjectLiterals(unwrapped.right),
      ];
    }
  }
  return [];
}

function objectPropertyKey(name) {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  // Codex 3793469155 on #3202: `{ ["aria-label"]: "..." }` uses a ComputedPropertyName wrapping
  // the actual key expression. When the inner expression is a compile-time constant string, the
  // rendered attribute name is that string — same policy as the quoted-key form above. Only
  // string-literal constants participate; complex computed keys (e.g. `[Symbol.for(x)]`) stay
  // unrecognised and their values remain unscanned (same policy as element-access argument).
  if (ts.isComputedPropertyName(name)) {
    const inner = name.expression;
    if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text;
  }
  return null;
}

function collectJsxTextAndExpressions(source, filename) {
  const kind = scriptKindForFile(filename);
  const syntheticExtension = kind === ts.ScriptKind.TSX ? "tsx" : "ts";
  const sourceName = typeof filename === "string" ? filename : `<ui-i18n>.${syntheticExtension}`;
  const sourceFile = ts.createSourceFile(sourceName, source, ts.ScriptTarget.Latest, true, kind);
  // Coderabbit outside-diff on #3202: `ts.createSourceFile` recovers from malformed input and
  // returns a PARTIAL AST — the JSX visitor then only sees a subset of nodes and the gate can
  // silently pass on a syntactically broken file. Fail-closed on any parse diagnostic when
  // scanning a REAL file (production `literalScanForFile` call site always passes `filename`).
  // Test fragments that pass raw JSX snippets without a filename still get graceful degradation
  // (top-level JSX like `<span>x</span>` reports `parseDiagnostics` even though the fragment is
  // meaningful to the AST visitor); the fragment path is unit-test-only and cannot ship code.
  if (typeof filename === "string" && sourceFile.parseDiagnostics.length > 0) {
    throw new Error(
      `Cannot scan ${sourceName}: TypeScript reported ${String(sourceFile.parseDiagnostics.length)} parse diagnostic(s). ` +
        "The AST is incomplete and the i18n scan would only see a subset of nodes; fix the syntax error and re-run.",
    );
  }
  const results = [];
  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const result = jsxTextResult(node, sourceFile);
      if (result !== null) results.push(result);
    } else if (ts.isJsxExpression(node)) {
      results.push(...jsxChildExpressionResults(node, sourceFile));
    } else if (ts.isJsxAttribute(node)) {
      results.push(...jsxAttributeExpressionResults(node, sourceFile));
    } else if (ts.isJsxSpreadAttribute(node)) {
      results.push(...jsxSpreadAttributeResults(node, sourceFile));
    } else if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      results.push(...jsxAggregatedTextResults(node, sourceFile));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return results;
}

// KEIKO-0299 (review-follow-up): a template expression `` `Hello ${name}, welcome` `` used as a
// JSX child slips past both the string-literal path (it is neither a StringLiteral nor a
// NoSubstitutionTemplateLiteral) and the per-line fallback (the braces reject it). Extract the
// literal spans here so newly added user copy in that shape does not go unmeasured. Templates
// made only of interpolations produce an empty combined string and are ignored.
//
// A ConditionalExpression (`{cond ? "Indexing…" : "Index"}`) is the other common JSX-child shape
// (codex 3792824431 on #3202): both branches are user-visible bytes, one at a time, and the
// ledger records exact strings — so we emit each branch as its own entry rather than joining
// them. Recursion covers nested conditionals and templates inside branches.
//
// Each returned entry carries its OWN line (coderabbit 3792888549 on #3202): a multi-line
// conditional like `{\n  cond\n  ? "First"\n  : "Second"\n}` reports "First" on its own line and
// "Second" on its own line, not both on the conditional's opening-brace line. Otherwise the
// exemption marker on one branch would silently apply to the other, and the ledger diff would
// point reviewers at the wrong source location.
function jsxChildExpressionLiteralTexts(expr, sourceFile) {
  const stringLike = stringLikeExpressionTexts(expr, sourceFile);
  if (stringLike !== null) return stringLike;
  const compound = compoundExpressionTexts(expr, sourceFile);
  return compound === null ? [] : compound;
}

// Compound expression shapes (extracted for complexity ceiling). Returns null when `expr` is
// not one of these shapes, so the caller falls through to the empty default. Split into two
// helpers so no single function exceeds the complexity ceiling: control-flow shapes here,
// container/receiver/function shapes in `containerExpressionTexts`.
function compoundExpressionTexts(expr, sourceFile) {
  if (ts.isConditionalExpression(expr)) {
    return [
      ...jsxChildExpressionLiteralTexts(expr.whenTrue, sourceFile),
      ...jsxChildExpressionLiteralTexts(expr.whenFalse, sourceFile),
    ];
  }
  if (ts.isBinaryExpression(expr) && isRenderingFallbackOperator(expr.operatorToken.kind)) {
    return binaryFallbackLiteralTexts(expr, sourceFile);
  }
  if (isTransparentWrapper(expr)) {
    return jsxChildExpressionLiteralTexts(expr.expression, sourceFile);
  }
  return containerExpressionTexts(expr, sourceFile);
}

// Container-like shapes: calls, accessors, functions, arrays, tagged templates. Each returns
// the literals that live in its child positions; the surrounding rules for user copy still apply
// via the recursive helper. Returns null when `expr` matches none of these shapes.
function containerExpressionTexts(expr, sourceFile) {
  // CallExpression: a helper like `definedOr(x, "this file")` returns its literal argument
  // verbatim (codex 3792986615). Traverse each argument via the same helper. Codex 3793229700:
  // ALSO traverse the receiver chain — `{["Delete account"].map(l => <span>{l}</span>)}` renders
  // the array elements as JSX children (the callback returns each element wrapped in a `<span>`);
  // the literal lives in the receiver `["Delete account"]`, not in `.map`'s arguments. The
  // recursion falls through PropertyAccessExpression / ElementAccessExpression handled below.
  if (ts.isCallExpression(expr)) {
    return [
      ...expr.arguments.flatMap((arg) => jsxChildExpressionLiteralTexts(arg, sourceFile)),
      ...jsxChildExpressionLiteralTexts(expr.expression, sourceFile),
    ];
  }
  // PropertyAccessExpression / ElementAccessExpression: pass-through to `.expression` (the LHS).
  // `["Delete account"].map` and `["Delete account"]["map"]` both put the literal on the LHS of
  // the accessor, so recursing there surfaces the ArrayLiteralExpression handled below. Codex
  // 3793229700. Element-access argument (`obj["some key"]`) is a code key, not user copy, so it
  // is intentionally not traversed.
  if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
    return jsxChildExpressionLiteralTexts(expr.expression, sourceFile);
  }
  // ArrowFunction / FunctionExpression: `{items.map(() => "Delete account")}` — the body IS
  // user copy that gets rendered per item (codex 3793101250).
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
    return functionLikeLiteralTexts(expr, sourceFile);
  }
  // ArrayLiteralExpression: `<p>{["Delete account", "Cancel operation"]}</p>` — React renders
  // each element. Codex 3793145626. Recurse through each element (same policy as call
  // arguments and conditional branches). Codex 3793795566 on #3202: ALSO emit the concatenated
  // form when every element is a string literal — `<p>{["open ", "settings"]}</p>` renders
  // "open settings" but per-element emission alone drops both fragments as machine tokens.
  // The combined form joins raw texts (adjacency preserved) then trims+collapses; if it's
  // translatable, add ONE aggregate on top of the per-element entries. Dynamic elements
  // disable the aggregate (only per-element emission runs).
  if (ts.isArrayLiteralExpression(expr)) {
    return arrayLiteralLiteralTexts(expr, sourceFile);
  }
  // ObjectLiteralExpression: `{({ idle: "Open settings", done: "Close settings" })[state]}` —
  // an inline object map whose values are user copy the receiver traversal reaches through
  // element-access. Codex 3793356675. Recurse through each property VALUE (keys are code, not
  // rendered copy — analogous to the element-access argument policy).
  if (ts.isObjectLiteralExpression(expr)) {
    return objectLiteralPropertyLiteralTexts(expr, sourceFile);
  }
  // TaggedTemplateExpression: ``<p>{String.raw`Delete account`}</p>`` — a tag like
  // `String.raw` returns the template literal verbatim, so the rendered text is the template
  // body. Codex 3793198455. Traverse `.template` (which is a NoSubstitutionTemplateLiteral or
  // TemplateExpression, both handled by `stringLikeExpressionTexts`). This over-approximates
  // for tags that transform the template (e.g. a stripping tag), but the ledger's
  // `// i18n-exempt` escape hatch handles false positives — a false negative on a live user
  // string would be worse.
  if (ts.isTaggedTemplateExpression(expr)) {
    return jsxChildExpressionLiteralTexts(expr.template, sourceFile);
  }
  return null;
}

// Transparent expression wrappers (codex 3793028199): these AST shapes wrap an inner
// expression WITHOUT affecting its runtime value, so a literal wrapped in any of them still
// renders as user copy.
//   ParenthesizedExpression: `(...)`
//   AsExpression:            `x as T`
//   SatisfiesExpression:     `x satisfies T`
//   NonNullExpression:       `x!`
//   AwaitExpression:         `await x`   (codex 3793642864 on #3202 — the resolved value IS
//                                          rendered; `<p>{await Promise.resolve("…")}</p>`.)
function isTransparentWrapper(expr) {
  return (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isNonNullExpression(expr) ||
    ts.isAwaitExpression(expr)
  );
}

// Codex 3793642869 on #3202: every nested function-like scope terminates the return walk. The
// earlier list only covered plain function forms, so a callback like
// `items.map(() => { const helper = { label() { return "Internal diagnostic"; } }; return null; })`
// descended into the object-method `label()` and reported ITS return as rendered copy — a
// false ledger failure. Method declarations, accessors, and the constructor all define new
// scopes whose returns belong to those scopes, not the enclosing callback.
function isNestedFunctionScope(node) {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function arrayLiteralLiteralTexts(expr, sourceFile) {
  const perElement = expr.elements.flatMap((element) =>
    jsxChildExpressionLiteralTexts(element, sourceFile),
  );
  const rawElementTexts = [];
  let allLiteral = true;
  for (const element of expr.elements) {
    const raw = literalTextOfExpression(element);
    if (raw === null) {
      allLiteral = false;
      break;
    }
    rawElementTexts.push(raw);
  }
  if (!allLiteral || rawElementTexts.length < 2) return perElement;
  const combined = rawElementTexts.join("").trim().replace(/\s+/gu, " ");
  if (combined.length === 0) return perElement;
  // Only add the aggregate when it introduces new signal — i.e. when no per-element already
  // matches (same anti-double-count as the JsxText / `+`-chain aggregators).
  if (perElement.some((entry) => entry.text === combined)) return perElement;
  return [...perElement, { line: lineOfNode(expr, sourceFile), text: combined }];
}

function objectLiteralPropertyLiteralTexts(expr, sourceFile) {
  const results = [];
  for (const prop of expr.properties) {
    if (ts.isPropertyAssignment(prop)) {
      results.push(...jsxChildExpressionLiteralTexts(prop.initializer, sourceFile));
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      results.push(...jsxChildExpressionLiteralTexts(prop.name, sourceFile));
    } else if (ts.isSpreadAssignment(prop)) {
      results.push(...jsxChildExpressionLiteralTexts(prop.expression, sourceFile));
    }
  }
  return results;
}

function functionLikeLiteralTexts(expr, sourceFile) {
  const body = expr.body;
  if (body === undefined) return [];
  if (!ts.isBlock(body)) return jsxChildExpressionLiteralTexts(body, sourceFile);
  const returns = [];
  const walk = (node) => {
    if (ts.isReturnStatement(node)) {
      if (node.expression) {
        returns.push(...jsxChildExpressionLiteralTexts(node.expression, sourceFile));
      }
      return;
    }
    if (isNestedFunctionScope(node)) {
      // Do not recurse into nested function scopes — their returns belong to those scopes.
      return;
    }
    ts.forEachChild(node, walk);
  };
  walk(body);
  return returns;
}

function lineOfNode(node, sourceFile) {
  return ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile)).line + 1;
}

// String-shaped expressions (StringLiteral / NoSubstitutionTemplateLiteral / TemplateExpression)
// extracted so the outer dispatcher stays under the complexity ceiling. Returns null when the
// expression is not one of these shapes, so the caller can try other branches.
function stringLikeExpressionTexts(expr, sourceFile) {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    const text = expr.text.trim();
    return text.length > 0 ? [{ line: lineOfNode(expr, sourceFile), text }] : [];
  }
  if (ts.isTemplateExpression(expr)) return templateExpressionLiteralTexts(expr, sourceFile);
  return null;
}

function templateExpressionLiteralTexts(expr, sourceFile) {
  // Head + trailing spans are the template's LITERAL parts. Codex 3793145631: joining spans
  // with a separator character INSERTED bytes that don't exist in the runtime value —
  // `` `memoria.settings.mode.${x}Error` `` was becoming `"memoria.settings.mode. Error"` and
  // `isTranslatableCopy` treated the injected space as word boundaries, flagging dotted keys
  // as prose. Concatenate spans DIRECTLY so an interpolated key/path stays a machine token.
  // Whitespace inside the LITERAL spans (`Hello ` + ` World`) still collapses via the
  // trim + `\s+` normalisation below, so real prose stays prose.
  const parts = [expr.head.text, ...expr.templateSpans.map((span) => span.literal.text)];
  const combined = parts.join("").trim().replace(/\s+/gu, " ");
  const templateEntry =
    combined.length > 0 ? [{ line: lineOfNode(expr, sourceFile), text: combined }] : [];
  // Each `${…}` substitution can itself contain literals — a common case is
  // `` `${expanded ? "Collapse" : "Expand"} ${project.name}` ``. Codex 3792964062.
  const substitutionEntries = expr.templateSpans.flatMap((span) =>
    jsxChildExpressionLiteralTexts(span.expression, sourceFile),
  );
  return [...templateEntry, ...substitutionEntries];
}

// KEIKO-0299 (review-follow-up on a0ee79ae): `??` and `||` in JSX children can render EITHER
// operand as user-visible copy (`?? / ||` return the first defined/truthy value), so both sides
// count as candidate literals. `&&` short-circuits: the LEFT operand only controls evaluation
// and is never rendered, so a literal on the left (`{"Feature enabled" && value}`) is code, not
// copy, and MUST NOT enter the ledger — otherwise a false ledger entry or unnecessary
// exemption is required. Coderabbit 3792888551.
//
// `+` follows a THIRD pattern (codex 3792890969 on #3202): a JSX child like `{"Welcome back, " +
// name}` renders the concatenation as user copy, so a literal on either operand IS user-visible
// and must enter the ledger. Same behaviour as `??` / `||` here — both operands get traversed;
// the recursion filters non-literal operands to empty results naturally.
function binaryFallbackLiteralTexts(expr, sourceFile) {
  if (expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return jsxChildExpressionLiteralTexts(expr.right, sourceFile);
  }
  // Codex 3793578608 on #3202: `(track(), "Delete account")` — the comma operator evaluates
  // BOTH operands but the RIGHT one's value is what the enclosing expression sees. Recurse
  // into the right operand only; the left is discarded at runtime and any literal there is a
  // side-effect argument, not rendered copy.
  if (expr.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return jsxChildExpressionLiteralTexts(expr.right, sourceFile);
  }
  // Codex 3793356682 on #3202: `{"open " + "settings"}` renders "open settings" but the
  // operand-only recursion emitted two lowercase tokens the classifier dropped. When BOTH sides
  // of a `+` are directly literal (or nested literal `+` chains), fold them into the whole
  // rendered phrase and classify that first so the aggregate enters the ledger.
  //
  // Codex 3793398793 on #3202: `{"open " + section + " settings"}` — one dynamic operand made
  // the fold above return null, and per-operand emission left each fragment as a machine
  // token the classifier drops. Also aggregate the LITERAL fragments alone (skipping dynamic
  // operands) — the reader still sees the literal frame around the interpolation. Emit that
  // aggregate on top of per-operand entries only when it would be translatable AND no
  // individual operand is; same anti-double-count policy as the JsxText aggregator.
  if (expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return plusChainLiteralTexts(expr, sourceFile);
  }
  return [
    ...jsxChildExpressionLiteralTexts(expr.left, sourceFile),
    ...jsxChildExpressionLiteralTexts(expr.right, sourceFile),
  ];
}

function plusChainLiteralTexts(expr, sourceFile) {
  const combined = combinedLiteralPlusChain(expr);
  if (combined !== null) return [{ line: lineOfNode(expr, sourceFile), text: combined }];
  const perOperand = [
    ...jsxChildExpressionLiteralTexts(expr.left, sourceFile),
    ...jsxChildExpressionLiteralTexts(expr.right, sourceFile),
  ];
  const literalOnly = combinedLiteralFragmentsOnly(expr);
  if (literalOnly === null) return perOperand;
  if (!isTranslatableCopy(literalOnly)) return perOperand;
  if (perOperand.some((entry) => isTranslatableCopy(entry.text))) return perOperand;
  return [...perOperand, { line: lineOfNode(expr, sourceFile), text: literalOnly }];
}

// Concatenate every literal operand across a `+` chain, silently skipping dynamic ones. Returns
// null when the chain contains no literal at all. The result is trimmed and inner whitespace
// runs are collapsed, matching the JsxText aggregation policy.
function combinedLiteralFragmentsOnly(expr) {
  const parts = [];
  collectPlusLiteralFragmentsOnly(expr, parts);
  if (parts.length === 0) return null;
  const joined = parts.join("").trim().replace(/\s+/gu, " ");
  return joined.length > 0 ? joined : null;
}

function collectPlusLiteralFragmentsOnly(node, parts) {
  const unwrapped = unwrapTransparent(node);
  if (
    ts.isBinaryExpression(unwrapped) &&
    unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    collectPlusLiteralFragmentsOnly(unwrapped.left, parts);
    collectPlusLiteralFragmentsOnly(unwrapped.right, parts);
    return;
  }
  if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
    parts.push(unwrapped.text);
  }
}

// Return the concatenated text if EVERY operand in a `+` chain is a direct string literal (or a
// parenthesised / `as`-wrapped one). Returns null if any operand is dynamic — the caller then
// emits per-operand as before, which is still correct for literal-plus-variable shapes.
function combinedLiteralPlusChain(expr) {
  const parts = [];
  if (!collectLiteralPlusOperands(expr, parts)) return null;
  const joined = parts.join("").trim().replace(/\s+/gu, " ");
  return joined.length > 0 ? joined : null;
}

function collectLiteralPlusOperands(node, parts) {
  const unwrapped = unwrapTransparent(node);
  if (
    ts.isBinaryExpression(unwrapped) &&
    unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    return (
      collectLiteralPlusOperands(unwrapped.left, parts) &&
      collectLiteralPlusOperands(unwrapped.right, parts)
    );
  }
  if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
    parts.push(unwrapped.text);
    return true;
  }
  return false;
}

function unwrapTransparent(node) {
  let current = node;
  while (isTransparentWrapper(current)) current = current.expression;
  return current;
}

function isRenderingFallbackOperator(kind) {
  return (
    kind === ts.SyntaxKind.QuestionQuestionToken ||
    kind === ts.SyntaxKind.BarBarToken ||
    kind === ts.SyntaxKind.AmpersandAmpersandToken ||
    kind === ts.SyntaxKind.PlusToken ||
    kind === ts.SyntaxKind.CommaToken
  );
}

/**
 * Whole-file scan. Returns the untranslated literals with their 1-based line numbers, plus the
 * opt-out markers that claimed an exemption without a usable reason. `filename` is optional and
 * used only to pick the ScriptKind (TSX vs TS); the call sites in `literalScanForFile` pass the
 * real repo-relative path so a `.ts` file is never parsed as TSX.
 */
export function untranslatedLiteralsInSource(source, filename) {
  const lines = source.split(/\r?\n/);
  const findings = [];
  const weakExemptions = [];
  const reportOnLine = (index, texts) => {
    if (texts.length === 0) return;
    const reason = exemptReasonFor(lines, index);
    if (reason === null) {
      for (const text of texts) findings.push({ line: index + 1, text });
      return;
    }
    if (reason.length < I18N_EXEMPT_MIN_REASON) {
      weakExemptions.push({ line: index + 1, reason });
    }
  };

  // AST pass: JSX text (multi-line included) and string-literal expression-container children.
  // `isCommentLine` intentionally does NOT run here: the parser has already excluded C-style
  // comments from JsxText / JsxExpression nodes, and applying it would reclassify legitimate
  // user copy that happens to start with `*`, `//`, or `/*` on its own indented line (for
  // example `* Required fields` inside a multi-line `<p>...</p>`) as a source comment and
  // silently drop it. Whitespace inside the trimmed text is collapsed to single spaces so that
  // reindenting or rewrapping multi-line JSX copy does not churn the baseline ledger — the copy
  // renders identically to the user with any run of intra-node whitespace.
  for (const { line, text } of collectJsxTextAndExpressions(source, filename)) {
    const normalized = text.trim().replace(/\s+/gu, " ");
    if (isTranslatableCopy(normalized)) reportOnLine(line - 1, [normalized]);
  }

  // Per-line pass for the two non-JSX positions the AST does not cover: user-facing attribute
  // values on non-JSX call sites and label/description fields on option/command registries.
  lines.forEach((line, index) => {
    if (isCommentLine(line)) return;
    const literals = [
      ...quotedValuesAfter(line, USER_FACING_ATTRIBUTE_NAME_RE),
      ...quotedValuesAfter(line, LABEL_FIELD_NAME_RE),
    ]
      .map((value) => value.trim())
      .filter(isTranslatableCopy);
    reportOnLine(index, literals);
  });

  return { findings, weakExemptions };
}

// `hasUserFacingTextLine` cannot distinguish a string that is RENDERED from one that is only ever
// passed to `console.warn`/`console.error` — a `return \`...\`` shape looks identical either way to
// a line-level heuristic. The per-literal ledger scan already trusts a diff-visible, reason-gated
// `// i18n-exempt:` marker for exactly this "provably not user-facing" claim (untranslatedLiteralsInLine
// positions); this relevance pre-filter did not consult it, so a changed file whose ONLY
// "user-facing-shaped" line was a redacted operator diagnostic was still forced through "must use the
// i18n API" (0.3.0 audit, #2802 — packages/keiko-ui/.../shellShortcutState.ts's refusal diagnostic).
// The marker must sit on the line itself: `hasI18nRelevantChange` diffs to a filtered list of added
// lines, so an "own line or the line above" lookup (the ledger scan's convention) is not reliably
// available here.
// A wordless (or too-short) `i18n-exempt` cannot suppress relevance either: the ledger scan's own
// invariant is that the escape hatch "cannot be used wordlessly", and a return-statement position is
// never examined by that scan's weak-exemption check, so this is the only place that invariant can
// be enforced for it. An under-justified marker is treated as absent, not as a distinct failure —
// the line still trips "does not use the i18n API", which fails the gate either way.
function isUsableExemptReason(line) {
  const reason = i18nExemptReason(line);
  return reason !== null && reason.length >= I18N_EXEMPT_MIN_REASON;
}

function hasUnexemptedUserFacingTextLine(line) {
  return hasUserFacingTextLine(line) && !isUsableExemptReason(line);
}

export function hasI18nRelevantAddedLine(line) {
  return (
    hasUnexemptedUserFacingTextLine(line) ||
    // A registry `label:`/`description:` literal is user-facing text that no JSX/attribute/return
    // pattern above can see — the shape the whole window-type table was written in.
    untranslatedLiteralsInLine(line).length > 0 ||
    I18N_KEY_REFERENCE_PATTERN.test(line) ||
    I18N_USAGE_PATTERNS.some((pattern) => pattern.test(line))
  );
}

function changedLinesFromPatch(patch) {
  const lines = patch.split(/\r?\n/);
  return {
    added: lines
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1)),
    removed: lines
      .filter((line) => line.startsWith("-") && !line.startsWith("---"))
      .map((line) => line.slice(1)),
  };
}

function gitChangedLinesForFile(repoRoot, file, env = process.env) {
  for (const range of diffRangesFromEnv(env)) {
    const result = spawnSync(
      resolveHostExecutable("git"),
      ["diff", "--unified=0", "--diff-filter=ACMRT", range, "--", file],
      {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (result.status === 0) return changedLinesFromPatch(result.stdout);
  }
  return null;
}

function collectI18nChangeSignatures(lines) {
  const signatures = new Set();
  for (const line of lines) {
    const keyMatches = line.matchAll(/\bt\s*\(\s*(["'`])([^"'`]+)\1/gu);
    for (const match of keyMatches) signatures.add(`key:${match[2]}`);
    if (/\buseTranslate\s*\(/u.test(line)) signatures.add("api:useTranslate");
    if (/\buseOptionalWidgetTranslate\s*\(/u.test(line)) {
      signatures.add("api:useOptionalWidgetTranslate");
    }
    if (/\buseI18n\s*\(/u.test(line)) signatures.add("api:useI18n");
    if (/<\s*I18nTranslate\b/u.test(line)) signatures.add("api:I18nTranslate");
    if (/\bOptionalWidgetTranslate\b/u.test(line)) {
      signatures.add("api:OptionalWidgetTranslate");
    }
  }
  return signatures;
}

function hasNewI18nSignature(addedLines, removedLines) {
  const added = collectI18nChangeSignatures(addedLines);
  const removed = collectI18nChangeSignatures(removedLines);
  return Array.from(added).some((signature) => !removed.has(signature));
}

function sourceHasUserFacingText(source) {
  const lines = source.split(/\r?\n/);
  // Full source is available here (unlike the git-diff path), so this honours the ledger scan's own
  // "own line or the line immediately above" exemption convention rather than the own-line-only rule
  // `hasUnexemptedUserFacingTextLine` uses for a filtered diff-line list. The reason-length floor
  // mirrors `isUsableExemptReason`: a wordless marker must not suppress relevance either.
  return lines.some((line, index) => {
    if (!hasUserFacingTextLine(line)) return false;
    const reason = exemptReasonFor(lines, index);
    return reason === null || reason.length < I18N_EXEMPT_MIN_REASON;
  });
}

// When a real diff is available, only newly introduced signals decide relevance: a change is
// i18n-relevant only if it adds user-facing text or an i18n key/API signature that the same patch
// did not remove. A pure refactor or JSX element replacement around an existing translated value
// must not force an unrelated catalog touch. Fixture-driven callers with no git history fall back
// to whole-file detection, matching prior behavior.
function hasI18nRelevantChange(repoRoot, file) {
  const changedLines = gitChangedLinesForFile(repoRoot, file);
  if (changedLines !== null) {
    if (!changedLines.added.some(hasI18nRelevantAddedLine)) return false;
    if (changedLines.added.some(hasUnexemptedUserFacingTextLine)) return true;
    return hasNewI18nSignature(changedLines.added, changedLines.removed);
  }
  const source = readText(repoRoot, file);
  return hasI18nUsage(repoRoot, file) || sourceHasUserFacingText(source);
}

function isSafeGitSha(value) {
  return /^[0-9a-fA-F]{7,40}$/.test(value);
}

function isSafeGitRef(value) {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) && !value.includes("..") && !value.includes("//")
  );
}

function diffNameOnly(repoRoot, range) {
  const result = spawnSync(
    resolveHostExecutable("git"),
    ["diff", "--name-only", "--diff-filter=ACMRT", range, "--"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  if (result.status !== 0) {
    return {
      ok: false,
      error:
        (result.error instanceof Error ? result.error.message : "") ||
        String(result.stderr ?? "").trim() ||
        `git diff exited with status ${result.status ?? "unknown"}`,
      files: [],
    };
  }

  return {
    ok: true,
    error: "",
    files: result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  };
}

function isZeroSha(value) {
  return /^0{40}$/.test(value);
}

function validateBaseSha(baseSha) {
  if (baseSha !== undefined && baseSha !== "" && !isZeroSha(baseSha) && !isSafeGitSha(baseSha)) {
    throw new Error(`check:ui-i18n received an unsafe base SHA: ${baseSha}`);
  }
}

function validateBaseRef(baseRef) {
  if (baseRef !== undefined && baseRef !== "" && !isSafeGitRef(baseRef)) {
    throw new Error(`check:ui-i18n received an unsafe base ref: ${baseRef}`);
  }
}

function pushRange(ranges, range) {
  if (!ranges.includes(range)) {
    ranges.push(range);
  }
}

function pushBaseShaRanges(ranges, baseSha) {
  if (baseSha && !isZeroSha(baseSha)) {
    pushRange(ranges, `${baseSha}..HEAD`);
    pushRange(ranges, `${baseSha}...HEAD`);
  }
}

function pushBaseRefRanges(ranges, baseRef) {
  if (baseRef) {
    pushRange(ranges, `origin/${baseRef}...HEAD`);
    pushRange(ranges, `${baseRef}...HEAD`);
  }
}

function pushEventFallbackRanges(ranges, eventName, baseRef) {
  if (eventName === "push" && !baseRef) {
    pushRange(ranges, "origin/dev...HEAD");
    pushRange(ranges, "HEAD^1..HEAD");
  }
}

function diffRangesFromEnv(env) {
  const baseRef = env.KEIKO_I18N_GUARD_BASE_REF ?? env.GITHUB_BASE_REF;
  const baseSha = env.KEIKO_I18N_GUARD_BASE_SHA ?? env.GITHUB_EVENT_BEFORE;
  const eventName = env.GITHUB_EVENT_NAME ?? "";
  const ranges = [];

  validateBaseSha(baseSha);
  validateBaseRef(baseRef);
  pushBaseRefRanges(ranges, baseRef);
  pushBaseShaRanges(ranges, baseSha);
  pushEventFallbackRanges(ranges, eventName, baseRef);

  if (ranges.length === 0 && eventName) {
    pushRange(ranges, "HEAD^1..HEAD");
  }

  if (ranges.length === 0) {
    pushRange(ranges, "origin/dev...HEAD");
    pushRange(ranges, "HEAD^1..HEAD");
  }

  return ranges;
}

export function changedFilesFromGit(repoRoot, diffNameOnlyFn = diffNameOnly, env = process.env) {
  const ranges = diffRangesFromEnv(env);
  const errors = [];

  for (const range of ranges) {
    const result = diffNameOnlyFn(repoRoot, range);
    if (result.ok) {
      return result.files;
    }
    errors.push(`${range}: ${result.error}`);
  }

  throw new Error(
    `check:ui-i18n could not determine changed files from git. Tried ranges: ${errors.join("; ")}`,
  );
}

export function changedFilesFromInput(repoRoot, argv = process.argv, env = process.env) {
  const filesIndex = argv.indexOf("--files");
  if (filesIndex >= 0) {
    return argv.slice(filesIndex + 1);
  }

  if (env.KEIKO_I18N_GUARD_CHANGED_FILES) {
    return env.KEIKO_I18N_GUARD_CHANGED_FILES.split(/[,\n;]/)
      .map((file) => file.trim())
      .filter(Boolean);
  }

  return changedFilesFromGit(repoRoot, diffNameOnly, env);
}

function symmetricDifference(left, right) {
  return [
    ...Array.from(left).filter((key) => !right.has(key)),
    ...Array.from(right).filter((key) => !left.has(key)),
  ].sort((a, b) => a.localeCompare(b));
}

export const LITERAL_BASELINE = "docs/qa/ui-i18n-literal-baseline.json";

// Fails LOUDLY when the ledger is missing or unreadable rather than defaulting to an empty object:
// an empty baseline silently turns every pre-existing literal into a fresh failure, which is the kind
// of noise that gets a gate switched off.
export function readLiteralBaseline(repoRoot) {
  const parsed = JSON.parse(readText(repoRoot, LITERAL_BASELINE));
  const files = parsed.files;
  if (files === null || typeof files !== "object") {
    throw new Error(`${LITERAL_BASELINE} must contain a "files" object.`);
  }
  return files;
}

function readTextOrNull(repoRoot, file) {
  try {
    return readText(repoRoot, file);
  } catch {
    return null;
  }
}

export function literalScanForFile(repoRoot, file) {
  const source = readTextOrNull(repoRoot, file);
  return source === null ? null : untranslatedLiteralsInSource(source, file);
}

function weakExemptionProblems(file, weakExemptions) {
  return weakExemptions.map(
    ({ line, reason }) =>
      `${file}:${String(line)} claims \`// i18n-exempt:\` with reason ${JSON.stringify(reason)}. An opt-out must state why the literal is not user-facing in at least ${String(I18N_EXEMPT_MIN_REASON)} characters.`,
  );
}

function introducedLiteralProblem(file, findings, allowed) {
  const introduced = findings.filter((finding) => !allowed.has(finding.text));
  if (introduced.length === 0) return null;
  const detail = introduced
    .map((finding) => `${String(finding.line)}: ${JSON.stringify(finding.text)}`)
    .join("; ");
  return `${file} contains untranslated user-facing literal(s) at line ${detail}. Route the text through the i18n API with English AND German catalog entries, or mark the line \`// i18n-exempt: <why it is not user-facing>\`.`;
}

function staleBaselineProblem(file, findings, allowed) {
  const present = new Set(findings.map((finding) => finding.text));
  const stale = Array.from(allowed).filter((text) => !present.has(text));
  if (stale.length === 0) return null;
  return `${LITERAL_BASELINE} still lists ${String(stale.length)} literal(s) for ${file} that no longer exist (${stale.map((text) => JSON.stringify(text)).join(", ")}). The ledger only shrinks: regenerate it with \`npm run check:ui-i18n -- --write-baseline\`.`;
}

export function untranslatedLiteralProblems(repoRoot, uiFiles, baseline) {
  const problems = [];
  for (const file of uiFiles) {
    const scan = literalScanForFile(repoRoot, file);
    if (scan === null) continue;
    const allowed = new Set(baseline[file] ?? []);
    problems.push(...weakExemptionProblems(file, scan.weakExemptions));
    const introduced = introducedLiteralProblem(file, scan.findings, allowed);
    if (introduced !== null) problems.push(introduced);
    const stale = staleBaselineProblem(file, scan.findings, allowed);
    if (stale !== null) problems.push(stale);
  }
  return problems;
}

function trackedFiles(repoRoot) {
  const result = spawnSync(resolveHostExecutable("git"), ["ls-files"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error("check:ui-i18n could not list tracked files with git ls-files.");
  }
  return result.stdout.split(/\r?\n/).map(normalizePath).filter(Boolean);
}

export function allUiProductionSources(repoRoot) {
  return trackedFiles(repoRoot)
    .filter(isUiProductionSource)
    .sort((left, right) => left.localeCompare(right));
}

export function buildLiteralBaseline(repoRoot) {
  const files = {};
  for (const file of allUiProductionSources(repoRoot)) {
    const scan = literalScanForFile(repoRoot, file);
    if (scan === null || scan.findings.length === 0) continue;
    files[file] = Array.from(new Set(scan.findings.map((finding) => finding.text))).sort((a, b) =>
      a.localeCompare(b),
    );
  }
  return files;
}

export function checkUiI18nGuard({
  repoRoot = process.cwd(),
  changedFiles = changedFilesFromInput(repoRoot),
  literalBaseline = undefined,
} = {}) {
  const normalizedChangedFiles = changedFiles
    .map((file) => normalizePath(file.trim()))
    .filter(Boolean);
  const changedFileSet = new Set(normalizedChangedFiles);
  const uiFiles = normalizedChangedFiles.filter(isUiProductionSource);
  const i18nRelevantFiles = uiFiles.filter((file) => hasI18nRelevantChange(repoRoot, file));
  const problems = [];

  // The literal ledger is evaluated for EVERY changed UI source, not only the ones the relevance
  // heuristic flags: whether a diff "looks i18n-relevant" is a heuristic, whether a file currently
  // holds an untranslated user-facing literal is a fact.
  if (uiFiles.length > 0) {
    const baseline = literalBaseline ?? readLiteralBaseline(repoRoot);
    problems.push(...untranslatedLiteralProblems(repoRoot, uiFiles, baseline));
  }

  if (uiFiles.length === 0 || i18nRelevantFiles.length === 0) {
    return {
      ok: problems.length === 0,
      problems,
      uiFiles,
      i18nRelevantFiles,
      changedFiles: normalizedChangedFiles,
    };
  }

  problems.push(...catalogRequirementProblems(repoRoot, changedFileSet, i18nRelevantFiles));

  return {
    ok: problems.length === 0,
    problems,
    uiFiles,
    i18nRelevantFiles,
    changedFiles: normalizedChangedFiles,
  };
}

// The pre-existing checks, unchanged in behaviour: catalogs must be updated together, a changed UI
// file must reach the i18n API somehow, and both catalogs must expose the same keys.
function catalogRequirementProblems(repoRoot, changedFileSet, i18nRelevantFiles) {
  const catalogRequirement = catalogUpdateProblems(changedFileSet, repoRoot);
  const problems = [...catalogRequirement.problems];
  const nonCompliantFiles = nonCompliantUiFiles(repoRoot, i18nRelevantFiles);

  if (nonCompliantFiles.length > 0) {
    problems.push(
      `UI source changed, but these changed UI files do not use the i18n API: ${nonCompliantFiles.join(", ")}. Use useTranslate, <I18nTranslate />, or another existing i18n helper for user-facing text.`,
    );
  }

  const keyMismatches = symmetricDifference(
    extractCatalogKeys(readText(repoRoot, EN_CATALOG)),
    extractCatalogKeys(readText(repoRoot, DE_CATALOG)),
  );

  if (keyMismatches.length > 0) {
    problems.push(
      `English and German i18n catalogs must expose the same keys. Mismatched keys: ${keyMismatches.join(", ")}.`,
    );
  }

  problems.push(
    ...featureCatalogParityProblems(repoRoot, catalogRequirement.featureCatalogPairs),
    ...singleFileCatalogParityProblems(repoRoot, catalogRequirement.singleFileCatalogs ?? []),
  );
  return problems;
}

const LITERAL_BASELINE_COMMENT =
  "Ratcheted ledger of pre-existing untranslated user-facing literals in the Keiko UI, one entry per " +
  "file (see scripts/check-ui-i18n-guard.mjs). A literal listed here is known debt the check:ui-i18n " +
  "gate tolerates; ANY literal not listed fails the gate. The ledger only shrinks - regenerate it with " +
  "`npm run check:ui-i18n -- --write-baseline` after removing literals, and never add an entry to " +
  "silence a new one. For a literal that is genuinely not user-facing, mark the source line " +
  "`// i18n-exempt: <reason>` instead, so the claim is visible in the diff.";

function writeBaselineMode(repoRoot) {
  const files = buildLiteralBaseline(repoRoot);
  const literalCount = Object.values(files).reduce((total, list) => total + list.length, 0);
  writeFileSync(
    resolve(repoRoot, LITERAL_BASELINE),
    `${JSON.stringify({ $comment: LITERAL_BASELINE_COMMENT, files }, null, 2)}\n`,
    "utf8",
  );
  console.log(
    `check:ui-i18n baseline written - ${String(Object.keys(files).length)} file(s), ${String(literalCount)} literal(s).`,
  );
}

// The whole-repository evaluation: every tracked UI production source measured against the ledger.
// This is what proves the gate is in sync with the tree, and what a `--write-baseline` run must leave
// clean.
function allScopeChangedFiles(repoRoot) {
  return [...allUiProductionSources(repoRoot), EN_CATALOG, DE_CATALOG];
}

// The scanned-file list is context for a PR-sized diff; in `--all` mode it is the whole UI tree and
// would bury the findings, so it is elided past a readable size.
const REPORTED_FILE_LIMIT = 25;

function reportFailure(result) {
  console.error("check:ui-i18n FAIL");
  console.error("");
  if (result.uiFiles.length <= REPORTED_FILE_LIMIT) {
    console.error("Changed UI source files:");
    for (const file of result.uiFiles) {
      console.error(`- ${file}`);
    }
  } else {
    console.error(`Scanned ${String(result.uiFiles.length)} UI source files.`);
  }
  console.error("");
  console.error("Required fixes:");
  for (const problem of result.problems) {
    console.error(`- ${problem}`);
  }
}

function main() {
  const repoRoot = process.cwd();
  const flags = new Set(process.argv.slice(2));
  let result;
  try {
    if (flags.has("--write-baseline")) {
      writeBaselineMode(repoRoot);
      return;
    }
    result = flags.has("--all")
      ? checkUiI18nGuard({ repoRoot, changedFiles: allScopeChangedFiles(repoRoot) })
      : checkUiI18nGuard();
  } catch (error) {
    console.error("check:ui-i18n FAIL");
    console.error("");
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  if (result.ok) {
    console.log(
      `check:ui-i18n OK - ${result.uiFiles.length} changed UI source file(s) require no additional i18n action.`,
    );
    return;
  }

  reportFailure(result);
  process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
