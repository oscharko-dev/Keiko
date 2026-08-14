/**
 * Patch-preview model adapter (Issue #1195).
 *
 * Converts a host-supplied generated patch ({@link EditorPreviewedPatch} / {@link
 * EditorGeneratedPatch}, the frozen #1192 contract) plus the original buffer contents into a flat,
 * render-only {@link PatchPreviewModel} the {@link import("./components/KeikoDiffEditor.js")
 * .KeikoDiffEditor} renders as original/modified pairs. It is pure and browser-safe: it applies the
 * patch's `{range, newText}` edits to the original text in memory ({@link applyTextEditsToText}) and
 * never writes to disk, never validates against a workspace, and never calls a Node-domain patch
 * tool. Server-side patch parsing/validation/application stay where they belong (`keiko-tools`,
 * reached only through host ports); this adapter is the editor's display projection of an
 * already-structured patch (ADR-0042 D2/D7).
 *
 * Bounding (AC5): the model caps the number of files, the bytes rendered per file, and the total
 * bytes across the patch, and reports exactly what was truncated or omitted so a large patch never
 * silently overflows the review surface.
 */
import type { FileContent } from "@oscharko-dev/keiko-contracts";

import {
  applyTextEditsToTextWithinLimit,
  isOverlappingPatchEditError,
} from "./apply-text-edits.js";
import { inferMonacoLanguageId, type MonacoLanguageId } from "./monaco/language-inference.js";
import type {
  EditorGeneratedPatch,
  EditorOutputProvenance,
  EditorPatchFileChange,
  EditorPatchStatus,
  EditorPreviewedPatch,
  EditorVerificationRef,
} from "./types.js";

/**
 * The reviewable state of a single file in a patch.
 *
 * `created` / `modified` / `deleted` are renderable text diffs; `binary` and `unsupported` are not
 * diffable and carry a {@link PatchPreviewFile.note} explaining why (never the file content).
 */
export type PatchPreviewFileStatus = "created" | "modified" | "deleted" | "binary" | "unsupported";

/** The original (pre-patch) content of a file the host provides for diffing against. */
export interface PatchPreviewSource {
  /** The current workspace content, already redacted at the IO boundary (the editor never reads files). */
  readonly content: FileContent;
  /** Host signal that the file is non-text and cannot be diffed; also inferred from NUL bytes. */
  readonly binary?: boolean | undefined;
}

/** Bounds applied to a previewed patch so a large patch stays render-safe. */
export interface PatchPreviewLimits {
  /** Maximum number of files rendered; files beyond this are omitted and counted. */
  readonly maxFiles: number;
  /** Maximum bytes rendered per side of a single file; larger content is clamped and flagged. */
  readonly maxBytesPerFile: number;
  /** Maximum total bytes rendered across the whole patch; remaining files are omitted. */
  readonly maxTotalBytes: number;
}

/**
 * Defaults aligned with the existing review surface bounds (512 KB total / 400 files,
 * `keiko-ui` diff parser) and the editor's per-buffer limit (256 KB).
 */
export const DEFAULT_PATCH_PREVIEW_LIMITS: PatchPreviewLimits = {
  maxFiles: 400,
  maxBytesPerFile: 262_144,
  maxTotalBytes: 524_288,
};

/**
 * Truncation applied by whatever PRODUCED the patch, before this adapter ever saw it — a language
 * service that stopped selecting rename references at its result cap, or a provider that only
 * reports edits for the active document.
 *
 * This is NOT {@link PatchPreviewLimits}. The display caps hide changes the host will still apply,
 * whereas the changes counted here are absent from the patch entirely, so applying it performs only
 * part of the requested operation. Carrying the producer's counts into the model is what stops a
 * capped result from rendering as a whole one: a preview derived only from the RETURNED changes is
 * internally consistent, and therefore indistinguishable from a complete patch.
 */
export interface PatchPreviewSourceTruncation {
  /** The producer's own verdict, honoured even when the counts below happen to agree. */
  readonly truncated: boolean;
  /** Changed files present in the patch. */
  readonly returnedFileCount: number;
  /** Changed files the producer found for the requested operation. */
  readonly totalFileCount: number;
  /** Edits present in the patch. */
  readonly returnedEditCount: number;
  /** Edits the producer found for the requested operation. */
  readonly totalEditCount: number;
  /** Files counted in `totalFileCount` whose content could not be read, so they carry no edits. */
  readonly unreadableFileCount: number;
}

