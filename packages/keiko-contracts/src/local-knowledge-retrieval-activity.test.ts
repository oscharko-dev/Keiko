import { describe, expect, expectTypeOf, it } from "vitest";
import {
  knowledgeCapturedExtentMembers,
  knowledgeFinalExtentFailureMembers,
} from "./__tests__/support/protocol-observation-mechanics.js";
import type {
  LibraryParserAcceptedExpected,
  LibraryParserAcceptedFacts,
} from "./__tests__/support/library-parser-type-facts.js";

import type { KnowledgeCapsuleId, KnowledgeSourceId } from "./local-knowledge.js";
import {
  KNOWLEDGE_POD_RETRIEVAL_ACTIVITY_SCHEMA_VERSION,
  isKnowledgePodRetrievalActivitySafeText,
  validateKnowledgePodRetrievalActivity,
  type KnowledgePodRetrievalActivity,
} from "./local-knowledge-retrieval-activity.js";

function happyActivity(): KnowledgePodRetrievalActivity {
  return {
    schemaVersion: KNOWLEDGE_POD_RETRIEVAL_ACTIVITY_SCHEMA_VERSION,
    summary: {
      searchedCount: 1,
      skippedCount: 1,
      degradedCount: 1,
      deniedCount: 1,
      unavailableCount: 1,
      notSelectedCount: 1,
      denseCandidateCount: 8,
      lexicalCandidateCount: 5,
      fusedCandidateCount: 10,
      referenceCount: 3,
      citationCount: 2,
    },
    privacy: {
      localFirst: true,
      rawContentExposed: false,
      rawQueryExposed: false,
      privatePathsExposed: false,
      directVectorScoreComparison: false,
    },
    pods: [
      {
        podId: "cap-searched" as KnowledgeCapsuleId,
        podKind: "pod",
        displayName: "Searched Pod",
        state: "searched",
        modes: ["local-only", "hybrid", "lexical", "vector", "reranked"],
        reasonCodes: ["selected-for-search", "searched"],
        sourceIds: ["src-1" as KnowledgeSourceId],
        counts: {
          sourceCount: 1,
          documentCount: 2,
          chunkCount: 4,
          vectorCount: 4,
          referenceCount: 3,
          citationCount: 2,
        },
      },
      {
        podId: "cap-skipped" as KnowledgeCapsuleId,
        podKind: "pod",
        displayName: "Skipped Pod",
        state: "skipped",
        modes: ["local-only"],
        reasonCodes: ["source-skipped"],
        sourceIds: [],
        counts: {
          sourceCount: 0,
          documentCount: 0,
          chunkCount: 0,
          vectorCount: 0,
          referenceCount: 0,
          citationCount: 0,
        },
      },
      {
        podId: "cap-degraded" as KnowledgeCapsuleId,
        podKind: "pod",
        displayName: "Degraded Pod",
        state: "degraded",
        modes: ["local-only", "lexical"],
        reasonCodes: ["embedding-failed"],
        sourceIds: ["src-2" as KnowledgeSourceId],
        counts: {
          sourceCount: 1,
          documentCount: 1,
          chunkCount: 2,
          vectorCount: 2,
          referenceCount: 0,
          citationCount: 0,
        },
      },
      {
        podId: "cap-denied" as KnowledgeCapsuleId,
        podKind: "pod",
        displayName: "Denied Pod",
        state: "denied",
        modes: ["local-only", "vector"],
        reasonCodes: ["answer-grounding-rejected"],
        sourceIds: ["src-3" as KnowledgeSourceId],
        counts: {
          sourceCount: 1,
          documentCount: 1,
          chunkCount: 2,
          vectorCount: 2,
          referenceCount: 0,
          citationCount: 0,
        },
      },
      {
        podId: "cap-unavailable" as KnowledgeCapsuleId,
        podKind: "pod",
        displayName: "Unavailable Pod",
        state: "unavailable",
        modes: ["local-only"],
        reasonCodes: ["no-vectors"],
        sourceIds: ["src-4" as KnowledgeSourceId],
        counts: {
          sourceCount: 1,
          documentCount: 0,
          chunkCount: 0,
          vectorCount: 0,
          referenceCount: 0,
          citationCount: 0,
        },
      },
      {
        podId: "cap-not-selected" as KnowledgeCapsuleId,
        podKind: "pod",
        displayName: "Not Selected Pod",
        state: "not-selected",
        modes: ["local-only", "vector"],
        reasonCodes: ["not-selected"],
        sourceIds: ["src-5" as KnowledgeSourceId],
        counts: {
          sourceCount: 1,
          documentCount: 2,
          chunkCount: 4,
          vectorCount: 4,
          referenceCount: 0,
          citationCount: 0,
        },
      },
    ],
  };
}

