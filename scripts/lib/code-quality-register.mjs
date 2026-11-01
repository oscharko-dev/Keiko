// The shrink-only code-quality register (#4145). Existing findings are recorded per (path, rule) as
// counts; a run may only reproduce or lower them. Counts are per file, so a finding that moves
// within one file while another disappears is not distinguishable from the original pair.
export const REGISTER_PATH = "scripts/code-quality-register.json";
const REGISTER_VERSION = 1;

// Repository-relative POSIX paths: printable segments (Next.js route folders use brackets).
const UNSAFE_PATH_CHARACTER = /[\p{Cc}\\]/u;
const RULE_PATTERN = /^[A-Za-z0-9@_-]+(?:\/[A-Za-z0-9@_-]+)*$/u;
const NAME_LIMIT = 512;

function compareText(left, right) {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function isPlainRecord(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function validRegisterPath(path) {
  return (
    path.length <= NAME_LIMIT &&
    !UNSAFE_PATH_CHARACTER.test(path) &&
    !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  );
}

function validRule(rule) {
  return rule.length <= NAME_LIMIT && RULE_PATTERN.test(rule);
}

function parseRuleCounts(record) {
  if (!isPlainRecord(record)) throw new TypeError("invalid-code-quality-register");
  const rules = new Map();
  for (const [rule, count] of Object.entries(record)) {
    if (!validRule(rule) || !Number.isSafeInteger(count) || count < 1)
      throw new TypeError("invalid-code-quality-register");
    rules.set(rule, count);
  }
  if (rules.size === 0) throw new TypeError("invalid-code-quality-register");
  return rules;
}

/** Parses and validates committed register text; any deviation from the canonical form fails. */
export function parseRegister(text) {
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new TypeError("invalid-code-quality-register");
  }
  if (
    !isPlainRecord(document) ||
    Object.keys(document).join("\0") !== "version\0files" ||
    document.version !== REGISTER_VERSION ||
    !isPlainRecord(document.files)
  )
    throw new TypeError("invalid-code-quality-register");
  const files = new Map();
  for (const [path, record] of Object.entries(document.files)) {
    if (!validRegisterPath(path)) throw new TypeError("invalid-code-quality-register");
    files.set(path, parseRuleCounts(record));
  }
  if (serializeRegister(files) !== text) throw new TypeError("noncanonical-code-quality-register");
  return files;
}

/** Serializes a register map in its one canonical, sorted form. */
export function serializeRegister(files) {
  // Null-prototype records keep a hostile "__proto__" key an ordinary own property.
  const document = { version: REGISTER_VERSION, files: Object.create(null) };
  for (const path of [...files.keys()].sort(compareText)) {
    const rules = files.get(path);
    const record = Object.create(null);
    for (const rule of [...rules.keys()].sort(compareText)) record[rule] = rules.get(rule);
    document.files[path] = record;
  }
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** Counts every diagnostic per (path, rule). */
export function countRegisterFindings(diagnostics) {
  const files = new Map();
  for (const { path, rule } of diagnostics) {
    if (!validRegisterPath(path) || !validRule(rule)) throw new TypeError("unknown-diagnostic");
    const rules = files.get(path) ?? new Map();
    rules.set(rule, (rules.get(rule) ?? 0) + 1);
    files.set(path, rules);
  }
  return files;
}

export function registerTotal(files) {
  let total = 0;
  for (const rules of files.values()) for (const count of rules.values()) total += count;
  return total;
}

function compareRules(path, before, after, result) {
  for (const [rule, count] of after) {
    const registered = before?.get(rule) ?? 0;
    if (count > registered) result.increases.push({ path, rule, before: registered, after: count });
  }
  for (const [rule, registered] of before ?? []) {
    const count = after.get(rule) ?? 0;
    if (count < registered) result.decreases.push({ path, rule, before: registered, after: count });
  }
}

/**
 * Compares a committed register with the current counts. `scannedPaths` is the complete set of
 * paths the scan visited; a registered path outside it is stale.
 */
export function compareRegister(register, current, scannedPaths) {
  const result = { increases: [], decreases: [], stale: [] };
  const paths = new Set([...register.keys(), ...current.keys()]);
  for (const path of [...paths].sort(compareText)) {
    if (register.has(path) && !scannedPaths.has(path)) {
      result.stale.push(path);
      continue;
    }
    compareRules(path, register.get(path), current.get(path) ?? new Map(), result);
  }
  return {
    ...result,
    before: registerTotal(register),
    after: registerTotal(current),
    outcome:
      result.increases.length + result.decreases.length + result.stale.length === 0
        ? "passed"
        : "failed",
  };
}

// The reviewed increase ledger (#4145). The register only shrinks, except where a reviewed entry
// names one exact raise of one (path, rule) count. Entries are history: later changes may add
// entries but never remove or change one.
export const REGISTER_INCREASES_PATH = "scripts/code-quality-register-increases.json";
const INCREASE_KEYS = ["path", "rule", "from", "to", "reason", "issue"];
const INCREASE_REASONS = new Set([
  "qualified-boundary",
  "pending-boundary-migration",
  "test-witness",
  "proof-fixture",
]);

function validIncreaseIdentity(entry) {
  return (
    isPlainRecord(entry) &&
    Object.keys(entry).join("\0") === INCREASE_KEYS.join("\0") &&
    // String(value) === value accepts only primitive strings, never an array that would coerce.
    String(entry.path) === entry.path &&
    validRegisterPath(entry.path) &&
    String(entry.rule) === entry.rule &&
    validRule(entry.rule)
  );
}

function validIncrease(entry) {
  return (
    validIncreaseIdentity(entry) &&
    Number.isSafeInteger(entry.from) &&
    entry.from >= 0 &&
    Number.isSafeInteger(entry.to) &&
    entry.to > entry.from &&
    INCREASE_REASONS.has(entry.reason) &&
    Number.isSafeInteger(entry.issue) &&
    entry.issue > 0
  );
}

function increaseKey(entry) {
  return JSON.stringify(INCREASE_KEYS.map((key) => entry[key]));
}

function compareIncreases(left, right) {
  return (
    compareText(left.path, right.path) ||
    compareText(left.rule, right.rule) ||
    left.from - right.from ||
    left.to - right.to ||
    left.issue - right.issue ||
    compareText(left.reason, right.reason)
  );
}

/** Serializes ledger entries in their one canonical, sorted form. */
export function serializeIncreases(entries) {
  const increases = [...entries]
    .sort(compareIncreases)
    .map((entry) => Object.fromEntries(INCREASE_KEYS.map((key) => [key, entry[key]])));
  return `${JSON.stringify({ version: REGISTER_VERSION, increases }, null, 2)}\n`;
}

/** Parses the committed ledger; malformed, duplicated or non-canonical text fails closed. */
export function parseIncreases(text) {
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new TypeError("invalid-code-quality-register-increases");
  }
  if (
    !isPlainRecord(document) ||
    Object.keys(document).join("\0") !== "version\0increases" ||
    document.version !== REGISTER_VERSION ||
    !Array.isArray(document.increases) ||
    !document.increases.every(validIncrease) ||
    new Set(document.increases.map(increaseKey)).size !== document.increases.length
  )
    throw new TypeError("invalid-code-quality-register-increases");
  if (serializeIncreases(document.increases) !== text)
    throw new TypeError("noncanonical-code-quality-register-increases");
  return document.increases;
}

function matchesRaise(entry, raise) {
  return (
    entry.path === raise.path &&
    entry.rule === raise.rule &&
    entry.from === raise.before &&
    entry.to === raise.after
  );
}

/**
 * Returns the current counts as the new register. A count may fall freely; it may rise only to
 * exactly the `to` of a ledger entry with the same path, rule and `from`.
 */
export function pruneRegister(register, current, scannedPaths, increases = []) {
  const comparison = compareRegister(register, current, scannedPaths);
  if (!comparison.increases.every((raise) => increases.some((entry) => matchesRaise(entry, raise))))
    throw new TypeError("code-quality-register-increase");
  return current;
}

/**
 * Reviews the committed register against the register of the change's base. Every raised count
 * needs one ledger entry this change adds, with the same path, rule, `from` and `to`. An added
 * entry that matches no raise is stale; a removed or changed base entry rewrites history.
 */
export function reviewRegisterRaises({ baseRegister, register, baseIncreases, increases }) {
  const raises = compareRegister(baseRegister, register, new Set(register.keys())).increases;
  // A ledger holds no duplicate entry, so set membership identifies added and removed entries.
  const baseKeys = new Set(baseIncreases.map(increaseKey));
  const keys = new Set(increases.map(increaseKey));
  const added = increases.filter((entry) => !baseKeys.has(increaseKey(entry)));
  const rewritten = baseIncreases.filter((entry) => !keys.has(increaseKey(entry)));
  const unreviewed = [];
  for (const raise of raises) {
    const index = added.findIndex((entry) => matchesRaise(entry, raise));
    if (index === -1) unreviewed.push(raise);
    else added.splice(index, 1);
  }
  return {
    raises,
    unreviewed,
    stale: added,
    rewritten,
    outcome: unreviewed.length + added.length + rewritten.length === 0 ? "passed" : "failed",
  };
}
