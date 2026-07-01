// Shared document-relative offset bookkeeping for PDF extractors (Issue #1286).
//
// Pages are separated by "\n\n" (two characters) — the same separator the existing full-buffer
// PDF parser used (`pageTexts.join("\n\n")`) — so chunk character offsets stay aligned with the
// persisted normalized text regardless of whether a document was extracted in one pass or window
// by window. Empty pages still emit PageRecords, but do not append searchable text.

import type { DocumentId, PageRecord, ParsedUnit } from "@oscharko-dev/keiko-contracts";

const PAGE_SEPARATOR = "\n\n";

export interface AddedPage {
  readonly page: PageRecord;
  readonly unit: ParsedUnit;
}

export class WindowTextBuilder {
  private readonly documentId: DocumentId;
  private cursor: number;
  private anyPageEmitted: boolean;
  private readonly windowStart: number;
  private appended = "";
  private readonly pages: PageRecord[] = [];
  private readonly units: ParsedUnit[] = [];

  constructor(documentId: DocumentId, cursor: number, anyPageEmitted: boolean) {
    this.documentId = documentId;
    this.cursor = cursor;
    this.anyPageEmitted = anyPageEmitted;
    this.windowStart = cursor;
  }

  addPage(pageNumber: number, pageText: string, pageLabel?: string): AddedPage {
    const hasText = pageText.length > 0;
    if (hasText && this.anyPageEmitted) {
      this.appended += PAGE_SEPARATOR;
      this.cursor += PAGE_SEPARATOR.length;
    }
    const characterStart = this.cursor;
    const characterEnd = characterStart + pageText.length;
    if (hasText) {
      this.appended += pageText;
      this.cursor = characterEnd;
      this.anyPageEmitted = true;
    }
    const page: PageRecord = {
      documentId: this.documentId,
      pageNumber,
      pageLabel: pageLabel ?? String(pageNumber),
      characterStart,
      characterEnd,
    };
    const unit: ParsedUnit = {
      kind: "page",
      documentId: this.documentId,
      pageNumber,
      pageLabel: pageLabel ?? String(pageNumber),
      characterStart,
      characterEnd,
    };
    this.pages.push(page);
    this.units.push(unit);
    return { page, unit };
  }

  get pageCount(): number {
    return this.pages.length;
  }

  get nextCursor(): number {
    return this.cursor;
  }

  get hasEmittedAnyPage(): boolean {
    return this.anyPageEmitted;
  }

  get characterStart(): number {
    return this.windowStart;
  }

  snapshotPages(): readonly PageRecord[] {
    return this.pages;
  }

  snapshotUnits(): readonly ParsedUnit[] {
    return this.units;
  }

  text(): string {
    return this.appended;
  }
}
