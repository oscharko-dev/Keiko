import { join } from "node:path";
import { privateJson } from "../private-json.mjs";

/**
 * The public result of a lab step and its private evidence file. A step names its counts in a fixed
 * detail suffix; the evidence file holds the same body-free result plus an optional digest, and the
 * run intent records the result.
 */
export function stepEvidence(step, fileName, describeCounts) {
  const publicResult = (status, reason, counts = {}, evidenceFile) => ({
    step,
    status,
    detail: `${reason}; ${describeCounts(counts)}`,
    counts,
    ...(evidenceFile === undefined ? {} : { evidenceFile }),
  });
  const finish = async (ctx, status, reason, counts = {}, digest) => {
    const evidenceFile = join(ctx.sessionDir, fileName);
    const result = publicResult(status, reason, counts, evidenceFile);
    privateJson(evidenceFile, { schemaVersion: 1, ...result, ...(digest ? { digest } : {}) });
    await ctx.intent.record(step, result);
    return result;
  };
  return { publicResult, finish };
}
