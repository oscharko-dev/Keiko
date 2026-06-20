import { describe, expect, it } from "vitest";
import {
  analyzePrompt,
  asPromptEnhancementRequestId,
  planGrounding,
  validateGroundingPlan,
  GROUNDING_STRATEGIES,
  RAG_EVALUATION_DIMENSIONS,
  PROMPT_ENHANCER_SCHEMA_VERSION,
  type GroundingNeed,
  type GroundingStrategy,
  type PromptCriticality,
  type PromptDomain,
  type PromptEnhancementProfileId,
  type PromptEnhancementRequest,
  type PromptTaskAnalysis,
  type PromptTaskClass,
} from "./index.js";

// ─── Analysis builder ──────────────────────────────────────────────────────────────
interface AnalysisOverrides {
  readonly taskClass?: PromptTaskClass;
  readonly domain?: PromptDomain;
  readonly criticality?: PromptCriticality;
  readonly groundingNeed?: GroundingNeed;
  readonly recommendedProfile?: PromptEnhancementProfileId;
}

function mk(overrides: AnalysisOverrides = {}): PromptTaskAnalysis {
  return {
    schemaVersion: PROMPT_ENHANCER_SCHEMA_VERSION,
    requestId: asPromptEnhancementRequestId("grounding-test"),
    taskClass: overrides.taskClass ?? "factual-qa",
    taskClassConfidence: "moderate",
    domain: overrides.domain ?? "general",
    criticality: overrides.criticality ?? "standard",
    groundingNeed: overrides.groundingNeed ?? {
      kind: "external-knowledge",
      volatile: false,
      signals: [],
    },
    outputSchema: { format: "unspecified", structured: false, hints: [] },
    missingContext: [],
    riskFlags: [],
    recommendedProfile: overrides.recommendedProfile ?? "precise",
    normalizedInputLength: 24,
    signals: [],
  };
}

function makeRequest(text: string, hasConnectedContext?: boolean): PromptEnhancementRequest {
  return {
    schemaVersion: PROMPT_ENHANCER_SCHEMA_VERSION,
    requestId: asPromptEnhancementRequestId("grounding-request"),
    input: { text, hasConnectedContext },
    missingInformationStrategy: "clarify",
  };
}

// ─── Strategy selection (Expected Verification: six plan types) ──────────────────────
describe("planGrounding — strategy selection (AC1)", () => {
  it("emits no-grounding for a self-contained task", () => {
    const plan = planGrounding(
      mk({ groundingNeed: { kind: "none", volatile: false, signals: ["self-contained-task"] } }),
    );
    expect(plan.strategy).toBe("no-grounding");
    expect(plan.required).toBe(false);
  });

  it("emits supplied-context-only when the user supplied context", () => {
    const plan = planGrounding(
      mk({
        groundingNeed: {
          kind: "supplied-context",
          volatile: false,
          signals: ["supplied-context-reference"],
        },
      }),
    );
    expect(plan.strategy).toBe("supplied-context-only");
    expect(plan.required).toBe(true);
  });

  it("emits local-knowledge for a RAG question needing external knowledge", () => {
    const plan = planGrounding(
      mk({
        taskClass: "rag-question-answering",
        groundingNeed: { kind: "external-knowledge", volatile: false, signals: ["retrieval-cue"] },
      }),
    );
    expect(plan.strategy).toBe("local-knowledge");
    expect(plan.required).toBe(true);
  });

  it("emits repository-context for a code task needing external knowledge", () => {
    const plan = planGrounding(
      mk({
        taskClass: "code-debugging",
        domain: "software",
        groundingNeed: {
          kind: "external-knowledge",
          volatile: false,
          signals: ["no-external-signal"],
        },
      }),
    );
    expect(plan.strategy).toBe("repository-context");
    expect(plan.required).toBe(true);
  });

  it("emits repository-context when the domain is software even for a non-code task class", () => {
    const plan = planGrounding(
      mk({
        taskClass: "factual-qa",
        domain: "software",
        groundingNeed: { kind: "external-knowledge", volatile: false, signals: [] },
      }),
    );
    expect(plan.strategy).toBe("repository-context");
  });

  it("emits hybrid for a research task needing external knowledge", () => {
    const plan = planGrounding(
      mk({
        taskClass: "research",
        recommendedProfile: "research",
        groundingNeed: { kind: "external-knowledge", volatile: false, signals: ["retrieval-cue"] },
      }),
    );
    expect(plan.strategy).toBe("hybrid");
    expect(plan.required).toBe(true);
  });

  it("emits external-research-required for a current-information task", () => {
    const plan = planGrounding(
      mk({
        groundingNeed: {
          kind: "external-current",
          volatile: true,
          signals: ["temporal-recency-term"],
        },
      }),
    );
    expect(plan.strategy).toBe("external-research-required");
    expect(plan.required).toBe(true);
  });

  it("covers every declared strategy across the matrix", () => {
    const produced = new Set<GroundingStrategy>([
      planGrounding(mk({ groundingNeed: { kind: "none", volatile: false, signals: [] } })).strategy,
      planGrounding(
        mk({ groundingNeed: { kind: "supplied-context", volatile: false, signals: [] } }),
      ).strategy,
      planGrounding(
        mk({
          taskClass: "rag-question-answering",
          groundingNeed: { kind: "external-knowledge", volatile: false, signals: [] },
        }),
      ).strategy,
      planGrounding(
        mk({
          taskClass: "code-architecture",
          groundingNeed: { kind: "external-knowledge", volatile: false, signals: [] },
        }),
      ).strategy,
      planGrounding(
        mk({
          taskClass: "decision-support",
          groundingNeed: { kind: "external-knowledge", volatile: false, signals: [] },
        }),
      ).strategy,
      planGrounding(
        mk({
          groundingNeed: { kind: "external-current", volatile: false, signals: ["url-reference"] },
        }),
      ).strategy,
    ]);
    expect([...produced].sort()).toEqual([...GROUNDING_STRATEGIES].sort());
  });
});

