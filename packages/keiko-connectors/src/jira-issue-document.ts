// Jira issue → one logical retrievable document (Issue #2243, Epic #2238, ADR-0128 D5).
//
// Composes exactly one citable document per issue from hostile Jira Cloud REST v3 payloads:
//
//   - Title `KEY: summary` — the citation display name downstream.
//   - Body: a structured-metadata line (status/type/priority/assignee/labels/estimates/
//     parent/subtasks/links — retrievable text), the ADF-converted description, and every comment
//     in order under an `author — created` header line. All text is converted by the
//     deterministic, model-free `convertAdfToText` and HTML-escaped into the ONE shared HTML
//     envelope the existing keiko-local-knowledge parser already indexes — no second parsing
//     path and no ADF→HTML rendering.
//   - Structured citation metadata: the `JiraIssueCitationMetadata` contract shape (validated
//     fail-closed per field — a hostile field value is dropped, never carried), serialized with a
//     fixed key order so the same issue always produces byte-identical metadata JSON.
//   - Byte budget: the composed document is bounded by the lane's per-item cap. Overflow NEVER
//     cuts silently — the description tail and omitted comments are replaced by explicit
//     truncation marker lines, and the outcome reports `truncated` so the adapter can account
//     for it (the issue's engineering note: explicit marker + accounting, not a silent cut).
//
// The v1 mapping is metadata-only for relationships: parent/subtask/link KEYS are captured as
// citation metadata (community-feedback extension), with no graph modeling.

import {
  ATLASSIAN_CITATION_LIST_MAX_ENTRIES,
  ATLASSIAN_CITATION_METADATA_MAX_CHARS,
  isJiraIssueCitationMetadata,
  isSafeAtlassianIdentifier,
  isSafeJiraCitationFieldText,
  type JiraIssueCitationMetadata,
  type JiraIssueLinkRef,
} from "@oscharko-dev/keiko-contracts";
import { convertAdfToText, type AdfConversionOutcome } from "./adf-to-text.js";
import { ATLASSIAN_SYNC_ITEM_MAX_BYTES } from "./atlassian-sync-lane.js";

// The composed-document byte budget: the same per-item ceiling the sync lane enforces for every
// provider, so a Jira issue can never out-size a Confluence page.
export const JIRA_COMPOSED_DOCUMENT_MAX_BYTES = ATLASSIAN_SYNC_ITEM_MAX_BYTES;
// Reserved headroom so a truncation marker always fits inside the budget.
const TRUNCATION_RESERVE_BYTES = 256;
const MAX_TITLE_CHARS = 500;
const MAX_COMMENT_HEADER_FIELD_CHARS = 100;
const MAX_TIMESTAMP_CHARS = 64;

export const JIRA_DOCUMENT_TRUNCATION_MARKER = "[Truncated: item byte budget reached]";
const CONVERSION_TRUNCATION_MARKER = "[Content truncated: conversion limits reached]";
const UNREADABLE_CONTENT_MARKER = "[Content could not be converted]";

// ─── Hostile-JSON narrowing ────────────────────────────────────────────────────
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function namedField(value: unknown): string | undefined {
  return asString(asRecord(value)?.name);
}

// ─── Citation metadata (validated fail-closed, deterministic serialization) ───
// The provider `fields` request list that feeds `buildJiraIssueCitationMetadata` — the ONE
// source both the sync fetch (#2243, plus `description` for the document body) and the live
// search (#2248, plus `summary` only — live results carry no bodies) derive their field query
// from, so the sync and live mappings stay in parity by construction.
export const JIRA_ISSUE_METADATA_FIELDS =
  "status,issuetype,assignee,reporter,labels,priority,created,updated," +
  "resolution,timetracking,parent,subtasks,issuelinks";

function safeField(value: string | undefined): string | undefined {
  return value !== undefined && isSafeJiraCitationFieldText(value) ? value : undefined;
}

function safeKey(value: string | undefined): string | undefined {
  return value !== undefined && isSafeAtlassianIdentifier(value) ? value : undefined;
}

function safeKeyList(values: readonly unknown[]): readonly string[] | undefined {
  const keys = values
    .map((entry) => safeKey(asString(asRecord(entry)?.key)))
    .filter((key): key is string => key !== undefined)
    .slice(0, ATLASSIAN_CITATION_LIST_MAX_ENTRIES);
  return keys.length > 0 ? keys : undefined;
}

