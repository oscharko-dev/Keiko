// Declaration for the duration-balanced shard sequencer, so the coverage vitest configs can import
// it under TypeScript's strict noImplicitAny.
import { BaseSequencer } from "vitest/node";

export function readFileDurations(url?: URL): Record<string, number>;
export function assignShard(
  keys: readonly string[],
  durations: Readonly<Record<string, number | undefined>>,
  index: number,
  count: number,
): string[];
export default class DurationSequencer extends BaseSequencer {}
