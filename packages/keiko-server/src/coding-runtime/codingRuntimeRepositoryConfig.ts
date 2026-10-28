import ts from "typescript";
import {
  isRepositoryItemAuthorityKey,
  type RepositoryItemRefusalReason,
} from "./codingRuntimeRepositoryItemSanitizer.js";

/**
 * The project's own `opencode.json` (#3903 AC2). The producer's project layer stays off, because it
 * would also import plugin modules and merge providers, permissions and MCP servers from repository
 * text. Keiko reads the file itself through the secure workspace read and admits exactly what the
 * Markdown items already admit: the agents and commands it defines become the same Markdown
 * items, re-rendered and sanitized by `codingRuntimeRepositoryItemSanitizer.ts` and written as copies
 * in the run's private discovery directory. Every other key, and every key of an entry that could
 * register authority, route a model or load code, is dropped and counted. An agent whose own
 * permission or tool restrictions cannot be carried is refused rather than admitted unrestricted.
 * JSONC uses the existing TypeScript dependency's configuration parser; any diagnostic refuses the
 * entire document, including a partial parse. Both filename extensions use the same diagnostically strict parser.
 */
export const PROJECT_CONFIG_FILES = [
  "opencode.json",
  "opencode.jsonc",
  ".opencode/opencode.json",
  ".opencode/opencode.jsonc",
] as const;

export type ProjectConfigItemKind = "agent" | "command";

export interface ProjectConfigItem {
  readonly kind: ProjectConfigItemKind;
  readonly name: string;
  /** The entry as a Markdown item: JSON-quoted scalar frontmatter, then its prompt or template. */
  readonly text: string;
}

export type ProjectConfigItems =
  | {
      readonly ok: true;
      readonly items: readonly ProjectConfigItem[];
      readonly refused: readonly {
        readonly kind: ProjectConfigItemKind;
        readonly reason: RepositoryItemRefusalReason;
      }[];
      readonly strippedAuthorityKeyCount: number;
      readonly strippedOtherKeyCount: number;
    }
  | { readonly ok: false; readonly reason: RepositoryItemRefusalReason };

interface SectionShape {
  readonly kind: ProjectConfigItemKind;
  /** The entry key whose text becomes the item's body. */
  readonly body: string;
}

/**
 * The 2.1.4 producer reads both configuration shapes: the current `agents` (prompt in `system`)
 * and `commands`, and the earlier `agent` (prompt in `prompt`) and `command` it still migrates.
 */
const SECTIONS: ReadonlyMap<string, SectionShape> = new Map([
  ["agents", { kind: "agent", body: "system" }],
  ["agent", { kind: "agent", body: "prompt" }],
  ["commands", { kind: "command", body: "template" }],
  ["command", { kind: "command", body: "template" }],
]);
/** Restrictions the Markdown form carries only in its own syntax: refused, never dropped. */
const RESTRICTION_KEYS: ReadonlySet<string> = new Set(["permission", "permissions", "tools"]);
/** Top-level keys that would register authority, executable effects or configuration owned by Keiko. */
const TOP_LEVEL_AUTHORITY_KEYS: ReadonlySet<string> = new Set([
  "plugins",
  "plugin",
  "permissions",
  "permission",
  "providers",
  "provider",
  "mcp",
  "model",
  "small_model",
  "default_agent",
  "instructions",
  "references",
  "tools",
  "formatter",
  "lsp",
  "share",
  "update",
  "policies",
  "skills",
  "experimental",
  "compatibility",
]);

export function projectConfigItems(
  text: string,
  format: "json" | "jsonc" = "json",
): ProjectConfigItems {
  const document = parsedProjectConfigObject(text, format);
  if (document === undefined) return { ok: false, reason: "config-malformed" };
  const items: ProjectConfigItem[] = [];
  const refused: { kind: ProjectConfigItemKind; reason: RepositoryItemRefusalReason }[] = [];
  let authority = 0;
  let other = 0;
  for (const [key, value] of Object.entries(document)) {
    const shape = SECTIONS.get(key);
    if (shape === undefined) {
      if (key === "$schema") continue;
      if (TOP_LEVEL_AUTHORITY_KEYS.has(key)) authority += 1;
      else other += 1;
      continue;
    }
    const section = sectionEntries(shape, value);
    items.push(...section.items);
    refused.push(...section.refused);
    authority += section.strippedAuthority;
    other += section.strippedOther;
  }
  return {
    ok: true,
    items,
    refused,
    strippedAuthorityKeyCount: authority,
    strippedOtherKeyCount: other,
  };
}

export function parsedProjectConfigObject(
  text: string,
  format: "json" | "jsonc" = "json",
): Readonly<Record<string, unknown>> | undefined {
  // Both known producer filenames accept JSONC; parse text only, with no filesystem discovery.
  try {
    const parsed = ts.parseConfigFileTextToJson(`opencode.${format}`, text);
    const value: unknown = parsed.config;
    return parsed.error === undefined && onlyPlainObjects(value) ? plainObject(value) : undefined;
  } catch (error: unknown) {
    if (error instanceof RangeError) return undefined;
    throw error;
  }
}

/** The compiler parser may assign __proto__; configuration can carry own JSON data only. */
function onlyPlainObjects(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current !== "object" || current === null) continue;
    if (!Array.isArray(current) && Object.getPrototypeOf(current) !== Object.prototype)
      return false;
    for (const entry of Object.values(current as Readonly<Record<string, unknown>>))
      pending.push(entry);
  }
  return true;
}

function plainObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

interface Section {
  readonly items: ProjectConfigItem[];
  readonly refused: { kind: ProjectConfigItemKind; reason: RepositoryItemRefusalReason }[];
  strippedAuthority: number;
  strippedOther: number;
}

function sectionEntries(shape: SectionShape, value: unknown): Section {
  const { kind } = shape;
  const section: Section = { items: [], refused: [], strippedAuthority: 0, strippedOther: 0 };
  const entries = plainObject(value);
  if (entries === undefined) {
    section.refused.push({ kind, reason: "value-invalid" });
    return section;
  }
  for (const [name, entry] of Object.entries(entries)) {
    const fields = plainObject(entry);
    if (fields === undefined) section.refused.push({ kind, reason: "value-invalid" });
    else entryItem(shape, name, fields, section);
  }
  return section;
}

// Scalars become JSON-quoted frontmatter the sanitizer reads as YAML double-quoted strings; the
// sanitizer then keeps only its own allowlist and counts the rest, as for a Markdown item.
function entryItem(
  shape: SectionShape,
  name: string,
  fields: Readonly<Record<string, unknown>>,
  section: Section,
): void {
  const { kind } = shape;
  if (kind === "agent" && Object.keys(fields).some((key) => RESTRICTION_KEYS.has(key))) {
    section.refused.push({ kind, reason: "restriction-unrepresentable" });
    return;
  }
  const body = fields[shape.body];
  if (typeof body !== "string") {
    section.refused.push({ kind, reason: "body-empty" });
    return;
  }
  const frontmatter: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (key === shape.body) continue;
    const scalar = scalarOf(value);
    if (scalar !== undefined && /^[a-z_][a-z0-9_-]{0,63}$/u.test(key))
      frontmatter.push(`${key}: ${scalar}`);
    else if (isRepositoryItemAuthorityKey(key)) section.strippedAuthority += 1;
    else section.strippedOther += 1;
  }
  section.items.push({
    kind,
    name,
    text: ["---", ...frontmatter, "---", body].join("\n"),
  });
}

function scalarOf(value: unknown): string | undefined {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return undefined;
}
