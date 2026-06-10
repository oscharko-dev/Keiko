"use client";

// Issue #147 — Modality-aware attachment intake and UI validation.
//
// This module owns all client-side attachment UI:
//   - AttachButton    : the paperclip button in the composer bar
//   - AttachDropZone  : drag-and-drop surface above the textarea
//   - AttachmentChip  : one chip per pending attachment (thumbnail + name + remove)
//   - AttachmentStrip : the horizontal chip row rendered below the textarea
//
// Server-side enforcement is deferred to issue #149.
// NEVER store or display File.path / webkitRelativePath (AC #4).

import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Icons } from "./Icons";
import type {
  AttachmentRejectionReason,
  PendingAttachment,
  SentDocumentDisclosure,
} from "./hooks/useChatSession";
import type { ModelCapability } from "@/lib/types";

// ─── Human-readable rejection messages (AC #2) ────────────────────────────────

export function rejectionMessage(reason: AttachmentRejectionReason, mimeType?: string): string {
  switch (reason) {
    case "text-only-model":
      // ATT-F3: a single accurate message covers both image and document
      // rejections (the prior copy always said "image input" even for documents).
      return "The selected model can't accept this attachment type. Choose a model that supports images or documents.";
    case "unsupported-type":
      return `Unsupported file type${mimeType !== undefined && mimeType.length > 0 ? `: ${mimeType}` : ""}. Supported types: images (image/*), PDF, plain text, markdown, JSON, YAML.`;
    case "oversized":
      return "File is larger than the 8 MiB limit. Choose a smaller file or summarize the content as text.";
    case "empty":
      return "Empty file. Add a file with content to attach.";
  }
}

// ─── Derived accept string from model capabilities ─────────────────────────────

export function buildAcceptString(model: ModelCapability | undefined): string {
  if (model === undefined) return "";
  const parts: string[] = [];
  if (model.supportsImageInput) parts.push("image/*");
  if (model.supportsDocumentInput) parts.push(".pdf,.txt,.md,.csv,.json,.yaml,.yml");
  return parts.join(",");
}

// ─── Formatters ────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}

function truncateName(name: string, max = 32): string {
  if (name.length <= max) return name;
  const ext = name.lastIndexOf(".");
  if (ext > 0 && name.length - ext <= 8) {
    const extPart = name.slice(ext);
    return `${name.slice(0, max - extPart.length - 1)}…${extPart}`;
  }
  return `${name.slice(0, max - 1)}…`;
}

// ─── AttachmentChip ────────────────────────────────────────────────────────────

interface AttachmentChipProps {
  readonly attachment: PendingAttachment;
  readonly onRemove: (id: string) => void;
}

function AttachmentChip({ attachment, onRemove }: AttachmentChipProps): ReactNode {
  const label = `Remove attachment ${attachment.name}`;
  const displayName = truncateName(attachment.name);

  return (
    <div className="attach-chip" role="listitem">
      {attachment.kind === "image" && attachment.previewDataUrl !== undefined ? (
        // Thumbnail: capped at 40×40 via CSS. Decorative — the filename renders as
        // adjacent text, so alt="" (uiux-fix F040 C320: the previous alt={name} +
        // aria-hidden="true" combination was contradictory ARIA; AC #4 — no path).
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={attachment.previewDataUrl}
          alt=""
          className="attach-chip-thumb"
          width={40}
          height={40}
        />
      ) : (
        <span className="attach-chip-icon" aria-hidden="true">
          <Icons.file size={16} />
        </span>
      )}
      <span className="attach-chip-name" title={attachment.name}>
        {displayName}
      </span>
      <span className="attach-chip-size">{formatBytes(attachment.sizeBytes)}</span>
      <button
        type="button"
        className="attach-chip-remove"
        aria-label={label}
        onClick={() => onRemove(attachment.id)}
      >
        <Icons.close size={12} />
      </button>
    </div>
  );
}

// ─── AttachmentStrip ────────────────────────────────────────────────────────────

interface AttachmentStripProps {
  readonly attachments: readonly PendingAttachment[];
  readonly onRemove: (id: string) => void;
}

export function AttachmentStrip({ attachments, onRemove }: AttachmentStripProps): ReactNode {
  if (attachments.length === 0) return null;
  return (
    <div className="attach-strip" role="list" aria-label="Pending attachments">
      {attachments.map((a) => (
        <AttachmentChip key={a.id} attachment={a} onRemove={onRemove} />
      ))}
    </div>
  );
}

// ─── AttachDropZone ────────────────────────────────────────────────────────────

interface AttachDropZoneProps {
  readonly enabled: boolean;
  readonly onFiles: (files: readonly File[]) => void;
}

