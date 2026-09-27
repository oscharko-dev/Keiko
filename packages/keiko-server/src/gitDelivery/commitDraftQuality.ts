import {
  countContextTokens,
  deriveContextProfileFromCapability,
} from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import type { GatewayCallRequest, ModelCapability } from "@oscharko-dev/keiko-model-gateway";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import { splitUnifiedDiffSections } from "../gitDiffParser.js";

const OMITTED = "\n[Additional diff lines omitted for the model context budget.]\n";

function requestTokens(request: GatewayCallRequest, capability: ModelCapability): number {
  const schemaTokens =
    request.responseFormat === undefined
      ? 0
      : countContextTokens(JSON.stringify(request.responseFormat), capability.tokenAccounting);
  return countGatewayPromptTokens(request, capability.tokenAccounting) + schemaTokens;
}

function excerpt(section: string, limit: number): string {
  const separator = section.indexOf("\n");
  const header = separator < 0 ? section : section.slice(0, separator);
  const content = separator < 0 ? "" : section.slice(separator + 1);
  if (content.length <= limit) return section;
  if (limit === 0) return header;
  const head = Math.ceil(limit * 0.75);
  const tail = limit - head;
  return (
    header + "\n" + content.slice(0, head) + "\n...\n" + (tail === 0 ? "" : content.slice(-tail))
  );
}

// Allocate each file a share before spending more on a large file. In particular, a lockfile at
// the beginning must never evict the code and tests at the end of a Stage all selection.
function compactDiff(sections: readonly string[], limit: number): string {
  return sections.map((section) => excerpt(section, limit)).join("\n") + OMITTED;
}

export interface PreparedCommitDraft {
  readonly request: GatewayCallRequest | undefined;
  readonly promptTokens: number;
  readonly maxPromptTokens: number;
  readonly diffCompacted: boolean;
}

export function prepareCommitDraft(
  diff: string,
  capability: ModelCapability,
  build: (diff: string, compacted: boolean) => GatewayCallRequest,
): PreparedCommitDraft {
  const profile = deriveContextProfileFromCapability(capability);
  const full = build(diff, false);
  const maxPromptTokens = Math.max(
    0,
    profile.maxInputTokens - (full.maxOutputTokens ?? 0) - profile.safetyMarginTokens,
  );
  const prepare = (request: GatewayCallRequest, diffCompacted: boolean): PreparedCommitDraft => ({
    request,
    diffCompacted,
    maxPromptTokens,
    promptTokens: requestTokens(request, capability),
  });
  const original = prepare(full, false);
  if (original.promptTokens <= maxPromptTokens) return original;
  const parsed = splitUnifiedDiffSections(diff).map((lines) => lines.join("\n"));
  const sections = parsed.length === 0 ? [diff] : parsed;
  let low = 0;
  let high = sections.reduce((largest, section) => Math.max(largest, section.length), 0);
  let selected: PreparedCommitDraft | undefined;
  while (low <= high) {
    const limit = Math.floor((low + high) / 2);
    const candidate = prepare(build(compactDiff(sections, limit), true), true);
    if (candidate.promptTokens <= maxPromptTokens) {
      selected = candidate;
      low = limit + 1;
    } else high = limit - 1;
  }
  if (selected !== undefined) return selected;
  const minimum = prepare(build(compactDiff(sections, 0), true), true);
  const refused = minimum.promptTokens < original.promptTokens ? minimum : original;
  return { ...refused, request: undefined };
}

function takeCommitTrailers(lines: string[]): string[] {
  let start = lines.length;
  while (
    start > 0 &&
    /^(?:BREAKING CHANGE|[A-Za-z][A-Za-z0-9-]*):\s+\S/u.test(lines.at(start - 1)?.trim() ?? "")
  ) {
    start -= 1;
  }
  // A trailer block occupies its own paragraph; an unseparated "Note: ..." remains prose.
  if (start > 0 && lines.at(start - 1)?.trim() !== "") return [];
  return lines.splice(start).map((line) => line.trim());
}

// The model owns the wording; normalize prose into a list while retaining Git trailer syntax.
// Content is never logged here.
export function canonicalCommitBody(body: string): string {
  const lines = body.trim().replace(/\r\n?/gu, "\n").split("\n");
  const trailers = takeCommitTrailers(lines);
  const items: string[] = [];
  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length > 0) items.push(`- ${paragraph.join(" ")}`);
    paragraph = [];
  };
  for (const line of lines) {
    const text = line.trim();
    const bullet = /^(?:[-*•]|\d+[.)])\s+/u.exec(text);
    if (text === "" || bullet !== null) flush();
    if (text !== "") paragraph.push(text.slice(bullet?.[0].length ?? 0));
  }
  flush();
  return [items.join("\n"), trailers.join("\n")].filter((block) => block !== "").join("\n\n");
}
