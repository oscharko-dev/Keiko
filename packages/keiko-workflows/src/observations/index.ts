// Barrel for the tool-observation shapers (ADR-0054, PR3-W3). Re-exports the shapers and shared
// helpers worth exposing to lane assembly and production artifact-writer wiring.

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
  type ToolResultArtifactWriter,
} from "./shared.js";
