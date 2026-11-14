import type { JiraMutationFailureDetail } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";

/**
 * The refusal of a sprint state change that the sprint's own lifecycle forbids (#4357 AC3): the
 * closed reason alone left a model guessing which move is allowed. One sentence per cause, within
 * the 200-byte bound of a detail message.
 */
export const SPRINT_CLOSED_DETAIL: JiraMutationFailureDetail = {
  messages: ["A closed sprint cannot be changed again. Nothing was changed."],
};
export const SPRINT_STEP_DETAIL: JiraMutationFailureDetail = {
  messages: [
    "A sprint moves from future to active to closed, one step at a time; starting it needs a start and an end date. Nothing was changed.",
  ],
};
export const SPRINT_MEMBERSHIP_CLOSED_DETAIL: JiraMutationFailureDetail = {
  messages: ["A closed sprint takes no more issues. Nothing was changed."],
};