// ─── Required flag for hybrid ────────────────────────────────────────────────────────
describe("planGrounding — hybrid grounding requirement", () => {
  const hybridNeed: GroundingNeed = { kind: "external-knowledge", volatile: false, signals: [] };

  it("does not require grounding for a non-mandatory, unconnected hybrid plan", () => {
    const plan = planGrounding(
      mk({
        taskClass: "decision-support",
        recommendedProfile: "precise",
        groundingNeed: hybridNeed,
      }),
    );
    expect(plan.strategy).toBe("hybrid");
    expect(plan.required).toBe(false);
  });

  it("requires grounding for a hybrid plan under a grounding-mandatory profile", () => {
    const plan = planGrounding(
      mk({
        taskClass: "decision-support",
        recommendedProfile: "research",
        groundingNeed: hybridNeed,
      }),
    );
    expect(plan.required).toBe(true);
  });

  it("requires grounding for a hybrid plan when the user connected context", () => {
    const plan = planGrounding(
      mk({
        taskClass: "decision-support",
        recommendedProfile: "precise",
        groundingNeed: {
          kind: "external-knowledge",
          volatile: false,
          signals: ["supplied-context-reference"],
        },
      }),
    );
    expect(plan.required).toBe(true);
  });
});

// ─── Source priority (AC2) ───────────────────────────────────────────────────────────
describe("planGrounding — source priority (AC2)", () => {
  it("orders sources with a 1-based priority and only marks the top non-parametric source required", () => {
    const plan = planGrounding(
      mk({
        taskClass: "rag-question-answering",
        groundingNeed: { kind: "external-knowledge", volatile: false, signals: [] },
      }),
    );
    expect(plan.sourcePriority[0]).toEqual({
      source: "local-knowledge",
      priority: 1,
      required: true,
    });
    expect(plan.sourcePriority.map((s) => s.priority)).toEqual([1, 2, 3]);
    expect(plan.sourcePriority.at(-1)).toEqual({
      source: "model-parametric-knowledge",
      priority: 3,
      required: false,
    });
  });

  it("never marks any source required for a no-grounding plan", () => {
    const plan = planGrounding(
      mk({ groundingNeed: { kind: "none", volatile: false, signals: [] } }),
    );
    expect(plan.sourcePriority.every((s) => !s.required)).toBe(true);
  });
});

