import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";

// Report sections whose pages list findings the human asked to see one by one: a deviation or an
// issue without an epic is not summarised away. Figure sections (statuses, epics) are not listed.
const FINDING_SECTIONS: ReadonlySet<string> = new Set(["deviations", "orphans"]);
const REPORT_TOOL = "keiko.jira.report";
const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,63}-\d{1,12}$/u;

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/** Issue keys of one completed finding page, in page order. */
function findingKeys(exchange: ChatToolExchange): readonly string[] {
  const { result } = exchange;
  if (result?.status !== "completed" || result.toolRef?.canonicalId !== REPORT_TOOL) return [];
  const section = record(record(result.data)?.section);
  if (typeof section?.name !== "string" || !FINDING_SECTIONS.has(section.name)) return [];
  if (!Array.isArray(section.items)) return [];
  return section.items
    .map((item) => record(item)?.key)
    .filter((key): key is string => typeof key === "string" && ISSUE_KEY.test(key));
}

function mentions(answer: string, key: string): boolean {
  return new RegExp(String.raw`(?<![A-Z0-9_-])${key}(?!\d)`, "u").test(answer);
}

/**
 * The issue keys that finding pages of `jira.report` read in this turn list and the answer leaves
 * out. Keiko computes every finding; a listing answer that drops one silently misreports the
 * project (S11 of epic #4173: Gemma left out all seven estimate deviations the report listed).
 */
export function omittedReportFindingKeys(
  exchanges: readonly ChatToolExchange[],
  answer: string,
): readonly string[] {
  const listed = [...new Set(exchanges.flatMap(findingKeys))];
  return listed.filter((key) => !mentions(answer, key));
}

/** The one correction a turn gets when its answer leaves out listed findings. */
export function reportFindingCorrection(omitted: readonly string[]): string {
  return (
    `Your answer leaves out ${String(omitted.length)} issue(s) that the jira.report pages read in ` +
    `this turn list: ${omitted.join(", ")}. Answer again in full: name every listed issue with ` +
    "its finding as the report states it."
  );
}