function invalidErrors(
  result: ReturnType<typeof validateKnowledgePodRetrievalActivity>,
): readonly string[] {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected invalid retrieval activity");
  return result.errors;
}

function happyPod(): KnowledgePodRetrievalActivity["pods"][number] {
  const pod = happyActivity().pods[0];
  if (pod === undefined) throw new Error("expected happy retrieval activity pod");
  return pod;
}

const UNSAFE_ACTIVITY_TEXTS = [
  "/Users/alice/private/customer.pdf",
  // Filesystem paths that do not start the string still leak the location and must be redacted.
  "report=/Users/alice/private/customer.pdf",
  "内部/Users/alice/secret.pdf",
  "../../etc/passwd",
  "~/secrets/keys.txt",
  "https://gateway.example.test/v1",
  "Bearer secret-token-value",
  "alice@example.com",
  // Underscore-domain email and a phone number trailed by a word must still be caught as PII.
  "name@ex_ample.com",
  "Call +1 (415) 555-2671 now",
  "555-11-2222",
  // An IPv4-shaped domain is still an email-like construct that identifies someone.
  "alice@192.168.1.1",
  // A single-segment path after punctuation, or a bare sensitive key=value assignment, must be
  // caught even without a query-string `?`/`#` marker or an enumerated boundary character.
  "key:/etc/passwd",
  "password=hunter2",
  // Cookie headers and chat/prompt template scaffolding are their own leak classes (Epic #1858,
  // Issue #1904): the cookie value carries a session identifier the token-key check never named,
  // and the `<|im_start|>`/`[[topic:…]]` markers leak model prompt scaffolding into evidence.
  "Set-Cookie: sessionId=8f2c9a1b; HttpOnly",
  "Cookie: auth=deadbeef",
  "<|im_start|>system",
  "[[topic:internal-planning]]",
] as const;

// Names that legitimately contain a single slash or short numbers must NOT be over-redacted; this
// locks the false-positive boundary of the filesystem-path and phone heuristics.
const SAFE_ACTIVITY_TEXTS = [
  "Policy Pod",
  "UI/UX Guidelines",
  "TCP/IP Reference",
  "read/write access",
  "Q3 2024 / Finance",
  "24/7 Support Runbook",
  "Release 2.4.1 Notes",
  // The word "cookie" in prose (without an HTTP header colon) is a legitimate manual topic and must
  // NOT be over-redacted by the new cookie-header gate.
  "Cookie consent banner",
  "Accept third-party cookies",
] as const;