function safeLabelList(values: readonly unknown[]): readonly string[] | undefined {
  const labels = values
    .map((entry) => safeField(asString(entry)))
    .filter((label): label is string => label !== undefined)
    .slice(0, ATLASSIAN_CITATION_LIST_MAX_ENTRIES);
  return labels.length > 0 ? labels : undefined;
}

// Issue links carry a direction: an `outwardIssue` uses the link type's outward description
// ("blocks"), an `inwardIssue` its inward description ("is blocked by").
function linkedIssueRef(entry: unknown): JiraIssueLinkRef | undefined {
  const record = asRecord(entry);
  if (record === undefined) return undefined;
  const type = asRecord(record.type);
  const outwardKey = safeKey(asString(asRecord(record.outwardIssue)?.key));
  const inwardKey = safeKey(asString(asRecord(record.inwardIssue)?.key));
  const linkType = safeField(asString(outwardKey !== undefined ? type?.outward : type?.inward));
  const issueKey = outwardKey ?? inwardKey;
  if (issueKey === undefined || linkType === undefined) return undefined;
  return { linkType, issueKey };
}

function linkedIssueList(values: readonly unknown[]): readonly JiraIssueLinkRef[] | undefined {
  const links = values
    .map((entry) => linkedIssueRef(entry))
    .filter((link): link is JiraIssueLinkRef => link !== undefined)
    .slice(0, ATLASSIAN_CITATION_LIST_MAX_ENTRIES);
  return links.length > 0 ? links : undefined;
}

function scalarMetadataFields(
  fields: Record<string, unknown>,
): Omit<JiraIssueCitationMetadata, "issueKey" | "labels" | "subtaskKeys" | "linkedIssues"> {
  const timetracking = asRecord(fields.timetracking) ?? {};
  return {
    status: safeField(namedField(fields.status)),
    issueType: safeField(namedField(fields.issuetype)),
    assignee: safeField(asString(asRecord(fields.assignee)?.displayName)),
    reporter: safeField(asString(asRecord(fields.reporter)?.displayName)),
    priority: safeField(namedField(fields.priority)),
    resolution: safeField(namedField(fields.resolution)),
    originalEstimate: safeField(asString(timetracking.originalEstimate)),
    remainingEstimate: safeField(asString(timetracking.remainingEstimate)),
    parentKey: safeKey(asString(asRecord(fields.parent)?.key)),
    created: safeField(asString(fields.created)),
    updated: safeField(asString(fields.updated)),
  };
}

function definedEntries(metadata: JiraIssueCitationMetadata): JiraIssueCitationMetadata {
  // Rebuild in the contract's fixed key order with undefined fields omitted, so serialization is
  // deterministic and never carries explicit-undefined keys.
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined),
  ) as JiraIssueCitationMetadata;
}

// Build the validated citation-metadata projection. Every field is individually fail-closed; the
// final guard is a defensive assertion that can only fail if this builder and the contract drift.
export function buildJiraIssueCitationMetadata(
  issueKey: string,
  fields: Record<string, unknown>,
): JiraIssueCitationMetadata {
  const full = definedEntries({
    issueKey,
    ...scalarMetadataFields(fields),
    labels: safeLabelList(asArray(fields.labels)),
    subtaskKeys: safeKeyList(asArray(fields.subtasks)),
    linkedIssues: linkedIssueList(asArray(fields.issuelinks)),
  });
  if (!isJiraIssueCitationMetadata(full)) return { issueKey };
  return full;
}

// Serialize with the bounded-size rule: full projection when it fits, list fields dropped when it
// does not (scalar-only metadata always fits the contract bound by construction).
export function serializeJiraIssueCitationMetadata(metadata: JiraIssueCitationMetadata): string {
  const full = JSON.stringify(metadata);
  if (full.length <= ATLASSIAN_CITATION_METADATA_MAX_CHARS) return full;
  const scalarsOnly = definedEntries({
    ...metadata,
    labels: undefined,
    subtaskKeys: undefined,
    linkedIssues: undefined,
  });
  const compact = JSON.stringify(scalarsOnly);
  return compact.length <= ATLASSIAN_CITATION_METADATA_MAX_CHARS
    ? compact
    : JSON.stringify({ issueKey: metadata.issueKey });
}

