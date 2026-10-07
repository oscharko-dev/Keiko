// Registry-shaped Activity Log lines for the tests of the live-lab tools. A fixture line names an
// operation and its fields the way the product persists them (registered fields at the top level
// beside ts, correlationId and durationMs), and every registered field it carries is checked
// against docs/observability/op-catalog.generated.json: a fixture can never keep a name the
// registry has dropped, and no formula or vocabulary is restated here.
import { contractDrift, readOpCatalog } from "../../testing/coding-workbench-lab/op-contract.mjs";

export const CATALOG = readOpCatalog();
/** The run's own correlation id, and the trailing digits a tool is given to find it. */
export const RUN = "run-2026100710000012345";
export const RUN_SUFFIX = "0012345";

const START_MS = Date.parse("2026-10-07T10:00:00.000Z");

/** The ISO timestamp `offsetSeconds` after the fixed start of every fixture run. */
export function isoAt(offsetSeconds) {
  return new Date(START_MS + Math.round(offsetSeconds * 1000)).toISOString();
}

/** One persisted line; its registered fields must exist in the op catalog. */
export function registryLine(op, offset, correlationId, fields = {}, envelope = {}) {
  const problems = contractDrift({ [op]: Object.keys(fields) }, CATALOG);
  if (problems.length > 0) {
    throw new Error(`fixture is not registry-shaped: ${problems.join("; ")}`);
  }
  return { ts: isoAt(offset), op, correlationId, ...envelope, ...fields };
}

export function byTime(events) {
  return events.toSorted((left, right) => left.ts.localeCompare(right.ts));
}
