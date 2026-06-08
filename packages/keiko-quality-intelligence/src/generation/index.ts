// Public barrel for the Quality Intelligence model-routed generation sub-namespace
// (Epic #270, Issue #272/#278/#279). Pure-domain prompt assembly, requirements-text ingestion,
// and model-output parsing. No IO, no model call; the server tier supplies the gateway port.

export {
  QI_TEST_DESIGN_SYSTEM_PROMPT,
  QI_TEST_DESIGN_RESPONSE_SCHEMA,
  buildTestDesignInstruction,
  type BuildTestDesignInstructionInput,
} from "./prompt.js";

export {
  parseGeneratedCandidates,
  type ParseGeneratedCandidatesInput,
  type ParseGeneratedCandidatesResult,
} from "./parseGeneratedCandidates.js";

export {
  splitRequirementsIntoAtoms,
  type IngestedRequirementAtom,
  type SplitRequirementsOptions,
} from "./requirementsIngestion.js";
