/**
 * The closed vocabulary of what a native run does with the producer's built-in formatters (#3897,
 * parity row C07). `enabled` is the only value that lets a formatter run; every other value is a
 * reason it is switched off.
 */
export const OPENCODE_NATIVE_FORMATTER_DISPOSITIONS = [
  "enabled",
  "disabled-ask-mode",
  "disabled-supervised-mode",
  "disabled-unknown-mode",
] as const;

export type OpenCodeNativeFormatterDisposition =
  (typeof OPENCODE_NATIVE_FORMATTER_DISPOSITIONS)[number];

/**
 * The pinned 2.1.4 producer runs a built-in formatter (prettier, biome, gofmt, ...) after its own
 * `edit`, `write` and `patch` tools, as a plain child process of the runtime, and consults no
 * permission for it: the policy hook sees the edit, never the formatter. The tool it starts is a
 * host binary found on the launcher's PATH, a package resolved through the producer's own package
 * manager (offline under Keiko, so none resolves), or, for `pint`, the repository's own
 * `./vendor/bin/pint`: a command that starts without the approval an unvetted command needs. The
 * producer keeps built-in formatters off unless the configuration says `formatter: true`, so this
 * function decides, per launch mode, whether Keiko says so.
 *
 * The decision is bound when the tree launches and cannot follow a later narrowing: a resume may
 * narrow Supervised workspace to Ask for approval in place, and the formatter's setting is part of
 * the launch configuration. Only Full access therefore enables the formatter. A Full access tree
 * cannot be narrowed in place at all (`openCodeNativeEgress` binds its egress at exec and the
 * composition refuses the narrowing), so an enabled formatter never outlives the authority that
 * allowed it. Ask for approval keeps it off because nothing may start unapproved there, Supervised
 * workspace because it may become Ask for approval, and an unrecognized or absent mode fails closed.
 */
export function openCodeNativeFormatterDisposition(
  mode: string | undefined,
): OpenCodeNativeFormatterDisposition {
  switch (mode) {
    case "autonomous-delivery":
      return "enabled";
    case "supervised-coding":
      return "disabled-supervised-mode";
    case "governed-assist":
      return "disabled-ask-mode";
    default:
      return "disabled-unknown-mode";
  }
}

/**
 * The `formatter` setting the server-owned binding carries: always explicit, never inherited. With
 * the configuration documents of the run (#3900 AC4) a Full access run carries their merged,
 * re-validated entries; every other mode stays `false`.
 */
export function openCodeNativeFormatterSetting(
  disposition: OpenCodeNativeFormatterDisposition,
  documents: readonly Readonly<Record<string, unknown>>[] = [],
): OpenCodeNativeFormatterValue {
  return openCodeNativeFormatterAdmission(disposition, documents).value;
}

/**
 * One admitted `formatter` entry, in the producer's own schema: a built-in's override (`disabled`,
 * `extensions`, `environment`) or a custom formatter (`command`, with the `$FILE` placeholder).
 */
export interface OpenCodeNativeFormatterEntry {
  readonly disabled?: boolean;
  readonly command?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly extensions?: readonly string[];
}

export type OpenCodeNativeFormatterValue =
  boolean | Readonly<Record<string, OpenCodeNativeFormatterEntry>>;

export interface OpenCodeNativeFormatterAdmission {
  /** What the server-owned binding carries; only `enabled` admits more than `false`. */
  readonly value: OpenCodeNativeFormatterValue;
  /** Entries the documents configured and Keiko carries. */
  readonly entryCount: number;
  /** Entries or keys Keiko refused: malformed, oversized or carrying a configuration placeholder. */
  readonly refusedCount: number;
}

const FORMATTER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
const ENVIRONMENT_NAME = /^[A-Za-z_]\w{0,127}$/u;
const EXTENSION = /^\.[A-Za-z0-9][A-Za-z0-9_.+-]{0,31}$/u;
const MAX_ENTRIES = 32;
const MAX_COMMAND_PARTS = 64;
const MAX_ENVIRONMENT = 32;
const MAX_EXTENSIONS = 64;
const MAX_TEXT = 4_096;
// The producer substitutes `{env:NAME}` and `{file:path}` in configuration text, so a copied value
// could read the run's own capability or a file the run may not open. No admitted value has one.
const PLACEHOLDER = /\{(?:env|file):/u;

function admittedText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_TEXT &&
    !value.includes("\0") &&
    !PLACEHOLDER.test(value)
  );
}

