"use client";

import { useMemo } from "react";
import { UNSUPPORTED_DOCUMENT_GUIDANCE_CODES } from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-records";
import type {
  KnowledgePodReadiness,
  KnowledgePodSetReadinessReasonCode,
  ManualRefreshReasonCode,
  UnsupportedDocumentGuidanceCode,
} from "@oscharko-dev/keiko-contracts";
import { formatI18nMessage, useLocale, type Locale, type MessageValues } from "@/lib/i18n";
import type { KnowledgePodGuidanceCode, KnowledgePodUiGuidance } from "@/lib/local-knowledge-api";

import { EN_LOCAL_KNOWLEDGE_MESSAGES } from "./local-knowledge-i18n.en";
import { DE_LOCAL_KNOWLEDGE_MESSAGES } from "./local-knowledge-i18n.de";

export type LocalKnowledgeMessageKey = keyof typeof EN_LOCAL_KNOWLEDGE_MESSAGES;
export type I18nTranslate = (key: LocalKnowledgeMessageKey, values?: MessageValues) => string;

export function translateLocalKnowledge(
  locale: Locale,
  key: LocalKnowledgeMessageKey,
  values?: MessageValues,
): string {
  const catalog = locale === "de" ? DE_LOCAL_KNOWLEDGE_MESSAGES : EN_LOCAL_KNOWLEDGE_MESSAGES;
  return formatI18nMessage(catalog[key] ?? EN_LOCAL_KNOWLEDGE_MESSAGES[key], values);
}

// 0.3.0 release audit — the server sends a stable reason code for a document it could not extract
// (it must not hold locale copy); this is the single place that turns such a code into operator
// text. Keyed by the contract's closed code list, so a new code cannot ship without both catalog
// halves. An unrecognised code — a newer server talking to an older UI — falls back to the generic
// remediation rather than rendering a raw code or dropping the operator's next step entirely.
const UNSUPPORTED_GUIDANCE_MESSAGE_KEYS: Readonly<
  Record<UnsupportedDocumentGuidanceCode, LocalKnowledgeMessageKey>
> = {
  "pdf-needs-ocr": "localKnowledge.detail.overview.unsupported.pdfNeedsOcr",
  "image-needs-ocr": "localKnowledge.detail.overview.unsupported.imageNeedsOcr",
  "ocr-failed": "localKnowledge.detail.overview.unsupported.ocrFailed",
  "unsupported-format": "localKnowledge.detail.overview.unsupported.unsupportedFormat",
};

const KNOWN_UNSUPPORTED_GUIDANCE_CODES: ReadonlySet<string> = new Set(
  UNSUPPORTED_DOCUMENT_GUIDANCE_CODES,
);

function isUnsupportedGuidanceCode(value: string): value is UnsupportedDocumentGuidanceCode {
  return KNOWN_UNSUPPORTED_GUIDANCE_CODES.has(value);
}

/** Localized remediation text for one unsupported-document reason code. */
export function unsupportedGuidanceText(code: string, t: I18nTranslate): string {
  const key = isUnsupportedGuidanceCode(code)
    ? UNSUPPORTED_GUIDANCE_MESSAGE_KEYS[code]
    : UNSUPPORTED_GUIDANCE_MESSAGE_KEYS["unsupported-format"];
  return t(key);
}

// A Knowledge Pod / Pod Set readiness state, named in the user's language. `undefined` is a summary
// the server did not echo.
const READINESS_LABEL_KEYS: Readonly<Record<KnowledgePodReadiness, LocalKnowledgeMessageKey>> = {
  ready: "localKnowledge.readiness.ready",
  indexing: "localKnowledge.readiness.indexing",
  stale: "localKnowledge.readiness.stale",
  degraded: "localKnowledge.readiness.degraded",
  unavailable: "localKnowledge.readiness.unavailable",
  error: "localKnowledge.readiness.error",
  draft: "localKnowledge.readiness.draft",
};

export function readinessLabelText(
  readiness: KnowledgePodReadiness | undefined,
  t: I18nTranslate,
): string {
  return t(
    readiness === undefined ? "localKnowledge.readiness.unknown" : READINESS_LABEL_KEYS[readiness],
  );
}

// The short reason a Pod Set is not simply ready. Keyed by the contract's closed code list, so a
// new reason cannot ship without both catalog halves.
const SET_REASON_KEYS: Readonly<
  Record<KnowledgePodSetReadinessReasonCode, LocalKnowledgeMessageKey>