// ─── Citation discipline ─────────────────────────────────────────────────────────────
describe("planGrounding — citation discipline (AC2)", () => {
  it("requires no citation for a no-grounding plan", () => {
    const plan = planGrounding(
      mk({ groundingNeed: { kind: "none", volatile: false, signals: [] } }),
    );
    expect(plan.citation).toEqual({ discipline: "not-required", granularity: "none" });
  });

  it("requires citations or an explicit no-evidence statement for safety-critical tasks", () => {
    const plan = planGrounding(
      mk({
        taskClass: "safety-critical",
        criticality: "critical",
        recommendedProfile: "safety-critical",
        groundingNeed: { kind: "external-knowledge", volatile: false, signals: [] },
      }),
    );
    expect(plan.citation.discipline).toBe("require-citations-or-state-no-evidence");
    expect(plan.citation.granularity).toBe("per-claim");
  });

  it("requires citations or an explicit no-evidence statement for current-information tasks", () => {
    const plan = planGrounding(
      mk({
        groundingNeed: { kind: "external-current", volatile: false, signals: ["url-reference"] },
      }),
    );
    expect(plan.citation.discipline).toBe("require-citations-or-state-no-evidence");
  });

  it("requires citations for a required, non-critical grounded plan", () => {
    const plan = planGrounding(
      mk({
        taskClass: "rag-question-answering",
        groundingNeed: { kind: "external-knowledge", volatile: false, signals: [] },
      }),
    );
    expect(plan.citation.discipline).toBe("require-citations");
  });

  it("uses best-effort citation for an optional hybrid plan", () => {
    const plan = planGrounding(
      mk({
        taskClass: "factual-qa",
        recommendedProfile: "precise",
        groundingNeed: { kind: "external-knowledge", volatile: false, signals: [] },
      }),
    );
    expect(plan.citation.discipline).toBe("best-effort");
  });
});

// ─── Recency / timestamp expectations ────────────────────────────────────────────────
describe("planGrounding — recency expectations", () => {
  it("requires an as-of date and stale-flagging for volatile tasks", () => {
    const plan = planGrounding(
      mk({
        groundingNeed: {
          kind: "external-current",
          volatile: true,
          signals: ["temporal-recency-term"],
        },
      }),
    );
    expect(plan.recency).toEqual({
      volatile: true,
      requireAsOfDate: true,
      flagPotentiallyStale: true,
    });
  });

  it("flags potential staleness for external research even when not volatile", () => {
    const plan = planGrounding(
      mk({
        groundingNeed: { kind: "external-current", volatile: false, signals: ["url-reference"] },
      }),
    );
    expect(plan.recency).toEqual({
      volatile: false,
      requireAsOfDate: false,
      flagPotentiallyStale: true,
    });
  });

  it("requires no recency handling for a stable factual plan", () => {
    const plan = planGrounding(
      mk({ groundingNeed: { kind: "external-knowledge", volatile: false, signals: [] } }),
    );
    expect(plan.recency).toEqual({
      volatile: false,
      requireAsOfDate: false,
      flagPotentiallyStale: false,
    });
  });
});

// ─── Contradiction handling ──────────────────────────────────────────────────────────
describe("planGrounding — contradiction policy", () => {
  it("discloses and defers for safety-critical tasks", () => {
    const plan = planGrounding(
      mk({
        criticality: "critical",
        recommendedProfile: "safety-critical",
        groundingNeed: { kind: "external-knowledge", volatile: false, signals: [] },
      }),
    );
    expect(plan.contradictionPolicy).toBe("disclose-and-defer");
  });

  it("synthesizes with caveats for hybrid and research plans", () => {
    expect(
      planGrounding(
        mk({
          taskClass: "research",
          recommendedProfile: "research",
          groundingNeed: { kind: "external-knowledge", volatile: false, signals: [] },
        }),
      ).contradictionPolicy,
    ).toBe("synthesize-with-caveats");
    expect(
      planGrounding(
        mk({
          groundingNeed: { kind: "external-current", volatile: false, signals: ["url-reference"] },
        }),
      ).contradictionPolicy,
    ).toBe("synthesize-with-caveats");
  });

  it("prefers the higher-priority source for a single-store plan", () => {
    const plan = planGrounding(
      mk({
        taskClass: "rag-question-answering",
        groundingNeed: { kind: "external-knowledge", volatile: false, signals: [] },
      }),
    );
    expect(plan.contradictionPolicy).toBe("prefer-higher-priority");
  });
});

