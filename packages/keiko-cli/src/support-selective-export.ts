// Selective `keiko support export --incident ID | --correlation-id ID | --defect-fingerprint SHA256`
// (#3531, #3534): reuse the query's closure and its persisted evidence. A bounded insufficient
// query is returned honestly so the canonical report can carry its closed insufficiency reasons.

import type { CliIo } from "./runner.js";
import type { loadActivityLog } from "./lazy-modules.js";
import { DEFAULT_SUPPORT_QUERY_LIMITS } from "@oscharko-dev/keiko-activity-log/reader";
import {
  SupportUsageError,
  executeSupportQuery,
  parseSupportSelector,
  recordSupportQueryEvidence,
  recordSupportQueryFailure,
  resolveSupportSelection,
  supportSelectorIsEmpty,
  type SupportQueryRun,
  type SupportSelectorArgs,
} from "./support-query-cli.js";
import { describeErrorKind } from "./support-export.js";

export { selectedLogContent } from "@oscharko-dev/keiko-activity-log/reader";
export type {
  SelectedLogContent,
  SelectedSourceLogFileLines,
  SupportBundleSelection,
} from "@oscharko-dev/keiko-activity-log/reader";

type SelectorParse =
  | { readonly kind: "ok"; readonly selector: SupportSelectorArgs | undefined }
  | { readonly kind: "usage"; readonly message: string };

/** The export's selector flags: closure selectors only; event filters are a query concern. */
export function parseSupportExportSelector(args: readonly string[]): SelectorParse {
  let selector: SupportSelectorArgs;
  try {
    selector = parseSupportSelector(args);
  } catch (error) {
    if (!(error instanceof SupportUsageError)) throw error;
    return { kind: "usage", message: error.message };
  }
  if (supportSelectorIsEmpty(selector)) return { kind: "ok", selector: undefined };
  const filtered = Object.values(selector.filter).some((value) => value !== undefined);
  return filtered
    ? {
        kind: "usage",
        message: "export selects by --incident, --correlation-id or --defect-fingerprint.",
      }
    : { kind: "ok", selector };
}

type LoadedActivityLog = Awaited<ReturnType<typeof loadActivityLog>>;

/**
 * Runs the selection for `keiko support export`. Returns the content to publish, or an exit code
 * when the selection cannot be written honestly (nothing selected, or over the budget).
 */
export async function collectSupportReportQuery(
  selector: SupportSelectorArgs,
  stateDir: string,
  maxBytes: number,
  io: CliIo,
  activityLog: LoadedActivityLog,
  correlationId: string,
): Promise<SupportQueryRun | number> {
  const context = { activityLog, stateDir, correlationId, io, command: "export" as const };
  const run = await runExportSelection(selector, maxBytes, io, context);
  if (typeof run === "number") return run;
  return recordSupportQueryEvidence(context, "export", run) ? run : 1;
}

interface ExportSelectionContext {
  readonly activityLog: LoadedActivityLog;
  readonly stateDir: string;
  readonly correlationId: string;
  readonly io: CliIo;
  readonly command: "export";
}

async function runExportSelection(
  selector: SupportSelectorArgs,
  maxBytes: number,
  io: CliIo,
  context: ExportSelectionContext,
): Promise<SupportQueryRun | number> {
  let stage: "incident-lookup" | "store-listing" = "incident-lookup";
  try {
    const selection = await resolveSupportSelection(selector, context.stateDir, () =>
      Promise.resolve(context.activityLog),
    );
    stage = "store-listing";
    return executeSupportQuery(
      context.stateDir,
      selection,
      { ...DEFAULT_SUPPORT_QUERY_LIMITS, maxResultBytes: maxBytes },
      { trigger: "export" },
    );
  } catch (error) {
    io.err(`keiko support export: the selection could not be read (${describeErrorKind(error)})\n`);
    recordSupportQueryFailure(context, { surface: "export", queryClass: undefined, stage, error });
    return 1;
  }
}