describe("validateKnowledgePodRetrievalActivity", () => {
  it("accepts every retrieval activity state and future participation posture token", () => {
    const result = validateKnowledgePodRetrievalActivity(happyActivity());
    expect(result.ok).toBe(true);
  });

  it("accepts reserved sealed, remote, and federated mode tokens", () => {
    for (const mode of ["sealed", "remote", "federated"] as const) {
      const pod = happyPod();
      const result = validateKnowledgePodRetrievalActivity({
        ...happyActivity(),
        pods: [{ ...pod, modes: [mode] }],
      });
      expect(result.ok).toBe(true);
    }
  });

  it("rejects unexpected raw-content fields", () => {
    const result = validateKnowledgePodRetrievalActivity({
      ...happyActivity(),
      rawQuery: "customer acquisition target",
    });
    expect(invalidErrors(result)).toContain("activity must not include rawQuery");
  });

  it("rejects malformed unknown states, modes, and reason codes", () => {
    const pod = happyPod();
    const result = validateKnowledgePodRetrievalActivity({
      ...happyActivity(),
      pods: [
        {
          ...pod,
          state: "streaming",
          modes: ["vector-score-mixed"],
          reasonCodes: ["provider-openai-timeout"],
        },
      ],
    });
    expect(invalidErrors(result)).toEqual(
      expect.arrayContaining([
        "pod.state is invalid",
        "pod.modes entries are invalid",
        "pod.reasonCodes entries are invalid",
      ]),
    );
  });

  it("rejects raw body and query fields by allowlist", () => {
    const pod = happyPod();
    const result = validateKnowledgePodRetrievalActivity({
      ...happyActivity(),
      pods: [
        {
          ...pod,
          rawBody: "synthetic customer narrative",
          queryText: "synthetic query text",
        },
      ],
    });
    expect(invalidErrors(result)).toContain("pod must not include rawBody");
  });

  it("rejects path, endpoint, token, and PII-like display strings", () => {
    for (const displayName of UNSAFE_ACTIVITY_TEXTS) {
      const pod = happyPod();
      const result = validateKnowledgePodRetrievalActivity({
        ...happyActivity(),
        pods: [{ ...pod, displayName }],
      });
      expect(invalidErrors(result)).toContain("pod.displayName must be evidence-safe");
    }
  });

  it("exposes the same safe-text predicate for activity producers", () => {
    expect(isKnowledgePodRetrievalActivitySafeText("Policy Pod")).toBe(true);
    expect(isKnowledgePodRetrievalActivitySafeText("https://example.test/path")).toBe(false);
    expect(isKnowledgePodRetrievalActivitySafeText("alice@example.com")).toBe(false);
  });

  it("treats a supplementary-plane character as a non-ASCII boundary, not a PII code match", () => {
    // A lone surrogate's code unit value (and a real supplementary-plane code point) can never fall
    // in the fixed ASCII ranges the PII scanners compare against, so a leading/embedded emoji must
    // neither hide an email/phone match nor cause one to be invented out of benign text.
    expect(isKnowledgePodRetrievalActivitySafeText("😀alice@example.com")).toBe(false);
    expect(isKnowledgePodRetrievalActivitySafeText("Call 😀+1 (415) 555-2671 now")).toBe(false);
    expect(isKnowledgePodRetrievalActivitySafeText("Contact 😀 support for details")).toBe(true);
  });

  it("redacts every leakage class: embedded paths, traversal, home, endpoints, tokens, and PII", () => {
    for (const unsafeText of UNSAFE_ACTIVITY_TEXTS) {
      expect(isKnowledgePodRetrievalActivitySafeText(unsafeText)).toBe(false);
    }
  });

  it("does not over-redact benign display names that contain a single slash or short numbers", () => {
    for (const safeText of SAFE_ACTIVITY_TEXTS) {
      expect(isKnowledgePodRetrievalActivitySafeText(safeText)).toBe(true);
    }
  });

  it("rejects path, endpoint, token, and PII-like pod and source identifiers", () => {
    for (const unsafeText of UNSAFE_ACTIVITY_TEXTS) {
      const pod = happyPod();
      expect(
        invalidErrors(
          validateKnowledgePodRetrievalActivity({
            ...happyActivity(),
            pods: [{ ...pod, podId: unsafeText as KnowledgeCapsuleId }],
          }),
        ),
      ).toContain("pod.podId must be evidence-safe");
      expect(
        invalidErrors(
          validateKnowledgePodRetrievalActivity({
            ...happyActivity(),
            pods: [{ ...pod, sourceIds: [unsafeText as KnowledgeSourceId] }],
          }),
        ),
      ).toContain("pod.sourceIds entries must be evidence-safe strings");
    }
  });

  it("requires every privacy flag to stay fail-closed", () => {
    const cases = [
      ["localFirst", false],
      ["rawContentExposed", true],
      ["rawQueryExposed", true],
      ["privatePathsExposed", true],
      ["directVectorScoreComparison", true],
    ] as const;
    for (const [key, value] of cases) {
      const result = validateKnowledgePodRetrievalActivity({
        ...happyActivity(),
        privacy: { ...happyActivity().privacy, [key]: value },
      });
      expect(invalidErrors(result)).toContain(
        "privacy must preserve the retrieval activity redaction posture",
      );
    }
  });

  it("requires non-negative counts", () => {
    const result = validateKnowledgePodRetrievalActivity({
      ...happyActivity(),
      summary: {
        ...happyActivity().summary,
        referenceCount: -1,
      },
    });
    expect(invalidErrors(result)).toContain(
      "summary.referenceCount must be a non-negative integer",
    );
  });

  it("rejects unknown nested summary, privacy, and count fields", () => {
    const pod = happyPod();
    const result = validateKnowledgePodRetrievalActivity({
      ...happyActivity(),
      summary: { ...happyActivity().summary, rawQuery: "alpha" },
      privacy: { ...happyActivity().privacy, endpoint: "https://example.test" },
      pods: [
        {
          ...pod,
          counts: { ...pod.counts, rawVectorScore: 0.91 },
        },
      ],
    });
    expect(invalidErrors(result)).toEqual(
      expect.arrayContaining([
        "summary must not include rawQuery",
        "privacy must not include endpoint",
        "pod.counts must not include rawVectorScore",
      ]),
    );
  });
});

