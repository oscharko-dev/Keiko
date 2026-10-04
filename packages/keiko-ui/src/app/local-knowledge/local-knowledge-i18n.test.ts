import { beforeEach, describe, expect, it } from "vitest";
import { UNSUPPORTED_DOCUMENT_GUIDANCE_CODES } from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-records";
import {
  MANUAL_REFRESH_REASON_CODES,
  MANUAL_REFRESH_REASON_GUIDANCE,
} from "@oscharko-dev/keiko-contracts/runtime/html-manual-refresh";

import { loadLocaleMessages, translate } from "@/lib/i18n";
import type { KnowledgePodGuidanceCode, KnowledgePodUiGuidance } from "@/lib/local-knowledge-api";
import {
  knowledgePodGuidanceText,
  manualRefreshReasonText,
  translateLocalKnowledge,
  unsupportedGuidanceText,
  type I18nTranslate,
} from "./local-knowledge-i18n";

describe("local knowledge translations", () => {
  it("interpolates every named value in selected-document summaries", () => {
    expect(
      translateLocalKnowledge("en", "localKnowledge.detail.connect.selectedDocuments", {
        count: 3,
        root: "/repo/docs",
      }),
    ).toBe("Selected documents: 3 from /repo/docs");
    expect(
      translateLocalKnowledge("de", "localKnowledge.detail.diagnostics.groupAria", {
        severity: "Warnung",
        code: "PARSER_LIMIT",
        count: 2,
      }),
    ).toBe("Warnung: PARSER_LIMIT (2x)");
  });
});

// 0.3.0 release audit — the server may only send an unsupported-document REASON CODE; the operator
// copy is owned here. The list is read from the contract, so a code added there without catalog
// entries fails this suite instead of shipping an untranslated (or missing) next step.
describe("unsupported-document remediation copy", () => {
  it("resolves every contract code to distinct English and German text", () => {
    const english = new Set<string>();
    const german = new Set<string>();
    for (const code of UNSUPPORTED_DOCUMENT_GUIDANCE_CODES) {
      const en = unsupportedGuidanceText(code, (key, values) =>
        translateLocalKnowledge("en", key, values),
      );
      const de = unsupportedGuidanceText(code, (key, values) =>
        translateLocalKnowledge("de", key, values),
      );
      expect(en.length).toBeGreaterThan(0);
      expect(de.length).toBeGreaterThan(0);
      expect(de).not.toBe(en);
      expect(en).not.toContain(code);
      english.add(en);
      german.add(de);
    }
    expect(english).toHaveLength(UNSUPPORTED_DOCUMENT_GUIDANCE_CODES.length);
    expect(german).toHaveLength(UNSUPPORTED_DOCUMENT_GUIDANCE_CODES.length);
  });

  it("falls back to the generic remediation for an unknown or malformed code", () => {
    const en = (key: Parameters<typeof translateLocalKnowledge>[1]): string =>
      translateLocalKnowledge("en", key);
    const generic = unsupportedGuidanceText("unsupported-format", en);
    for (const unknown of ["", " ", "pdf-needs-ocr ", "PDF-NEEDS-OCR", "__proto__", "toString"]) {
      expect(unsupportedGuidanceText(unknown, en)).toBe(generic);
    }
  });
});

// PR #3678 audit O15 — the chat grounding suffix ("test (Fehler)") and the Knowledge Pods panel
// ("Fehlgeschlagen") named the same lifecycle state with two German words, and a draft pod read
// "nicht indexiert" in the chat but "Entwurf" in the panel. One wording per state, in both places;
// the chat suffix is only lower-cased where German grammar allows it.
describe("lifecycle state wording across the chat and the Knowledge Pods panel", () => {
  const STATES = ["draft", "indexing", "stale", "deleting", "error"] as const;

  // The German core catalog is lazy (and reset before every test): without loading it,
  // `translate("de", …)` answers in English.
  beforeEach(async () => {
    await loadLocaleMessages("de");
  });

  it.each(STATES)("names the %s state with one German word in both catalogs", (state) => {
    const chat = translate("de", `chat.grounding.state.${state}`);
    const panel = translateLocalKnowledge("de", `localKnowledge.state.${state}`);
    expect(chat.toLowerCase()).toBe(panel.toLowerCase());
  });
});