export function AttachDropZone({ enabled, onFiles }: AttachDropZoneProps): ReactNode {
  const [dragOver, setDragOver] = useState(false);

  // uiux-fix F040 C207 — the zone is revealed only while a file drag is in
  // progress somewhere in the window; previously it rendered as a permanently
  // visible empty dashed band. Window-level dragenter/dragleave with a depth
  // counter (entering a child fires dragleave on its parent) detects the drag;
  // drop or dragend anywhere resets it.
  const [dragActive, setDragActive] = useState(false);
  useEffect(() => {
    if (!enabled) return undefined;
    let depth = 0;
    const hasFiles = (event: globalThis.DragEvent): boolean =>
      Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const handleWindowDragEnter = (event: globalThis.DragEvent): void => {
      if (!hasFiles(event)) return;
      depth += 1;
      setDragActive(true);
    };
    const handleWindowDragLeave = (): void => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragActive(false);
    };
    const reset = (): void => {
      depth = 0;
      setDragActive(false);
    };
    window.addEventListener("dragenter", handleWindowDragEnter);
    window.addEventListener("dragleave", handleWindowDragLeave);
    window.addEventListener("drop", reset);
    window.addEventListener("dragend", reset);
    return () => {
      window.removeEventListener("dragenter", handleWindowDragEnter);
      window.removeEventListener("dragleave", handleWindowDragLeave);
      window.removeEventListener("drop", reset);
      window.removeEventListener("dragend", reset);
    };
  }, [enabled]);

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!enabled) return;
      event.preventDefault();
      setDragOver(true);
    },
    [enabled],
  );

  const handleDragLeave = useCallback(() => {
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragOver(false);
      if (!enabled) return;
      const files = Array.from(event.dataTransfer.files);
      if (files.length > 0) onFiles(files);
    },
    [enabled, onFiles],
  );

  // uiux-fix F040 C207 — no permanent "Attachments not supported" band: the
  // disabled state is already communicated by the attach button's tooltip and
  // its sr-only hint, so the zone simply does not render.
  if (!enabled) return null;

  return (
    <div
      className="attach-drop-zone"
      data-dragover={dragOver ? "true" : undefined}
      data-active={dragActive ? "true" : "false"}
      // uiux-fix F040 C320 — decorative drag target: the previous
      // role="presentation" + aria-label combination was prohibited ARIA, and
      // drag-and-drop has no screen-reader affordance anyway — the accessible
      // attach path is the AttachButton file picker.
      aria-hidden="true"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <span className="attach-drop-hint">Drop files here to attach</span>
    </div>
  );
}

// ─── AttachButton ────────────────────────────────────────────────────────────

// Stable ids for aria-describedby chains.
const ATTACH_DISABLED_HINT_ID = "cmp-attach-disabled-hint";

interface AttachButtonProps {
  readonly model: ModelCapability | undefined;
  readonly onFiles: (files: readonly File[]) => void;
  /**
   * uiux-fix F040 C207 — whether ANY configured model supports attachments.
   * When false, the sr-only hint must not suggest switching models (there is
   * no model the user could switch to). Defaults to true for callers that do
   * not know the full model list.
   */
  readonly anyModelSupportsAttachments?: boolean;
}

export function AttachButton({
  model,
  onFiles,
  anyModelSupportsAttachments = true,
}: AttachButtonProps): ReactNode {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const supportsAny =
    model !== undefined && (model.supportsImageInput || model.supportsDocumentInput);
  const accept = buildAcceptString(model);

  const handleClick = useCallback(() => {
    if (!supportsAny) return;
    fileInputRef.current?.click();
  }, [supportsAny]);

  const handleChange = useCallback(() => {
    const files = Array.from(fileInputRef.current?.files ?? []);
    if (files.length > 0) {
      onFiles(files);
      // Reset the input so the same file can be re-attached after removal.
      if (fileInputRef.current !== null) fileInputRef.current.value = "";
    }
  }, [onFiles]);

  return (
    <>
      {/* Visually-hidden hint so screen readers discover why the button is disabled */}
      {!supportsAny ? (
        <span id={ATTACH_DISABLED_HINT_ID} className="sr-only">
          {anyModelSupportsAttachments
            ? "The selected model does not support image or document input. Choose a different model to attach files."
            : "The selected model does not support image or document input. No configured model currently supports attachments."}
        </span>
      ) : null}
      {/* Hidden file input — triggered imperatively by the button */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={accept}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={handleChange}
      />
      <button
        type="button"
        className="cmp-icon"
        aria-label="Attach file"
        aria-disabled={!supportsAny ? "true" : undefined}
        aria-describedby={!supportsAny ? ATTACH_DISABLED_HINT_ID : undefined}
        title={supportsAny ? "Attach file" : "Attachments not supported by this model"}
        onClick={handleClick}
      >
        <Icons.files size={16} />
      </button>
    </>
  );
}

// ─── AttachRejectionAlert ────────────────────────────────────────────────────

interface AttachRejectionAlertProps {
  readonly reason: AttachmentRejectionReason | undefined;
  readonly mimeType?: string | undefined;
}

export function AttachRejectionAlert({ reason, mimeType }: AttachRejectionAlertProps): ReactNode {
  if (reason === undefined) return null;
  return (
    <div role="alert" className="attach-rejection-alert">
      {rejectionMessage(reason, mimeType)}
    </div>
  );
}

// ─── SentDocumentsNote (Issue #148) ───────────────────────────────────────────
//
// After a send that included attached documents, discloses which documents contributed
// extracted context and whether any was truncated to fit the bounded context budget. Only the
// basename is shown — never a path (AC #4 of #147). Rendered inside the role="log" conversation
// container, which already announces additions politely — a nested role="status" live region
// here would double-announce the same information (uiux-fix F040 C167), so this is a plain
// labelled note.

interface SentDocumentsNoteProps {
  readonly documents: readonly SentDocumentDisclosure[];
}

export function SentDocumentsNote({ documents }: SentDocumentsNoteProps): ReactNode {
  if (documents.length === 0) return null;
  const anyTruncated = documents.some((doc) => doc.truncated);
  return (
    <div role="note" className="sent-docs-note" aria-label="Documents included as context">
      <span className="sent-docs-note-label">
        {documents.length === 1
          ? "Document included as context:"
          : "Documents included as context:"}
      </span>
      <ul className="sent-docs-note-list">
        {documents.map((doc) => (
          <li key={doc.id} className="sent-docs-note-item">
            {doc.displayName}
            {doc.truncated ? <span className="sent-docs-note-trunc"> (truncated)</span> : null}
          </li>
        ))}
      </ul>
      {anyTruncated ? (
        <span className="sent-docs-note-hint">
          Some document text was truncated to fit the context limit.
        </span>
      ) : null}
    </div>
  );
}