import { validateKnowledgePodRetrievalActivity as publicValidateActivity } from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-retrieval-activity";
type ActivityAny<T> = 0 extends 1 & T ? true : false;
function consumePublicActivity(input: unknown): void {
  const result = publicValidateActivity(input);
  if (result.ok) {
    const count: number = result.value.summary.citationCount;
    const privacy: false = result.value.privacy.rawQueryExposed;
    const _concrete: ActivityAny<typeof result.value> = false;
    for (const pod of result.value.pods) {
      const state: "searched" | "skipped" | "degraded" | "denied" | "unavailable" | "not-selected" =
        pod.state;
      const podCount: number = pod.counts.sourceCount;
      const _concreteState: ActivityAny<typeof pod.state> = false;
      const id: string = pod.podId;
      const expected = happyActivity().pods.find((candidate) => candidate.podId === id);
      expect(expected).toBeDefined();
      expect(state).toBe(expected?.state);
      expect(podCount).toBe(expected?.counts.sourceCount);
    }
    expect(result.value).toBe(input);
    expect(count).toBe(happyActivity().summary.citationCount);
    expect(privacy).toBe(false);
  }
}
it("public retrieval consumer retains closed privacy/state/count declarations", () => {
  const input = happyActivity();
  consumePublicActivity(input);
  const result = publicValidateActivity(input);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value).toBe(input);
  expect(result.value.pods).toBe(input.pods);
  expect(
    publicValidateActivity({ ...input, privacy: { ...input.privacy, rawQueryExposed: true } }).ok,
  ).toBe(false);
});

import type { LocalKnowledgeValidation as PublicKnowledgeValidation } from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-validation";
import type { KnowledgePodRetrievalActivity as PublicRetrievalActivity } from "@oscharko-dev/keiko-contracts";

export function parsePublicKnowledgeActivity(
  input: unknown,
): PublicKnowledgeValidation<PublicRetrievalActivity> {
  const result = publicValidateActivity(input);
  return result;
}

