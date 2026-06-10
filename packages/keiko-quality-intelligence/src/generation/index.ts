// Public barrel for the Quality Intelligence model-routed generation sub-namespace
// (Epic #270, Issue #272/#278/#279). Pure-domain prompt assembly, requirements-text ingestion,
// and model-output parsing. No IO, no model call; the server tier supplies the gateway port.
//
// DETERMINISM-FIRST INVARIANT (Epic #761, Issue #763):
// - The structural stages — coverage mapping, deduplication, validation, and candidate-ID
//   derivation — are 100% deterministic and replayable: `parseGeneratedCandidates` derives every
//   candidate id from a content hash (sha256 of run id + ordinal + title), so identical model
//   text yields identical ids regardless of model, seed, or sampling temperature.
// - The model is invoked ONLY to draft candidate text; its output is an attributed delta. The
//   evidence manifest records which model produced it (`modelId`), the request parameters used
//   (`modelParameters`, e.g. responseFormat), and the seed (`seedUsed`, null when unsupported).
// - Where the model supports seeding, the same inputs + seed reproduce the same sampling; where it
//   does not, the content-hashed ids still make the run replayable for coverage/dedup/validate.
// - No model configured → the deterministic baseline still holds (judge accepts all, refinement
//   skipped); only the drafting step is unavailable.

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