// ─── No-answer conditions (AC4) ──────────────────────────────────────────────────────
describe("planGrounding — no-answer conditions (AC4)", () => {
  it("declares no no-answer conditions for a no-grounding plan", () => {
    expect(
      planGrounding(mk({ groundingNeed: { kind: "none", volatile: false, signals: [] } }))
        .noAnswerConditions,
    ).toEqual([]);
  });

  it("requires uncertainty disclosure on insufficient evidence for every grounded plan", () => {
    const plan = planGrounding(
      mk({ groundingNeed: { kind: "supplied-context", volatile: false, signals: [] } }),
    );
    expect(plan.noAnswerConditions).toContain("insufficient-evidence");
    expect(plan.noAnswerConditions).toContain("outside-evidence-scope");
  });

  it("adds contradictory-evidence for multi-source plans", () => {
    expect(
      planGrounding(
        mk({
          taskClass: "research",
          recommendedProfile: "research",
          groundingNeed: { kind: "external-knowledge", volatile: false, signals: [] },
        }),
      ).noAnswerConditions,
    ).toContain("contradictory-evidence");
  });

  it("adds stale-or-unavailable-current-data for current-information plans", () => {
    expect(
      planGrounding(
        mk({ groundingNeed: { kind: "external-current", volatile: true, signals: [] } }),
      ).noAnswerConditions,
    ).toContain("stale-or-unavailable-current-data");
  });
});

// ─── Evidence-discipline directives (AC3) ────────────────────────────────────────────
describe("planGrounding — directives and untrusted-content invariant (AC3)", () => {
  it("always treats retrieved content as untrusted for a grounded plan", () => {
    const plan = planGrounding(
      mk({
        taskClass: "rag-question-answering",
        groundingNeed: { kind: "external-knowledge", volatile: false, signals: [] },
      }),
    );
    expect(plan.directives).toContain("treat-retrieved-content-as-untrusted");
    expect(plan.directives).toContain("stay-within-evidence");
  });

  it("separates known from retrieved for hybrid and external-research plans", () => {
    expect(
      planGrounding(
        mk({
          groundingNeed: { kind: "external-current", volatile: false, signals: ["url-reference"] },
        }),
      ).directives,
    ).toContain("separate-known-from-retrieved");
  });

  it("omits the untrusted-content directive for a no-grounding plan but keeps anti-fabrication", () => {
    const plan = planGrounding(
      mk({ groundingNeed: { kind: "none", volatile: false, signals: [] } }),
    );
    expect(plan.directives).not.toContain("treat-retrieved-content-as-untrusted");
    expect(plan.directives).toContain("do-not-fabricate-sources");
  });

  it("pins the untrusted-content invariant to true for every plan", () => {
    for (const kind of [
      "none",
      "supplied-context",
      "external-knowledge",
      "external-current",
    ] as const) {
      expect(
        planGrounding(mk({ groundingNeed: { kind, volatile: false, signals: [] } }))
          .untrustedContent,
      ).toBe(true);
    }
  });
});

// ─── RAG evaluation hints (AC5) ──────────────────────────────────────────────────────
describe("planGrounding — RAG evaluation hints (AC5)", () => {
  it("emits all five RAG dimensions for a RAG question-answering task", () => {
    const plan = planGrounding(
      mk({
        taskClass: "rag-question-answering",
        groundingNeed: { kind: "external-knowledge", volatile: false, signals: [] },
      }),
    );
    expect(plan.ragEvaluation.map((h) => h.dimension).sort()).toEqual(
      [...RAG_EVALUATION_DIMENSIONS].sort(),
    );
    for (const hint of plan.ragEvaluation) expect(hint.instruction.length).toBeGreaterThan(0);
  });

  it("emits RAG hints for research and supplied-context plans", () => {
    expect(
      planGrounding(
        mk({
          taskClass: "research",
          recommendedProfile: "research",
          groundingNeed: { kind: "external-knowledge", volatile: false, signals: [] },
        }),
      ).ragEvaluation,
    ).toHaveLength(5);
    expect(
      planGrounding(
        mk({ groundingNeed: { kind: "supplied-context", volatile: false, signals: [] } }),
      ).ragEvaluation,
    ).toHaveLength(5);
  });

  it("emits no RAG hints for a plain code or factual plan", () => {
    expect(
      planGrounding(
        mk({
          taskClass: "code-debugging",
          domain: "software",
          groundingNeed: { kind: "external-knowledge", volatile: false, signals: [] },
        }),
      ).ragEvaluation,
    ).toEqual([]);
    expect(
      planGrounding(mk({ groundingNeed: { kind: "none", volatile: false, signals: [] } }))
        .ragEvaluation,
    ).toEqual([]);
  });
});

