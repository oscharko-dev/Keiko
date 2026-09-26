import { supportQueryJson, type SupportQueryResult } from "./support-query.js";

export const SUPPORT_EXPORT_SELECTION_KIND = "keiko.support.export-selection";
export const SUPPORT_EXPORT_SELECTION_SCHEMA_VERSION = 1;

/** The manifest's `selection` member: the query verdict, never the events themselves. */
export interface SupportBundleSelection {
  readonly kind: typeof SUPPORT_EXPORT_SELECTION_KIND;
  readonly schemaVersion: typeof SUPPORT_EXPORT_SELECTION_SCHEMA_VERSION;
  readonly query: unknown;
}

/** One source file's contribution to a selective export, in logical-log order. */
export interface SelectedSourceLogFileLines {
  readonly name: string;
  readonly lineCount: number;
  readonly terminalFragment: false;
}

export interface SelectedLogContent {
  readonly contentLines: readonly string[];
  readonly terminalFragment: false;
  readonly sourceLogFiles: readonly string[];
  readonly sourceLogFileLines: readonly SelectedSourceLogFileLines[];
  readonly truncatedLogFiles: readonly string[];
  readonly currentFileTailTruncated: undefined;
  readonly budgetExceeded: false;
  readonly skippedLogFiles: readonly never[];
  readonly selection: SupportBundleSelection;
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
