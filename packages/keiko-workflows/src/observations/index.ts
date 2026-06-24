// Barrel for the tool-observation shapers (ADR-0054, PR3-W3). Re-exports the three pure shapers and
// the shared helpers worth exposing to the PR4 lane assembler. No live browser shaper in PR3 (D8).

export { shapeCommandObservation, type ShapeCommandOptions } from "./command.js";
export { shapeTestObservation, type ShapeTestOptions } from "./test.js";
export { shapeSearchObservation, type ShapeSearchOptions } from "./search.js";
export {
  makeObservationId,
  injectionSignalsFor,
  boundExcerpt,
  buildToolRehydrationHandle,
  type InjectionSummary,
  type RehydrationHandleInput,
} from "./shared.js";