const en: I18nTranslate = (key, values) => translateLocalKnowledge("en", key, values);
const de: I18nTranslate = (key, values) => translateLocalKnowledge("de", key, values);

const GUIDANCE_CODES: readonly KnowledgePodGuidanceCode[] = [
  "embedding-mismatch",
  "embedding-unavailable",
  "reindex-recommended",
  "embedding-opaque",
  "manual-ready",
  "manual-degraded",
  "manual-indexing",
  "manual-unavailable",
  "future-member-placeholder",
  "members-unavailable",
  "members-not-ready",
  "retrieval-degraded",
  "embedding-readiness-warning",
  "policy-denied",
  "sealed-local-policy",
];

function guidanceOf(
  code: KnowledgePodGuidanceCode,
  scope: KnowledgePodUiGuidance["scope"],
): KnowledgePodUiGuidance {
  const manual = code.startsWith("manual-")
    ? {
        documentCount: 3,
        chunkCount: 8,
        vectorCount: 2,
        readiness: code === "manual-unavailable" ? ("error" as const) : ("stale" as const),
      }
    : undefined;
  return { code, scope, tone: "warning", ...(manual === undefined ? {} : { manual }) };
}

// The English wording is the product's pre-localization copy: pinned exactly, so moving it from the
// producer into the catalog cannot change what an English operator reads.
describe("Knowledge Pod guidance copy", () => {
  it("resolves every code and scope to the pinned English label and description", () => {
    const pinned: ReadonlyArray<
      readonly [KnowledgePodGuidanceCode, "pod" | "pod-set", string, string]
    > = [
      [
        "embedding-mismatch",
        "pod",
        "Embedding mismatch",
        "Semantic retrieval is disabled for this pod until it is reindexed locally.",
      ],
      [
        "embedding-mismatch",
        "pod-set",
        "Embedding mismatch",
        "Semantic retrieval is disabled for affected set members until they are reindexed locally.",
      ],
      [
        "embedding-unavailable",
        "pod",
        "Embedding unavailable",
        "Semantic retrieval cannot run under the current local policy.",
      ],
      [
        "embedding-unavailable",
        "pod-set",
        "Embedding unavailable",
        "Semantic retrieval cannot run for affected set members under the current local policy.",
      ],
      [
        "reindex-recommended",
        "pod",
        "Reindex recommended",
        "Compatibility is unverified; lexical fallback remains available.",
      ],
      [
        "reindex-recommended",
        "pod-set",
        "Reindex recommended",
        "Compatibility is unverified for affected set members; lexical fallback remains available.",
      ],
      [
        "embedding-opaque",
        "pod",
        "Embedding opaque",
        "Semantic compatibility cannot be verified for this retrieval space.",
      ],
      [
        "embedding-opaque",
        "pod-set",
        "Embedding opaque",
        "Semantic compatibility cannot be verified for this Knowledge Pod Set.",
      ],
      [
        "policy-denied",
        "pod",
        "Policy denied",
        "This Knowledge Pod blocks grounded answer synthesis or raw-content release; Keiko will return a policy-denied state instead of sending excerpts to a model.",
      ],
      [
        "policy-denied",
        "pod-set",
        "Policy denied",
        "This Knowledge Pod Set blocks grounded answer synthesis or raw-content release for affected members; Keiko will return a policy-denied state instead of sending excerpts to a model.",
      ],
      [
        "sealed-local-policy",
        "pod",
        "Sealed local policy",
        "External embedding or reranking calls are disabled for this Knowledge Pod; retrieval may use lexical or local fallback.",
      ],
      [
        "sealed-local-policy",
        "pod-set",
        "Sealed local policy",
        "External embedding or reranking calls are disabled for affected set members; retrieval may use lexical or local fallback.",
      ],
      [
        "future-member-placeholder",
        "pod-set",
        "Future member placeholder",
        "This Knowledge Pod Set includes future remote, federated, or ephemeral placeholders; those members are not active retrieval sources yet.",
      ],
      [
        "members-unavailable",
        "pod-set",
        "Members unavailable",
        "Some set members are missing, failed, or unavailable; retrieval will use only available members.",
      ],
      [
        "members-not-ready",
        "pod-set",
        "Members not ready",
        "Some set members are indexing, stale, or draft; refresh or index them before relying on this set.",
      ],
      [
        "retrieval-degraded",
        "pod-set",
        "Retrieval degraded",
        "Some set members have no sources, no vectors, or degraded indexing; lexical fallback may be the only available path.",
      ],
      [
        "embedding-readiness-warning",
        "pod-set",
        "Embedding readiness warning",
        "Some set members need embedding review; Keiko does not compare raw vector scores across embedding spaces.",
      ],
      [
        "manual-ready",
        "pod",
        "HTML manual",
        "Ready for chat retrieval through Local Knowledge. 3 docs · 8 chunks · 2 vectors.",
      ],
      [
        "manual-degraded",
        "pod",
        "Manual degraded",
        "Manual retrieval is degraded; answers may use only available evidence. 3 docs · 8 chunks · 2 vectors.",
      ],
      [
        "manual-indexing",
        "pod",
        "Manual indexing",
        "Manual retrieval is stale; it is not yet ready to contribute evidence.",
      ],
      [
        "manual-unavailable",
        "pod",
        "Manual unavailable",
        "Manual retrieval is error; it cannot contribute silently as empty evidence.",
      ],
    ];
    for (const [code, scope, label, description] of pinned) {
      expect(knowledgePodGuidanceText(guidanceOf(code, scope), en)).toEqual({ label, description });
    }
  });

  it("resolves every code and scope to German text without a leftover placeholder", () => {
    for (const code of GUIDANCE_CODES) {
      for (const scope of ["pod", "pod-set"] as const) {
        const guidance = guidanceOf(code, scope);
        const english = knowledgePodGuidanceText(guidance, en);
        const german = knowledgePodGuidanceText(guidance, de);
        expect(german.label.length).toBeGreaterThan(0);
        expect(german.description.length).toBeGreaterThan(0);
        expect(german.label).not.toBe(english.label);
        expect(german.description).not.toBe(english.description);
        expect(`${german.label} ${german.description}`).not.toMatch(/[{}]/u);
        expect(`${german.label} ${german.description}`).not.toContain(code);
      }
    }
  });

  it("names the manual counts and state in German", () => {
    const text = knowledgePodGuidanceText(guidanceOf("manual-indexing", "pod"), de);
    expect(text.description).toBe(
      "Handbuch-Abruf (Status: veraltet); noch nicht bereit, Belege beizusteuern.",
    );
    expect(knowledgePodGuidanceText(guidanceOf("manual-ready", "pod"), de).description).toBe(
      "Bereit für die Chat-Suche über Lokales Wissen. 3 Dok. · 8 Chunks · 2 Vektoren.",
    );
  });
});

// PR #3678 audit O3 — the refresh panel under a manual pod rendered the contract's English sentence
// whatever the UI language. The catalog now owns the wording; its English text is derived from the
// contract's own guidance map rather than restated here, so the two cannot drift apart.
describe("HTML manual refresh reason copy", () => {
  it("keeps the English wording of every contract reason code", () => {
    for (const code of MANUAL_REFRESH_REASON_CODES) {
      expect(manualRefreshReasonText(code, en)).toBe(MANUAL_REFRESH_REASON_GUIDANCE[code]);
    }
  });

  it("gives every contract reason code its own German sentence", () => {
    const german = new Set<string>();
    for (const code of MANUAL_REFRESH_REASON_CODES) {
      const text = manualRefreshReasonText(code, de);
      expect(text).not.toBe(MANUAL_REFRESH_REASON_GUIDANCE[code]);
      expect(text).not.toMatch(/[{}]/u);
      german.add(text);
    }
    expect(german).toHaveLength(MANUAL_REFRESH_REASON_CODES.length);
  });
});
