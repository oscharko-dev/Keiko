import { createHash } from "node:crypto";
import type {
  EditorAgentChangeset,
  EditorAgentChangesetFile,
} from "@oscharko-dev/keiko-contracts/editor-agent";
import { lineDiffSide, unifiedDiffHunks } from "../gitDelivery/lineDiff.js";
import type { SecureWorkspaceTextReadPort } from "./secureWorkspaceTextRead.js";

/**
 * Exact-text replacement edits for `keiko_changeset_edit` (#3873). A strict unified diff asks the
 * model for exact hunk headers, line numbers and context; in the live Gemma qualification two of
 * three such patches were refused as INVALID_EDITS even after tool text reached the model verbatim.
 * A replacement names the exact current text and its successor instead, the edit form coding agents
 * are trained on. It is materialized here, against the hash-bound current file, into the same
 * unified-diff changeset the governed editor path already validates, reviews and applies: no second
 * mutation path, no weaker precondition.
 */
export interface CodingToolReplacementEdit {
  readonly file: string;
  readonly oldString: string;
  readonly newString: string;
  readonly replaceAll?: boolean | undefined;
}

export interface CodingToolReplacementChangeset {
  readonly edits: readonly CodingToolReplacementEdit[];
  readonly files: readonly EditorAgentChangesetFile[];
  readonly selectedFiles?: readonly string[] | undefined;
}

export type ReplacementRefusalCode =
  "INVALID_EDITS" | "CONTENT_HASH_MISMATCH" | "PRECONDITION_REQUIRED";

export type ReplacementMaterialization =
  | { readonly status: "materialized"; readonly changeset: EditorAgentChangeset }
  | {
      readonly status: "refused";
      readonly reasonCode: ReplacementRefusalCode;
      readonly message: string;
    }
  | { readonly status: "read-failed" };

type Refusal = Extract<ReplacementMaterialization, { readonly status: "refused" }>;

type FileOutcome =
  | {
      readonly status: "changed";
      readonly section: string;
      readonly binding: EditorAgentChangesetFile;
    }
  | Refusal
  | { readonly status: "read-failed" };

type ApplyOutcome = { readonly status: "applied"; readonly content: string } | Refusal;

export function isReplacementChangeset(
  changeset: EditorAgentChangeset | CodingToolReplacementChangeset,
): changeset is CodingToolReplacementChangeset {
  return "edits" in changeset;
}

/** The bytes a changeset carries for the run's patch budget, in either edit form. */
export function changesetPayloadBytes(
  changeset: EditorAgentChangeset | CodingToolReplacementChangeset,
): number {
  if (!isReplacementChangeset(changeset)) return Buffer.byteLength(changeset.patch, "utf8");
  return changeset.edits.reduce(
    (total, edit) =>
      total + Buffer.byteLength(edit.oldString, "utf8") + Buffer.byteLength(edit.newString, "utf8"),
    0,
  );
}

/** Applies every replacement to its file's current, hash-bound text and renders the unified diff. */
export async function materializeReplacementChangeset(
  read: SecureWorkspaceTextReadPort,
  changeset: CodingToolReplacementChangeset,
  signal: AbortSignal | undefined,
): Promise<ReplacementMaterialization> {
  const sections: string[] = [];
  const bindings: EditorAgentChangesetFile[] = [];
  for (const [file, edits] of editsByFile(changeset.edits)) {
    const outcome = await materializeFile(read, changeset.files, file, edits, signal);
    if (outcome.status !== "changed") return outcome;
    sections.push(outcome.section);
    bindings.push(outcome.binding);
  }
  const edited = new Set(bindings.map((binding) => binding.file));
  const selected = changeset.selectedFiles?.filter((file) => edited.has(file)) ?? [];
  return {
    status: "materialized",
    changeset: {
      patch: sections.join(""),
      files: bindings,
      selectedFiles: selected.length > 0 ? selected : [...edited],
    },
  };
}

function editsByFile(
  edits: readonly CodingToolReplacementEdit[],
): ReadonlyMap<string, readonly CodingToolReplacementEdit[]> {
  const grouped = new Map<string, CodingToolReplacementEdit[]>();
  for (const edit of edits) {
    const existing = grouped.get(edit.file);
    if (existing === undefined) grouped.set(edit.file, [edit]);
    else existing.push(edit);
  }
  return grouped;
}