describe("Knowledge retrieval activity public responsibility (#3918)", () => {
  it("pins exact unknown inputs checked results and nested declarations", () => {
    expectTypeOf<
      LibraryParserAcceptedFacts<
        typeof validateKnowledgePodRetrievalActivity,
        typeof publicValidateActivity,
        typeof parsePublicKnowledgeActivity,
        [
          PublicRetrievalActivity["pods"],
          PublicRetrievalActivity["summary"]["citationCount"],
          PublicRetrievalActivity["privacy"]["rawQueryExposed"],
        ]
      >
    >().toEqualTypeOf<
      LibraryParserAcceptedExpected<
        LocalKnowledgeValidation<KnowledgePodRetrievalActivity>,
        PublicKnowledgeValidation<PublicRetrievalActivity>,
        PublicRetrievalActivity
      >
    >();
    expect(parsePublicKnowledgeActivity(happyActivity()).ok).toBe(true);
  });
});

describe("Knowledge retrieval activity public responsibility (#3918)", () => {
  it("preserves all participation states counts privacy and original pod references", () => {
    const input = happyActivity();
    const result = parsePublicKnowledgeActivity(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(input);
    expect(result.value.pods).toBe(input.pods);
    expect(result.value.summary).toBe(input.summary);
    expect(result.value.privacy).toBe(input.privacy);
    for (const pod of result.value.pods) {
      expectTypeOf(pod).not.toBeAny();
      expectTypeOf(pod.state).toEqualTypeOf<
        "searched" | "skipped" | "degraded" | "denied" | "unavailable" | "not-selected"
      >();
      expectTypeOf(pod.counts.sourceCount).toEqualTypeOf<number>();
      expectTypeOf(pod.counts.sourceCount).not.toBeAny();
      expect(input.pods).toContain(pod);
    }
    expectTypeOf(result.value.privacy.rawQueryExposed).toEqualTypeOf<false>();
  });
  it("refuses malformed activity counts privacy state and closed metadata", () => {
    for (const input of [
      null,
      { ...happyActivity(), schemaVersion: "unsupported" },
      { ...happyActivity(), privacy: { ...happyActivity().privacy, rawQueryExposed: true } },
      { ...happyActivity(), summary: { ...happyActivity().summary, citationCount: -1 } },
      { ...happyActivity(), pods: [{ ...happyPod(), state: "unknown" }] },
      {
        ...happyActivity(),
        pods: [{ ...happyPod(), counts: { ...happyPod().counts, sourceCount: -1 } }],
      },
      { ...happyActivity(), summary: { ...happyActivity().summary, rawQuery: "fixture-private" } },
    ])
      expect(parsePublicKnowledgeActivity(input).ok).toBe(false);
  });
});

import type { LocalKnowledgeValidation } from "./local-knowledge-validation.js";

it.each(["source", "public"])("preserves captured extent observations through %s", (surface) => {
  const validate =
    surface === "source" ? validateKnowledgePodRetrievalActivity : publicValidateActivity;
  for (const state of ["stable", "growth", "shrink", "invalid"]) {
    const trace: string[] = [];
    const members = knowledgeCapturedExtentMembers([happyPod()], trace, state);
    const input = { ...happyActivity(), pods: members };
    const result = validate(input);
    if (state === "stable") {
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(input);
    } else {
      expect(result).toEqual({
        ok: false,
        errors: [
          state !== "invalid"
            ? "activity.pods must not change length during validation"
            : "activity.pods must have a valid array length",
        ],
      });
    }
    expect(trace).toEqual(state === "invalid" ? ["length"] : ["length", "0", "length"]);
  }
});

it.each(["source", "public"])("propagates final extent getter failure through %s", (surface) => {
  const validate =
    surface === "source" ? validateKnowledgePodRetrievalActivity : publicValidateActivity;
  const trace: string[] = [];
  const refusal = new TypeError("fixture-final-extent");
  const members = knowledgeFinalExtentFailureMembers([happyPod()], trace, refusal);
  const input = { ...happyActivity(), pods: members };
  let observed: unknown;
  try {
    validate(input);
  } catch (error) {
    observed = error;
  }
  expect(observed).toBe(refusal);
  expect(trace).toEqual(["length", "0", "length"]);
});
