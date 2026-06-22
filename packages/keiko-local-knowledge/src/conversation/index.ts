// Public surface of the conversation/ layer (Epic #189, Issue #200). Wires the #199
// retrieval pipeline into the Conversation Center BFF. Consumers outside this package
// import from the package barrel in ../index.ts; the subdirectory is never imported
// directly (ADR-0019 direction rule 3e + trust-8).

export { runGroundedAnswer, type GroundedAnswerDependencies } from "./grounded-answer-runner.js";

export {
  ModelGatewayAnswerGenerator,
  AnswerGroundingRejectedError,
  buildPromptMessages,
  type ChatGateway,
  type ModelGatewayAnswerGeneratorOptions,
} from "./model-gateway-answer-generator.js";

export { attachCitationsToAnswer, type AttachCitationsResult } from "./citation-attacher.js";

export type {
  AnswerGenerator,
  AnswerGeneratorInput,
  ConversationCitationReference,
  ConversationGroundedAnswer,
  ConversationGroundedQuery,
} from "./types.js";