function admittedList(
  value: unknown,
  max: number,
  accept: (item: string) => boolean,
): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) return undefined;
  const items = value as readonly unknown[];
  return items.every((item) => admittedText(item) && accept(item))
    ? (items as readonly string[])
    : undefined;
}

function admittedEnvironment(value: unknown): Readonly<Record<string, string>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Readonly<Record<string, unknown>>);
  if (entries.length > MAX_ENVIRONMENT) return undefined;
  return entries.every(([name, text]) => ENVIRONMENT_NAME.test(name) && admittedText(text))
    ? (Object.fromEntries(entries) as Readonly<Record<string, string>>)
    : undefined;
}

interface EntryAdmission {
  readonly entry: OpenCodeNativeFormatterEntry | undefined;
  readonly refused: number;
}

/** One configured entry with every key re-validated; an unknown or invalid key is refused. */
function admittedEntry(value: unknown): EntryAdmission {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { entry: undefined, refused: 1 };
  const entry: Record<string, unknown> = {};
  let refused = 0;
  for (const [key, field] of Object.entries(value as Readonly<Record<string, unknown>>)) {
    const admitted = admittedField(key, field);
    if (admitted === undefined) refused += 1;
    else entry[key] = admitted;
  }
  return { entry, refused };
}

function admittedField(key: string, value: unknown): unknown {
  switch (key) {
    case "disabled":
      return typeof value === "boolean" ? value : undefined;
    case "command":
      return admittedList(value, MAX_COMMAND_PARTS, () => true);
    case "environment":
      return admittedEnvironment(value);
    case "extensions":
      return admittedList(value, MAX_EXTENSIONS, (extension) => EXTENSION.test(extension));
    default:
      return undefined;
  }
}

/**
 * The documents' `formatter` settings merged in the producer's order (a boolean replaces what came
 * before; an object merges entry by entry, its environments key by key), every entry re-validated.
 */
export function mergedFormatterSetting(documents: readonly Readonly<Record<string, unknown>>[]): {
  readonly value: OpenCodeNativeFormatterValue | undefined;
  readonly refused: number;
} {
  let value: OpenCodeNativeFormatterValue | undefined;
  let refused = 0;
  for (const document of documents) {
    const setting = document.formatter;
    if (setting === undefined) continue;
    if (typeof setting === "boolean") {
      value = setting;
      continue;
    }
    if (typeof setting !== "object" || setting === null || Array.isArray(setting)) {
      refused += 1;
      continue;
    }
    const merged = mergeEntries(typeof value === "object" ? value : {}, setting);
    value = merged.entries;
    refused += merged.refused;
  }
  return { value, refused };
}

function mergeEntries(
  base: Readonly<Record<string, OpenCodeNativeFormatterEntry>>,
  setting: object,
): {
  readonly entries: Readonly<Record<string, OpenCodeNativeFormatterEntry>>;
  readonly refused: number;
} {
  const entries: Record<string, OpenCodeNativeFormatterEntry> = { ...base };
  let refused = 0;
  for (const [name, value] of Object.entries(setting as Readonly<Record<string, unknown>>)) {
    const admitted = admittedEntry(value);
    refused += admitted.refused;
    if (!FORMATTER_NAME.test(name) || admitted.entry === undefined) {
      refused += FORMATTER_NAME.test(name) ? 0 : 1;
      continue;
    }
    const previous = entries[name];
    entries[name] = {
      ...previous,
      ...admitted.entry,
      ...(previous?.environment === undefined && admitted.entry.environment === undefined
        ? {}
        : { environment: { ...previous?.environment, ...admitted.entry.environment } }),
    };
  }
  const kept = Object.entries(entries).slice(0, MAX_ENTRIES);
  return {
    entries: Object.fromEntries(kept),
    refused: refused + Object.keys(entries).length - kept.length,
  };
}

/**
 * The `formatter` value the server-owned binding carries (#3900 AC4). Only Full access runs a
 * formatter at all; there the user's global and the project's own configuration select built-ins,
 * override them and add custom formatters exactly as in standalone OpenCode, and with no
 * configuration the built-ins run (`true`). Every other mode stays `false`, whatever is configured.
 */
export function openCodeNativeFormatterAdmission(
  disposition: OpenCodeNativeFormatterDisposition,
  documents: readonly Readonly<Record<string, unknown>>[] = [],
): OpenCodeNativeFormatterAdmission {
  if (disposition !== "enabled") return { value: false, entryCount: 0, refusedCount: 0 };
  const merged = mergedFormatterSetting(documents);
  const value = merged.value ?? true;
  return {
    value,
    entryCount: typeof value === "object" ? Object.keys(value).length : 0,
    refusedCount: merged.refused,
  };
}
