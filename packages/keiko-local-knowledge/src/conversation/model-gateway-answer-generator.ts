// Production `AnswerGenerator` (Epic #189, Issue #200). Builds a grounding prompt from a
// `LocalKnowledgeGroundedContextPack` and calls the configured model gateway to produce
// the answer text. The runner attaches `[n]` citation markers after generation.
//
// Two hard contracts:
//   1. The gateway is NEVER called when `validateAnswerGrounding` rejects the references.
//      The runner is the primary guard (it short-circuits before reaching the generator),
//      but the generator re-checks defensively so a misuse from a future caller still
//      fails closed. Same belt-and-braces stance as the indexing layer's content-hash
//      check.
//   2. The prompt is shaped DETERMINISTICALLY from the pack — same pack ⇒ same prompt
//      string. The model's response is non-deterministic by nature, but the *input*
//      surface the audit ledger replays is byte-identical.
//
// The generator depends on a `ChatGateway` port (structural — `Gateway.chat` satisfies
// it). We do NOT import the `Gateway` class directly: ADR-0019 direction 3e lets
// keiko-local-knowledge depend on keiko-model-gateway, but pinning the structural port
// keeps the test fakes trivial and isolates this module from constructor churn in the
// real gateway.

import type {
  CapsuleAnswerGroundingPolicy,
  ChatMessage,
  GatewayRequest,
  NormalizedResponse,
} from "@oscharko-dev/keiko-contracts";

import { validateAnswerGrounding } from "../retrieval/answer-grounding.js";
import type { LocalKnowledgeGroundedContextPack } from "../retrieval/context-pack-assembler.js";

import type { AnswerGenerator, AnswerGeneratorInput } from "./types.js";

// Structural port satisfied by `Gateway.chat` from @oscharko-dev/keiko-model-gateway.
// Tests pass a fake implementing this surface so the suite does not require a real
// gateway / network adapter.
export interface ChatGateway {
  readonly chat: (request: GatewayRequest) => Promise<NormalizedResponse>;
}

export interface ModelGatewayAnswerGeneratorOptions {
  readonly chatGateway: ChatGateway;
  readonly modelId: string;
  // The capsule grounding policy the runner resolved. Used by the defensive
  // pre-call check; passing it here keeps the generator self-contained.
  readonly policy: CapsuleAnswerGroundingPolicy;
}

// Surfaced when the defensive grounding check refuses to release refs to the gateway.
// The runner's primary path produces a `noEvidence` answer before this is ever thrown.
// If this error escapes the generator it indicates a caller bypassed the runner — that's
// a real bug, not a user-facing condition.
export class AnswerGroundingRejectedError extends Error {
  public override readonly name: string = "AnswerGroundingRejectedError";
  public constructor() {
    super("Answer grounding policy rejected the references; gateway call refused");
  }
}

export class ModelGatewayAnswerGenerator implements AnswerGenerator {
  private readonly chatGateway: ChatGateway;
  private readonly modelId: string;
  private readonly policy: CapsuleAnswerGroundingPolicy;

  public constructor(options: ModelGatewayAnswerGeneratorOptions) {
    this.chatGateway = options.chatGateway;
    this.modelId = options.modelId;
    this.policy = options.policy;
  }

  public async generate(input: AnswerGeneratorInput): Promise<string> {
    const decision = validateAnswerGrounding(input.references, this.policy);
    if (!decision.allow) {
      // Defensive: the runner already short-circuits the no-evidence path. Reaching
      // this branch means a caller wired the generator outside the runner with refs
      // the policy disallows. Refuse the gateway call rather than leak refs.
      throw new AnswerGroundingRejectedError();
    }
    const messages = buildPromptMessages(input.query.text, input.pack);
    const request: GatewayRequest = {
      modelId: this.modelId,
      messages,
      ...(input.signal !== undefined ? { cancellationSignal: input.signal } : {}),
    };
    const response = await this.chatGateway.chat(request);
    return response.content;
  }
}

// Exported so tests can pin the exact prompt the gateway sees. Determinism contract:
// the returned messages are a pure function of `(question, pack)`; identical inputs
// produce byte-identical messages (citations are pre-sorted by the pack assembler).
export function buildPromptMessages(
  question: string,
  pack: LocalKnowledgeGroundedContextPack,
): readonly ChatMessage[] {
  const citationsBlock = renderCitations(pack);
  return [
    {
      role: "system",
      content:
        "You answer questions strictly from the supplied citations. Cite each claim " +
        "with the matching [n] marker. If the citations do not contain the answer, " +
        "reply 'No evidence found in the supplied citations.'",
    },
    {
      role: "user",
      content: `Question: ${question}\nContext (${String(pack.counts.totalReferences)} citations):\n${citationsBlock}\nAnswer with citations only.`,
    },
  ];
}

function renderCitations(pack: LocalKnowledgeGroundedContextPack): string {
  const lines: string[] = [];
  for (let i = 0; i < pack.citations.length; i += 1) {
    const c = pack.citations[i];
    if (c === undefined) continue;
    const index = i + 1;
    lines.push(`[${String(index)}] ${c.safeDisplayName} (chunk ${String(c.chunkId)})`);
  }
  return lines.join("\n");
}