/** True when the producer did not return the whole operation. Fails closed: any signal counts. */
export function isPatchSourceTruncated(source: PatchPreviewSourceTruncation): boolean {
  return (
    source.truncated ||
    source.unreadableFileCount > 0 ||
    source.returnedFileCount < source.totalFileCount ||
    source.returnedEditCount < source.totalEditCount
  );
}

export interface BuildPatchPreviewInput {
  readonly patch: EditorPreviewedPatch | EditorGeneratedPatch;
  /** Original content keyed by {@link EditorPatchFileChange.uri}; required for modified/deleted files. */
  readonly sources?: Readonly<Record<string, PatchPreviewSource>> | undefined;
  readonly limits?: Partial<PatchPreviewLimits> | undefined;
  /** What the patch's producer already dropped; omit when the producer reports no bounding. */
  readonly sourceTruncation?: PatchPreviewSourceTruncation | undefined;
}

export interface PatchPreviewFile {
  readonly uri: string;
  /** Display path (the source's redacted relative path, or the URI when no source is available). */
  readonly displayPath: string;
  readonly status: PatchPreviewFileStatus;
  /** True for text statuses that the diff editor can render (`created`/`modified`/`deleted`). */
  readonly diffable: boolean;
  /** Original (left) text; empty for created/binary/unsupported. */
  readonly original: string;
  /** Modified (right) text; empty for deleted/binary/unsupported. */
  readonly modified: string;
  /** Monaco language id for syntax highlighting both sides. */
  readonly language: MonacoLanguageId;
  /** Whether the two sides differ (gates next/previous-diff navigation). */
  readonly hasChanges: boolean;
  /** True when content was clamped to {@link PatchPreviewLimits.maxBytesPerFile}. */
  readonly truncated: boolean;
  /** Reason a file is not diffable or was clamped; never contains file content. */
  readonly note?: string | undefined;
}

export interface PatchPreviewModel {
  readonly patchId: string;
  readonly status: EditorPatchStatus;
  /** Content-free metadata for the generated output behind this review model. */
  readonly provenance: EditorOutputProvenance;
  /** Optional verification metadata carried by the generated patch contract. */
  readonly verification?: EditorVerificationRef | undefined;
  readonly files: readonly PatchPreviewFile[];
  /** Files included in {@link PatchPreviewModel.files}. */
  readonly fileCount: number;
  /** Files in the patch before the {@link PatchPreviewLimits.maxFiles}/total-bytes caps. */
  readonly totalFileCount: number;
  /** Files dropped by the caps (`totalFileCount - fileCount`). */
  readonly omittedFileCount: number;
  readonly createdCount: number;
  readonly modifiedCount: number;
  readonly deletedCount: number;
  readonly binaryCount: number;
  readonly unsupportedCount: number;
  /**
   * What the patch's producer dropped before this model was built, as supplied by the host. Present
   * whenever the host reported it, truncated or not; ask {@link isPatchSourceTruncated} whether it
   * describes a missing change.
   */
  readonly sourceTruncation?: PatchPreviewSourceTruncation | undefined;
  /** True when any file was clamped, any file was omitted, or the producer's patch is incomplete. */
  readonly truncated: boolean;
}

const BINARY_NOTE = "Binary file — preview unavailable.";
const TRUNCATED_NOTE = "Content truncated to the display limit.";

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function containsNul(text: string): boolean {
  return text.includes("\u0000");
}

function isBinarySource(source: PatchPreviewSource | undefined): boolean {
  return source?.binary === true || (source !== undefined && containsNul(source.content.text));
}

/** Byte length of a single Unicode code point when encoded as UTF-8. */
function utf8ByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function clampToLimit(
  text: string,
  maxBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  if (maxBytes <= 0) {
    return { text: "", truncated: text.length > 0 };
  }

  let bytes = 0;
  let end = 0;
  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index) ?? 0;
    const codeUnits = codePoint > 0xffff ? 2 : 1;
    const nextBytes = utf8ByteLength(codePoint);
    if (bytes + nextBytes > maxBytes) {
      return { text: text.slice(0, end), truncated: true };
    }
    bytes += nextBytes;
    end = index + codeUnits;
    index += codeUnits;
  }
  return { text, truncated: false };
}