async function materializeFile(
  read: SecureWorkspaceTextReadPort,
  files: readonly EditorAgentChangesetFile[],
  file: string,
  edits: readonly CodingToolReplacementEdit[],
  signal: AbortSignal | undefined,
): Promise<FileOutcome> {
  const expectedContentHash = files.find(
    (candidate) => candidate.file === file,
  )?.expectedContentHash;
  if (expectedContentHash === undefined) {
    return refused(
      "PRECONDITION_REQUIRED",
      `List ${file} in files with the digest from its latest keiko_workspace_read.`,
    );
  }
  const current = await currentText(read, file, expectedContentHash, signal);
  if (!("before" in current)) return current;
  const applied = applyEdits(file, current.before, edits);
  if (applied.status !== "applied") return applied;
  if (applied.content === (current.before ?? "")) {
    return refused("INVALID_EDITS", `The edits leave ${file} unchanged.`);
  }
  return {
    status: "changed",
    section: unifiedDiffSection(file, current.before, applied.content),
    binding: { file, expectedContentHash },
  };
}

// The hash-bound current text of a file: `undefined` for a file that does not exist yet.
async function currentText(
  read: SecureWorkspaceTextReadPort,
  file: string,
  expectedContentHash: string,
  signal: AbortSignal | undefined,
): Promise<{ readonly before: string | undefined } | Refusal | { readonly status: "read-failed" }> {
  const current = await read.readText({ relativePath: file, signal });
  if (!current.ok && current.reason !== "not-found") return { status: "read-failed" };
  const before = current.ok ? current.text : undefined;
  if (sha256(before ?? "") !== expectedContentHash) {
    return refused(
      "CONTENT_HASH_MISMATCH",
      `${file} changed since the read that produced its digest; re-read it before editing.`,
    );
  }
  return { before };
}

function applyEdits(
  file: string,
  before: string | undefined,
  edits: readonly CodingToolReplacementEdit[],
): ApplyOutcome {
  let content = before;
  for (const [index, edit] of edits.entries()) {
    const next = applyEdit(file, content, edit, index === 0);
    if (next.status !== "applied") return next;
    content = next.content;
  }
  return { status: "applied", content: content ?? "" };
}

function applyEdit(
  file: string,
  content: string | undefined,
  edit: CodingToolReplacementEdit,
  first: boolean,
): ApplyOutcome {
  if (edit.oldString === "") {
    return first && (content === undefined || content === "")
      ? { status: "applied", content: edit.newString }
      : refused(
          "INVALID_EDITS",
          `An empty oldString only creates a new file; ${file} has content.`,
        );
  }
  if (content === undefined) {
    return refused("INVALID_EDITS", `${file} does not exist; create it with an empty oldString.`);
  }
  if (edit.oldString === edit.newString) {
    return refused("INVALID_EDITS", `oldString and newString are identical for ${file}.`);
  }
  return replaceIn(file, content, edit);
}

function replaceIn(file: string, content: string, edit: CodingToolReplacementEdit): ApplyOutcome {
  const located = locate(content, edit);
  if (located.count === 0) {
    return refused(
      "INVALID_EDITS",
      `oldString was not found in ${file}; copy the exact current text from a fresh read.`,
    );
  }
  if (located.count > 1 && edit.replaceAll !== true) {
    return refused(
      "INVALID_EDITS",
      `oldString matches ${String(located.count)} places in ${file}; add surrounding lines or set replaceAll.`,
    );
  }
  if (edit.replaceAll === true) {
    return { status: "applied", content: content.split(located.oldText).join(located.newText) };
  }
  const at = content.indexOf(located.oldText);
  return {
    status: "applied",
    content: content.slice(0, at) + located.newText + content.slice(at + located.oldText.length),
  };
}

// A model reads a CRLF file's lines without their carriage returns, so a replacement written with
// plain line breaks is matched against the CRLF form as well and keeps the file's line endings.
function locate(
  content: string,
  edit: CodingToolReplacementEdit,
): { readonly count: number; readonly oldText: string; readonly newText: string } {
  const count = occurrences(content, edit.oldString);
  if (count > 0 || !content.includes("\r\n") || !edit.oldString.includes("\n")) {
    return { count, oldText: edit.oldString, newText: edit.newString };
  }
  const oldText = withCrlf(edit.oldString);
  return { count: occurrences(content, oldText), oldText, newText: withCrlf(edit.newString) };
}

function occurrences(content: string, needle: string): number {
  let count = 0;
  let at = content.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = content.indexOf(needle, at + needle.length);
  }
  return count;
}

function withCrlf(text: string): string {
  return text.replace(/\r?\n/gu, "\r\n");
}

function unifiedDiffSection(file: string, before: string | undefined, after: string): string {
  const header =
    before === undefined ? `--- /dev/null\n+++ b/${file}\n` : `--- a/${file}\n+++ b/${file}\n`;
  const hunks = unifiedDiffHunks(lineDiffSide(before ?? ""), lineDiffSide(after));
  return `${header}${hunks.join("\n")}\n`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function refused(reasonCode: ReplacementRefusalCode, message: string): Refusal {
  return { status: "refused", reasonCode, message };
}