// ─── Metadata body line (retrievable text mirror of the citation metadata) ────
function scalarLineParts(metadata: JiraIssueCitationMetadata): readonly string[] {
  const labeled: readonly (readonly [string, string | undefined])[] = [
    ["Status", metadata.status],
    ["Type", metadata.issueType],
    ["Priority", metadata.priority],
    ["Assignee", metadata.assignee],
    ["Reporter", metadata.reporter],
    ["Resolution", metadata.resolution],
    ["Original estimate", metadata.originalEstimate],
    ["Remaining estimate", metadata.remainingEstimate],
    ["Parent", metadata.parentKey],
  ];
  return labeled
    .filter((entry): entry is readonly [string, string] => entry[1] !== undefined)
    .map(([label, value]) => `${label}: ${value}`);
}

export function jiraIssueMetadataLine(metadata: JiraIssueCitationMetadata): string {
  const parts = [...scalarLineParts(metadata)];
  if (metadata.labels !== undefined) parts.push(`Labels: ${metadata.labels.join(", ")}`);
  if (metadata.subtaskKeys !== undefined) {
    parts.push(`Subtasks: ${metadata.subtaskKeys.join(", ")}`);
  }
  if (metadata.linkedIssues !== undefined) {
    const links = metadata.linkedIssues.map((link) => `${link.linkType} ${link.issueKey}`);
    parts.push(`Links: ${links.join(", ")}`);
  }
  return parts.join(" | ");
}

// ─── ADF body conversion with explicit degradation notices ─────────────────────
function conversionNotice(outcome: AdfConversionOutcome, hadContent: boolean): string | undefined {
  if (outcome.truncated) return CONVERSION_TRUNCATION_MARKER;
  if (hadContent && outcome.docShape === "not-a-doc" && outcome.text.length === 0) {
    return UNREADABLE_CONTENT_MARKER;
  }
  return undefined;
}

// Converts one ADF body value (or Jira's legacy plain-string form) to bounded text plus an
// explicit notice line when conversion degraded — never a silent cut, never a throw.
export function jiraBodyText(value: unknown): {
  readonly text: string;
  readonly degraded: boolean;
} {
  if (value === undefined || value === null) return { text: "", degraded: false };
  const legacy = asString(value);
  if (legacy !== undefined) return { text: legacy, degraded: false };
  const outcome = convertAdfToText(value);
  const notice = conversionNotice(outcome, true);
  if (notice === undefined) return { text: outcome.text, degraded: false };
  const text = outcome.text.length === 0 ? notice : `${outcome.text}\n${notice}`;
  return { text, degraded: true };
}

// ─── Comments ──────────────────────────────────────────────────────────────────
export interface JiraComposedComment {
  readonly headerLine: string;
  readonly bodyText: string;
}

function boundedHeaderField(value: string | undefined, fallback: string, maxChars: number): string {
  if (value === undefined) return fallback;
  const flat = value.replace(/\s+/gu, " ").trim();
  if (flat.length === 0) return fallback;
  return flat.length > maxChars ? flat.slice(0, maxChars) : flat;
}

// One comment: `author — created` header plus the converted ADF body. Order is the provider's
// listing order; hostile author/created values are flattened and bounded.
export function composeJiraComment(entry: unknown): JiraComposedComment | undefined {
  const record = asRecord(entry);
  if (record === undefined) return undefined;
  const author = boundedHeaderField(
    asString(asRecord(record.author)?.displayName),
    "Unknown author",
    MAX_COMMENT_HEADER_FIELD_CHARS,
  );
  const created = boundedHeaderField(asString(record.created), "", MAX_TIMESTAMP_CHARS);
  const body = jiraBodyText(record.body);
  if (body.text.length === 0) return undefined;
  return {
    headerLine: created.length === 0 ? author : `${author} — ${created}`,
    bodyText: body.text,
  };
}

// ─── HTML envelope composition under the byte budget ───────────────────────────
const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

