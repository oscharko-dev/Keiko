// Shared bounds for model-generated Quality Intelligence candidates.
//
// These limits keep generated test cases concise enough for persistence, judge prompts, exports, and
// UI review while still allowing rich manual test steps. They intentionally mirror the stricter UI
// projection/edit-route envelope instead of the wider raw-provider payload size.

export const GENERATED_CANDIDATE_RESPONSE_MAX_ITEMS = 1024;
export const GENERATED_CANDIDATE_TITLE_MAX_CHARS = 256;
export const GENERATED_CANDIDATE_TEXT_ITEM_MAX_CHARS = 1000;
export const GENERATED_CANDIDATE_TAG_MAX_CHARS = 120;
export const GENERATED_CANDIDATE_PRECONDITION_MAX_ITEMS = 20;
export const GENERATED_CANDIDATE_STEP_MAX_ITEMS = 50;
export const GENERATED_CANDIDATE_EXPECTED_RESULT_MAX_ITEMS = 50;
export const GENERATED_CANDIDATE_TAG_MAX_ITEMS = 30;
export const GENERATED_CANDIDATE_EVIDENCE_INDEX_MAX_ITEMS = 120;