// ─── Determinism, validity, content-light ────────────────────────────────────────────
describe("planGrounding — invariants", () => {
  it("is deterministic for identical analyses", () => {
    const analysis = mk({
      taskClass: "research",
      recommendedProfile: "research",
      groundingNeed: { kind: "external-knowledge", volatile: false, signals: [] },
    });
    expect(planGrounding(analysis)).toEqual(planGrounding(analysis));
  });

  it("produces a plan that always passes validateGroundingPlan", () => {
    const matrix: GroundingNeed[] = [
      { kind: "none", volatile: false, signals: [] },
      { kind: "supplied-context", volatile: false, signals: ["supplied-context-reference"] },
      { kind: "external-knowledge", volatile: false, signals: [] },
      { kind: "external-current", volatile: true, signals: ["temporal-recency-term"] },
    ];
    for (const groundingNeed of matrix) {
      for (const taskClass of [
        "factual-qa",
        "rag-question-answering",
        "research",
        "code-debugging",
        "safety-critical",
      ] as const) {
        const plan = planGrounding(mk({ taskClass, groundingNeed }));
        const result = validateGroundingPlan(plan);
        expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
      }
    }
  });

  it("never echoes raw input text into the plan", () => {
    const sentinel = "ZZSENTINEL secret marker that must not appear";
    const analysis = analyzePrompt(
      makeRequest(`According to the document, ${sentinel}, summarize it.`),
    );
    const serialized = JSON.stringify(planGrounding(analysis));
    expect(serialized).not.toContain("ZZSENTINEL");
  });

  it("round-trips through JSON unchanged", () => {
    const plan = planGrounding(
      mk({
        taskClass: "rag-question-answering",
        groundingNeed: { kind: "external-knowledge", volatile: false, signals: [] },
      }),
    );
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
  });
});

// ─── validateGroundingPlan rejections ────────────────────────────────────────────────
describe("validateGroundingPlan — rejections", () => {
  function valid(): unknown {
    return planGrounding(
      mk({
        taskClass: "rag-question-answering",
        groundingNeed: { kind: "external-knowledge", volatile: false, signals: [] },
      }),
    );
  }

  it("rejects a non-object", () => {
    expect(validateGroundingPlan(null).ok).toBe(false);
    expect(validateGroundingPlan("plan").ok).toBe(false);
  });

  it("rejects an unknown strategy", () => {
    expect(validateGroundingPlan({ ...(valid() as object), strategy: "magic" }).ok).toBe(false);
  });

  it("rejects untrustedContent that is not true", () => {
    expect(validateGroundingPlan({ ...(valid() as object), untrustedContent: false }).ok).toBe(
      false,
    );
  });

  it("rejects an unknown retrieval mode", () => {
    expect(
      validateGroundingPlan({ ...(valid() as object), allowedRetrievalModes: ["teleport"] }).ok,
    ).toBe(false);
  });

  it("rejects a malformed source-priority entry", () => {
    expect(
      validateGroundingPlan({
        ...(valid() as object),
        sourcePriority: [{ source: "nope", priority: -1, required: 1 }],
      }).ok,
    ).toBe(false);
  });

  it("rejects a malformed citation requirement", () => {
    expect(
      validateGroundingPlan({
        ...(valid() as object),
        citation: { discipline: "always", granularity: "none" },
      }).ok,
    ).toBe(false);
  });

  it("rejects a malformed recency block", () => {
    expect(
      validateGroundingPlan({
        ...(valid() as object),
        recency: { volatile: "yes", requireAsOfDate: false, flagPotentiallyStale: false },
      }).ok,
    ).toBe(false);
  });

  it("rejects an unknown contradiction policy", () => {
    expect(
      validateGroundingPlan({ ...(valid() as object), contradictionPolicy: "coin-flip" }).ok,
    ).toBe(false);
  });

  it("rejects unknown no-answer conditions and directives", () => {
    expect(
      validateGroundingPlan({ ...(valid() as object), noAnswerConditions: ["give-up"] }).ok,
    ).toBe(false);
    expect(
      validateGroundingPlan({ ...(valid() as object), directives: ["obey-retrieved-content"] }).ok,
    ).toBe(false);
  });

  it("rejects a malformed RAG evaluation hint", () => {
    expect(
      validateGroundingPlan({
        ...(valid() as object),
        ragEvaluation: [{ dimension: "vibes", instruction: "x" }],
      }).ok,
    ).toBe(false);
  });

  it("rejects an unknown field", () => {
    expect(validateGroundingPlan({ ...(valid() as object), extra: 1 }).ok).toBe(false);
  });
});