/**
 * Own-property-safe lookup of an original source by URI. A patch URI is host-supplied (and may be
 * AI-generated), so a prototype-chain key (`__proto__`, `constructor`, `toString`, …) must resolve to
 * `undefined` (treated as "no source"), never to an inherited `Object.prototype` member.
 */
function lookupSource(
  sources: Readonly<Record<string, PatchPreviewSource>>,
  uri: string,
): PatchPreviewSource | undefined {
  return Object.hasOwn(sources, uri) ? sources[uri] : undefined;
}

interface DiffSides {
  readonly status: PatchPreviewFileStatus;
  readonly diffable?: boolean | undefined;
  readonly original: string;
  readonly modified: string;
  readonly originalTruncated: boolean;
  readonly modifiedTruncated: boolean;
  readonly note?: string | undefined;
}

function modifiedSides(
  change: EditorPatchFileChange,
  source: PatchPreviewSource | undefined,
  maxBytesPerFile: number,
): DiffSides {
  if (source === undefined) {
    return {
      status: "unsupported",
      original: "",
      modified: "",
      originalTruncated: false,
      modifiedTruncated: false,
      note: "Original content unavailable — preview cannot be rendered.",
    };
  }
  if (source.content.truncated) {
    return {
      status: "unsupported",
      original: "",
      modified: "",
      originalTruncated: false,
      modifiedTruncated: false,
      note: "Original file is truncated — diff preview unavailable.",
    };
  }
  const original = source.content.text;
  try {
    const originalClamp = clampToLimit(original, maxBytesPerFile);
    const modified = applyTextEditsToTextWithinLimit(original, change.edits, maxBytesPerFile);
    return {
      status: "modified",
      original: originalClamp.text,
      modified: modified.text,
      originalTruncated: originalClamp.truncated,
      modifiedTruncated: modified.truncated,
    };
  } catch (error) {
    if (isOverlappingPatchEditError(error)) {
      return {
        status: "unsupported",
        original: "",
        modified: "",
        originalTruncated: false,
        modifiedTruncated: false,
        note: "Patch edits could not be applied to the original — preview unavailable.",
      };
    }
    throw error;
  }
}

function deletedSides(source: PatchPreviewSource | undefined, maxBytesPerFile: number): DiffSides {
  if (source === undefined) {
    return {
      status: "deleted",
      diffable: false,
      original: "",
      modified: "",
      originalTruncated: false,
      modifiedTruncated: false,
      note: "Original content unavailable — deleted-file preview cannot be rendered.",
    };
  }
  if (source.content.truncated) {
    return {
      status: "deleted",
      diffable: false,
      original: "",
      modified: "",
      originalTruncated: false,
      modifiedTruncated: false,
      note: "Original file is truncated — deleted-file preview unavailable.",
    };
  }
  const originalClamp = clampToLimit(source.content.text, maxBytesPerFile);
  return {
    status: "deleted",
    original: originalClamp.text,
    modified: "",
    originalTruncated: originalClamp.truncated,
    modifiedTruncated: false,
  };
}

function classifySides(
  change: EditorPatchFileChange,
  source: PatchPreviewSource | undefined,
  maxBytesPerFile: number,
): DiffSides {
  if (isBinarySource(source)) {
    return {
      status: "binary",
      original: "",
      modified: "",
      originalTruncated: false,
      modifiedTruncated: false,
      note: BINARY_NOTE,
    };
  }
  if (change.isDeletion) {
    return deletedSides(source, maxBytesPerFile);
  }
  if (change.isNewFile) {
    // The patch claims no prior content, but a host-supplied source can still disagree (e.g. the
    // producer's isNewFile flag is wrong, or `sources` was built for every referenced uri regardless
    // of the patch's own flags). Fail safe like deletedSides/modifiedSides rather than silently
    // discarding real content behind an empty-original "created" preview. A truncated source proves
    // a non-empty file exists even when the reported `text` slice is itself short or empty, so
    // truncation alone must trip this guard — only an untruncated empty-string source is a genuine
    // "nothing here yet" and still classifies as created.
    if (source !== undefined && (source.content.truncated || source.content.text !== "")) {
      return {
        status: "unsupported",
        original: "",
        modified: "",
        originalTruncated: false,
        modifiedTruncated: false,
        note: "Patch claims this is a new file, but existing content was found at this path — preview unavailable.",
      };
    }
    // Applying edits to an empty original cannot overlap (every position clamps to offset 0), so no
    // overlap guard is needed here — unlike the modified path, which diffs against real content.
    const modified = applyTextEditsToTextWithinLimit("", change.edits, maxBytesPerFile);
    return {
      status: "created",
      original: "",
      modified: modified.text,
      originalTruncated: false,
      modifiedTruncated: modified.truncated,
    };
  }
  return modifiedSides(change, source, maxBytesPerFile);
}

