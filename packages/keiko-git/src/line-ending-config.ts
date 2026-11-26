// Local reads run without system and global Git configuration (see `gitEnv`). Git for Windows ships
// `core.autocrlf=true` in its system scope, so a checkout whose files carry CRLF would then show
// every such file as modified while the person's own `git status` is clean. The line-ending keys are
// pure data that execute nothing, so exactly these two are read back from the user's scopes and
// forwarded as `-c` arguments. Every value is checked against a closed vocabulary; anything else
// (a hostile or unknown value, another key) is dropped and Git's built-in default applies.

export const LINE_ENDING_CONFIG_QUERY: readonly string[] = [
  "config",
  "--no-includes",
  "--null",
  "--get-regexp",
  String.raw`^core\.(autocrlf|eol)$`,
];

const ALLOWED_VALUES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["core.autocrlf", new Set(["true", "false", "input"])],
  ["core.eol", new Set(["lf", "crlf", "native"])],
]);
const MAX_LISTING_ENTRIES = 64;

// `--null --get-regexp` prints `key\nvalue\0` per entry in precedence order, so the last entry of a
// key is the effective one. Git lowercases the key name; the value is matched case-insensitively
// the way Git reads it and forwarded in its canonical lowercase form.
export function lineEndingConfigArgs(listing: string): readonly string[] {
  const effective = new Map<string, string>();
  const entries = listing.split("\0").filter((entry) => entry !== "");
  if (entries.length > MAX_LISTING_ENTRIES) return [];
  for (const entry of entries) {
    const separator = entry.indexOf("\n");
    if (separator < 0) continue;
    const key = entry.slice(0, separator);
    const value = entry.slice(separator + 1).toLowerCase();
    if (ALLOWED_VALUES.get(key)?.has(value) === true) effective.set(key, value);
    else effective.delete(key);
  }
  return [...effective].flatMap(([key, value]) => ["-c", `${key}=${value}`]);
}