function escapeHtmlText(value: string): string {
  return value.replace(/[&<>"]/gu, (char) => HTML_ESCAPES[char] ?? char);
}

const utf8Encoder = new TextEncoder();

function byteLengthOf(text: string): number {
  return utf8Encoder.encode(text).length;
}

// UTF-8-safe byte slice: decodes leniently and strips a partial trailing code point.
function sliceToBytes(text: string, maxBytes: number): string {
  const bytes = utf8Encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(
    bytes.subarray(0, Math.max(0, maxBytes)),
  );
  return decoded.endsWith("�") ? decoded.slice(0, -1) : decoded;
}

export function boundedJiraIssueTitle(issueKey: string, summary: unknown): string {
  const trimmed = asString(summary)?.trim() ?? "";
  const title = trimmed.length === 0 ? issueKey : `${issueKey}: ${trimmed}`;
  return title.length > MAX_TITLE_CHARS ? title.slice(0, MAX_TITLE_CHARS) : title;
}

export interface JiraIssueDocumentInput {
  readonly title: string;
  readonly metadataLine: string;
  readonly descriptionText: string;
  readonly comments: readonly JiraComposedComment[];
}

export interface JiraIssueDocumentResult {
  readonly contentHtml: string;
  readonly byteLength: number;
  // True when the byte budget forced an explicit truncation marker into the document.
  readonly truncated: boolean;
}

function commentSectionHtml(comment: JiraComposedComment): string {
  return [
    '<section data-connector-comment="true"><p>',
    escapeHtmlText(comment.headerLine),
    "</p><pre>",
    escapeHtmlText(comment.bodyText),
    "</pre></section>",
  ].join("");
}

function descriptionSectionHtml(
  descriptionText: string,
  budgetBytes: number,
): {
  readonly html: string;
  readonly truncated: boolean;
} {
  if (descriptionText.length === 0) return { html: "", truncated: false };
  const open = '<section data-connector-description="true"><pre>';
  const close = "</pre></section>";
  const escaped = escapeHtmlText(descriptionText);
  const overhead = byteLengthOf(open) + byteLengthOf(close);
  if (overhead + byteLengthOf(escaped) <= budgetBytes) {
    return { html: `${open}${escaped}${close}`, truncated: false };
  }
  const marker = `\n${JIRA_DOCUMENT_TRUNCATION_MARKER}`;
  const allowance = Math.max(0, budgetBytes - overhead - byteLengthOf(marker));
  const sliced = sliceToBytes(escaped, allowance);
  return { html: `${open}${sliced}${escapeHtmlText(marker)}${close}`, truncated: true };
}

interface CommentsComposition {
  readonly html: string;
  readonly omitted: number;
}

function composeCommentsWithinBudget(
  comments: readonly JiraComposedComment[],
  budgetBytes: number,
): CommentsComposition {
  if (comments.length === 0) return { html: "", omitted: 0 };
  const open = '<section data-connector-comments="true"><h2>Comments</h2>';
  const close = "</section>";
  let used = byteLengthOf(open) + byteLengthOf(close);
  if (used > budgetBytes) return { html: "", omitted: comments.length };
  const kept: string[] = [];
  for (const comment of comments) {
    const section = commentSectionHtml(comment);
    const size = byteLengthOf(section);
    if (used + size > budgetBytes) break;
    used += size;
    kept.push(section);
  }
  const omitted = comments.length - kept.length;
  if (omitted > 0) {
    kept.push(
      `<section data-connector-truncation="true"><p>${escapeHtmlText(
        `${JIRA_DOCUMENT_TRUNCATION_MARKER} — ${String(omitted)} of ${String(
          comments.length,
        )} comments omitted`,
      )}</p></section>`,
    );
  }
  if (kept.length === 0 && omitted === 0) return { html: "", omitted: 0 };
  return { html: `${open}${kept.join("")}${close}`, omitted };
}

// Compose the one complete HTML document for an issue, holding the byte budget with explicit
// truncation markers. Deterministic: the same input always yields byte-identical HTML.
export function composeJiraIssueDocument(input: JiraIssueDocumentInput): JiraIssueDocumentResult {
  const escapedTitle = escapeHtmlText(input.title);
  const head = [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>',
    escapedTitle,
    "</title></head><body><main><h1>",
    escapedTitle,
    "</h1>",
  ].join("");
  const metadata =
    input.metadataLine.length === 0
      ? ""
      : `<section data-connector-issue-metadata="true"><p>${escapeHtmlText(input.metadataLine)}</p></section>`;
  const tail = "</main></body></html>";
  const fixedBytes = byteLengthOf(head) + byteLengthOf(metadata) + byteLengthOf(tail);
  const budget = JIRA_COMPOSED_DOCUMENT_MAX_BYTES - TRUNCATION_RESERVE_BYTES;
  const description = descriptionSectionHtml(
    input.descriptionText,
    Math.max(0, budget - fixedBytes),
  );
  const comments = composeCommentsWithinBudget(
    input.comments,
    Math.max(0, budget - fixedBytes - byteLengthOf(description.html)),
  );
  const contentHtml = `${head}${metadata}${description.html}${comments.html}${tail}`;
  return {
    contentHtml,
    byteLength: byteLengthOf(contentHtml),
    truncated: description.truncated || comments.omitted > 0,
  };
}