> = {
  "member-draft": "localKnowledge.set.reason.memberDraft",
  "member-indexing": "localKnowledge.set.reason.memberIndexing",
  "member-stale": "localKnowledge.set.reason.memberStale",
  "member-error": "localKnowledge.set.reason.memberError",
  "member-unavailable": "localKnowledge.set.reason.memberUnavailable",
  "member-degraded": "localKnowledge.set.reason.memberDegraded",
  "missing-member": "localKnowledge.set.reason.missingMember",
  "policy-denied": "localKnowledge.set.reason.policyDenied",
  "embedding-unknown": "localKnowledge.set.reason.embeddingUnknown",
  "embedding-incompatible": "localKnowledge.set.reason.embeddingIncompatible",
  "embedding-unavailable": "localKnowledge.set.reason.embeddingUnavailable",
  "embedding-opaque": "localKnowledge.set.reason.embeddingOpaque",
  "no-sources": "localKnowledge.set.reason.noSources",
  "no-vectors": "localKnowledge.set.reason.noVectors",
  "future-remote-member": "localKnowledge.set.reason.futureRemoteMember",
  "future-federated-member": "localKnowledge.set.reason.futureFederatedMember",
  "future-ephemeral-member": "localKnowledge.set.reason.futureEphemeralMember",
};

export function setReadinessReasonText(
  code: KnowledgePodSetReadinessReasonCode,
  t: I18nTranslate,
): string {
  return t(SET_REASON_KEYS[code]);
}

// Knowledge Pod guidance is a closed code plus a scope (the producer never emits display text): this
// table is the single place a code becomes a label and a description. Codes whose copy does not
// differ between one pod and a set name the same key for both scopes.
interface GuidanceCopyKeys {
  readonly label: LocalKnowledgeMessageKey;
  readonly description: Readonly<Record<KnowledgePodUiGuidance["scope"], LocalKnowledgeMessageKey>>;
}

function sameForBothScopes(
  label: LocalKnowledgeMessageKey,
  description: LocalKnowledgeMessageKey,
): GuidanceCopyKeys {
  return { label, description: { pod: description, "pod-set": description } };
}

const GUIDANCE_COPY_KEYS: Readonly<Record<KnowledgePodGuidanceCode, GuidanceCopyKeys>> = {
  "embedding-mismatch": {
    label: "localKnowledge.guidance.label.embeddingMismatch",
    description: {
      pod: "localKnowledge.guidance.description.embeddingMismatch.pod",
      "pod-set": "localKnowledge.guidance.description.embeddingMismatch.set",
    },
  },
  "embedding-unavailable": {
    label: "localKnowledge.guidance.label.embeddingUnavailable",
    description: {
      pod: "localKnowledge.guidance.description.embeddingUnavailable.pod",
      "pod-set": "localKnowledge.guidance.description.embeddingUnavailable.set",
    },
  },
  "reindex-recommended": {
    label: "localKnowledge.guidance.label.reindexRecommended",
    description: {
      pod: "localKnowledge.guidance.description.reindexRecommended.pod",
      "pod-set": "localKnowledge.guidance.description.reindexRecommended.set",
    },
  },
  "embedding-opaque": {
    label: "localKnowledge.guidance.label.embeddingOpaque",
    description: {
      pod: "localKnowledge.guidance.description.embeddingOpaque.pod",
      "pod-set": "localKnowledge.guidance.description.embeddingOpaque.set",
    },
  },
  "policy-denied": {
    label: "localKnowledge.guidance.label.policyDenied",
    description: {
      pod: "localKnowledge.guidance.description.policyDenied.pod",
      "pod-set": "localKnowledge.guidance.description.policyDenied.set",
    },
  },
  "sealed-local-policy": {
    label: "localKnowledge.guidance.label.sealedLocalPolicy",
    description: {
      pod: "localKnowledge.guidance.description.sealedLocalPolicy.pod",
      "pod-set": "localKnowledge.guidance.description.sealedLocalPolicy.set",
    },
  },
  "manual-ready": sameForBothScopes(
    "localKnowledge.guidance.label.manualReady",
    "localKnowledge.guidance.description.manualReady",
  ),
  "manual-degraded": sameForBothScopes(
    "localKnowledge.guidance.label.manualDegraded",
    "localKnowledge.guidance.description.manualDegraded",
  ),
  "manual-indexing": sameForBothScopes(
    "localKnowledge.guidance.label.manualIndexing",
    "localKnowledge.guidance.description.manualIndexing",
  ),
  "manual-unavailable": sameForBothScopes(
    "localKnowledge.guidance.label.manualUnavailable",
    "localKnowledge.guidance.description.manualUnavailable",
  ),
  "future-member-placeholder": sameForBothScopes(
    "localKnowledge.guidance.label.futureMember",
    "localKnowledge.guidance.description.futureMember",
  ),
  "members-unavailable": sameForBothScopes(
    "localKnowledge.guidance.label.membersUnavailable",
    "localKnowledge.guidance.description.membersUnavailable",
  ),
  "members-not-ready": sameForBothScopes(
    "localKnowledge.guidance.label.membersNotReady",
    "localKnowledge.guidance.description.membersNotReady",
  ),
  "retrieval-degraded": sameForBothScopes(
    "localKnowledge.guidance.label.retrievalDegraded",
    "localKnowledge.guidance.description.retrievalDegraded",
  ),
  "embedding-readiness-warning": sameForBothScopes(
    "localKnowledge.guidance.label.embeddingReadinessWarning",
    "localKnowledge.guidance.description.embeddingReadinessWarning",
  ),
};

