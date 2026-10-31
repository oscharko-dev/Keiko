import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  ManagedMcpInvocationContext,
  ManagedMcpToolResult,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { fixtureJira, type FixtureJira, type FixtureOptions } from "./jira-report.fixture.js";
import { createJiraReportStore, type JiraReportStore } from "./jira-report-store.js";
import {
  executeJiraReportTool,
  type JiraReportActivity,
  type JiraReportToolDeps,
} from "./jira-report-tool.js";
import type { JiraReport } from "./jira-report-types.js";

export const NOW = Date.parse("2026-10-31T12:00:00Z");
export interface ConnectionOverrides {
  readonly baseUrl?: string;
  readonly identity?: string;
}
export const CONNECTION = (
  fixture: FixtureJira,
  overrides: ConnectionOverrides = {},
): Parameters<typeof executeJiraReportTool>[2] => ({
  deployment: "data-center",
  baseUrl: overrides.baseUrl ?? "https://jira.example.invalid/context",
  identity: overrides.identity ?? "credential-1",
  http: fixture.http,
});
export const CONTEXT: ManagedMcpInvocationContext = {
  invocationId: "invocation",
  correlationId: "correlation",
  signal: new AbortController().signal,
  beforeEffect: () => true,
};

export interface Harness {
  readonly fixture: FixtureJira;
  readonly store: JiraReportStore;
  readonly activity: JiraReportActivity[];
  readonly run: (
    args: CatalogJsonObject,
    overrides?: ConnectionOverrides,
  ) => Promise<ManagedMcpToolResult>;
  readonly session: (id: string) => JiraReport | undefined;
}
export function harness(
  options: FixtureOptions,
  extra: Partial<JiraReportToolDeps<ManagedMcpInvocationContext>> = {},
): Harness {
  const fixture = fixtureJira(options);
  const store = createJiraReportStore({ now: () => (extra.now ?? ((): number => NOW))() });
  const activity: JiraReportActivity[] = [];
  const deps: JiraReportToolDeps<ManagedMcpInvocationContext> = {
    store,
    owner: () => "chat-1",
    now: () => NOW,
    sleep: () => Promise.resolve(),
    activity: (item) => activity.push(item),
    ...extra,
  };
  return {
    fixture,
    store,
    activity,
    run: (args, overrides) =>
      executeJiraReportTool(args, CONTEXT, CONNECTION(fixture, overrides), deps),
    session: (id) => store.get(id, "chat-1")?.report,
  };
}
export function record(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}
export function idOf(result: ManagedMcpToolResult): string {
  const id = result.data.reportId;
  if (typeof id !== "string") throw new Error("Missing report id");
  return id;
}
export function reportOf(result: ManagedMcpToolResult): Record<string, unknown> {
  return record(result.data.report);
}
