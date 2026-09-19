// Selective `keiko support export --incident ID | --correlation-id ID | --defect-fingerprint SHA256`
// (#3531): the report carries only the selection's causal closure plus its bounded context, copied
// verbatim from the Activity Log, instead of whole days of segments.
//
// The selection is the one the query engine computes; it adds no field and no content: every
// exported line is a byte-identical copy of an accepted Activity Log line, and the manifest names
// the selection's closed, versioned verdict. A selection whose diagnostic sufficiency is
// `insufficient` for ANY closed reason — it cannot fit the budget (`--max-bytes`), it cannot be
// found, its causal closure is missing an ancestor, or (#3531 audit) a user-reported incident's
// window holds no registered failure — is never cut to size or exported partially: no report is
// written, the command exits 1, and the verdict is `insufficient` with closed reasons.

import { randomUUID } from "node:crypto";
import type { CliIo } from "./runner.js";
import type { loadServer } from "./lazy-modules.js";
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
import { describeErrorKind, type SourceLogFileLines } from "./support-export.js";
import {
  DEFAULT_SUPPORT_QUERY_LIMITS,
  supportQueryJson,
  type SupportQueryResult,
} from "./support-query.js";

export const SUPPORT_EXPORT_SELECTION_KIND = "keiko.support.export-selection";
export const SUPPORT_EXPORT_SELECTION_SCHEMA_VERSION = 1;

/** The manifest's `selection` member: the query verdict, never the events themselves. */
export interface SupportBundleSelection {
  readonly kind: typeof SUPPORT_EXPORT_SELECTION_KIND;
  readonly schemaVersion: typeof SUPPORT_EXPORT_SELECTION_SCHEMA_VERSION;
  readonly query: unknown;
}

export interface SelectedLogContent {
  readonly contentLines: readonly string[];
  readonly terminalFragment: false;
  readonly sourceLogFiles: readonly string[];
  readonly sourceLogFileLines: readonly SourceLogFileLines[];
  readonly truncatedLogFiles: readonly string[];
  readonly currentFileTailTruncated: undefined;
  readonly budgetExceeded: false;
  readonly skippedLogFiles: readonly never[];
  readonly selection: SupportBundleSelection;
}

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

/** The verbatim lines of the selection, grouped per source file in logical-log order. */
export function selectedLogContent(result: SupportQueryResult): SelectedLogContent {
  const perFile = new Map<string, number>();
  for (const event of result.events) {
    perFile.set(event.file.name, (perFile.get(event.file.name) ?? 0) + 1);
  }
  const { events: _events, ...verdict } = supportQueryJson(result) as Record<string, unknown>;
  return {
    contentLines: result.events.map((event) => event.text),
    terminalFragment: false,
    sourceLogFiles: [...perFile.keys()],
    sourceLogFileLines: [...perFile].map(([name, lineCount]) => ({
      name,
      lineCount,
      terminalFragment: false,
    })),
    truncatedLogFiles: [],
    currentFileTailTruncated: undefined,
    budgetExceeded: false,
    skippedLogFiles: [],
    selection: {
      kind: SUPPORT_EXPORT_SELECTION_KIND,
      schemaVersion: SUPPORT_EXPORT_SELECTION_SCHEMA_VERSION,
      query: verdict,
    },
  };
}

function reportUnwritable(result: SupportQueryResult, io: CliIo): void {
  const verdict = result.diagnosticSufficiency;
  io.err(
    `keiko support export: the selection is ${verdict.status} ` +
      `(${verdict.reasons.join(", ") || "no events"}); no report was written. ` +
      `The selection needs ${String(result.truncation.requiredBytes)} bytes.\n`,
  );
}

type LoadedServer = Awaited<ReturnType<typeof loadServer>>;

/**
 * Runs the selection for `keiko support export`. Returns the content to publish, or an exit code
 * when the selection cannot be written honestly (nothing selected, or over the budget).
 */
export async function collectSelectedLogContent(
  selector: SupportSelectorArgs,
  stateDir: string,
  maxBytes: number,
  io: CliIo,
  server: LoadedServer,
): Promise<SelectedLogContent | number> {
  const context = {
    server,
    stateDir,
    correlationId: randomUUID(),
    io,
    command: "export" as const,
  };
  const run = await runExportSelection(selector, maxBytes, io, context);
  if (typeof run === "number") return run;
  if (!recordSupportQueryEvidence(context, "export", run)) return 1;
  const { result } = run;
  // Every closed insufficient reason (report-budget-exceeded, evidence-not-retained,
  // segment-unreadable, parent-correlation-missing, no-registered-failure, ...) refuses the write:
  // an incomplete or instrumentation-lacking selection is never exported partially, only declared.
  if (result.diagnosticSufficiency.status === "insufficient") {
    reportUnwritable(result, io);
    return 1;
  }
  const verdict = result.diagnosticSufficiency;
  io.err(
    `keiko support export: selected ${String(result.metrics.resultEventCount)} event(s); ` +
      `diagnostic sufficiency ${verdict.status}` +
      (verdict.reasons.length === 0 ? ".\n" : ` (${verdict.reasons.join(", ")}).\n`),
  );
  return selectedLogContent(result);
}

interface ExportSelectionContext {
  readonly server: LoadedServer;
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
      Promise.resolve(context.server),
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