function buildFile(
  change: EditorPatchFileChange,
  source: PatchPreviewSource | undefined,
  maxBytesPerFile: number,
): PatchPreviewFile {
  const displayPath = source?.content.relativePath ?? change.uri;
  const sides = classifySides(change, source, maxBytesPerFile);
  const diffable = sides.diffable ?? (sides.status !== "binary" && sides.status !== "unsupported");
  const truncated = sides.originalTruncated || sides.modifiedTruncated;
  const note = truncated ? [sides.note, TRUNCATED_NOTE].filter(Boolean).join(" ") : sides.note;
  return {
    uri: change.uri,
    displayPath,
    status: sides.status,
    diffable,
    original: sides.original,
    modified: sides.modified,
    language: inferMonacoLanguageId(displayPath),
    hasChanges: diffable && sides.original !== sides.modified,
    truncated,
    note: note === undefined || note === "" ? undefined : note,
  };
}

interface Accumulator {
  readonly files: PatchPreviewFile[];
  totalBytes: number;
}

function withinTotalBudget(
  acc: Accumulator,
  file: PatchPreviewFile,
  maxTotalBytes: number,
): boolean {
  const fileBytes = byteLength(file.original) + byteLength(file.modified);
  // Always render at least the first file (clamped per-file) so a single huge file is not silently
  // dropped; subsequent files stop once the running total would exceed the budget.
  if (acc.files.length > 0 && acc.totalBytes + fileBytes > maxTotalBytes) {
    return false;
  }
  acc.totalBytes += fileBytes;
  return true;
}

function countStatus(files: readonly PatchPreviewFile[], status: PatchPreviewFileStatus): number {
  return files.filter((file) => file.status === status).length;
}

/** Build the render-only {@link PatchPreviewModel} from a generated patch and the original contents. */
export function buildPatchPreview(input: BuildPatchPreviewInput): PatchPreviewModel {
  const limits: PatchPreviewLimits = { ...DEFAULT_PATCH_PREVIEW_LIMITS, ...input.limits };
  const sources = input.sources ?? {};
  const totalFileCount = input.patch.changes.length;
  const acc: Accumulator = { files: [], totalBytes: 0 };

  for (const change of input.patch.changes) {
    if (acc.files.length >= limits.maxFiles) {
      break;
    }
    const file = buildFile(change, lookupSource(sources, change.uri), limits.maxBytesPerFile);
    if (!withinTotalBudget(acc, file, limits.maxTotalBytes)) {
      break;
    }
    acc.files.push(file);
  }

  const omittedFileCount = totalFileCount - acc.files.length;
  const sourceIncomplete =
    input.sourceTruncation !== undefined && isPatchSourceTruncated(input.sourceTruncation);
  return {
    patchId: input.patch.patchId,
    status: input.patch.status,
    provenance: input.patch.provenance,
    verification: input.patch.verification,
    files: acc.files,
    fileCount: acc.files.length,
    totalFileCount,
    omittedFileCount,
    createdCount: countStatus(acc.files, "created"),
    modifiedCount: countStatus(acc.files, "modified"),
    deletedCount: countStatus(acc.files, "deleted"),
    binaryCount: countStatus(acc.files, "binary"),
    unsupportedCount: countStatus(acc.files, "unsupported"),
    sourceTruncation: input.sourceTruncation,
    truncated: sourceIncomplete || omittedFileCount > 0 || acc.files.some((file) => file.truncated),
  };
}