const MANUAL_STATE_KEYS: Readonly<Record<KnowledgePodReadiness, LocalKnowledgeMessageKey>> = {
  ready: "localKnowledge.guidance.manualState.ready",
  indexing: "localKnowledge.guidance.manualState.indexing",
  stale: "localKnowledge.guidance.manualState.stale",
  degraded: "localKnowledge.guidance.manualState.degraded",
  unavailable: "localKnowledge.guidance.manualState.unavailable",
  error: "localKnowledge.guidance.manualState.error",
  draft: "localKnowledge.guidance.manualState.draft",
};

// Only the `manual-*` codes carry facts their copy interpolates (the counts and the state).
function guidanceValues(guidance: KnowledgePodUiGuidance, t: I18nTranslate): MessageValues {
  const manual = guidance.manual;
  if (manual === undefined) return {};
  return {
    counts: t("localKnowledge.guidance.manualCounts", {
      docs: manual.documentCount,
      chunks: manual.chunkCount,
      vectors: manual.vectorCount,
    }),
    state: t(MANUAL_STATE_KEYS[manual.readiness]),
  };
}

/** The label and description of one Knowledge Pod guidance, in the user's language. */
export function knowledgePodGuidanceText(
  guidance: KnowledgePodUiGuidance,
  t: I18nTranslate,
): { readonly label: string; readonly description: string } {
  const keys = GUIDANCE_COPY_KEYS[guidance.code];
  return {
    label: t(keys.label),
    description: t(keys.description[guidance.scope], guidanceValues(guidance, t)),
  };
}

// The operator guidance of one HTML manual refresh reason. The contract owns the closed code list and
// an English sentence for each; this catalog owns the wording the operator reads, in either language
// (a test pins the English text to the contract's, so the two cannot drift apart).
const MANUAL_REFRESH_REASON_KEYS: Readonly<
  Record<ManualRefreshReasonCode, LocalKnowledgeMessageKey>
> = {
  "scope-preserved": "localKnowledge.manualRefresh.reason.scopePreserved",
  "scope-limit-reached": "localKnowledge.manualRefresh.reason.scopeLimitReached",
  "removal-detection-skipped": "localKnowledge.manualRefresh.reason.removalDetectionSkipped",
  "pages-added": "localKnowledge.manualRefresh.reason.pagesAdded",
  "pages-changed": "localKnowledge.manualRefresh.reason.pagesChanged",
  "pages-removed": "localKnowledge.manualRefresh.reason.pagesRemoved",
  "pages-moved": "localKnowledge.manualRefresh.reason.pagesMoved",
  "pages-failed": "localKnowledge.manualRefresh.reason.pagesFailed",
  "links-denied": "localKnowledge.manualRefresh.reason.linksDenied",
  "embedding-incompatible": "localKnowledge.manualRefresh.reason.embeddingIncompatible",
  "crawl-empty": "localKnowledge.manualRefresh.reason.crawlEmpty",
  "crawl-cancelled": "localKnowledge.manualRefresh.reason.crawlCancelled",
  "index-failed": "localKnowledge.manualRefresh.reason.indexFailed",
};

export function manualRefreshReasonText(code: ManualRefreshReasonCode, t: I18nTranslate): string {
  return t(MANUAL_REFRESH_REASON_KEYS[code]);
}

export function useLocalKnowledgeTranslate(): I18nTranslate {
  const locale = useLocale();
  return useMemo<I18nTranslate>(
    () => (key, values) => translateLocalKnowledge(locale, key, values),
    [locale],
  );
}
