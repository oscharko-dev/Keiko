import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ChatToolWriteApprovalView } from "@oscharko-dev/keiko-contracts";
import type { CatalogJsonObject, ToolResultEnvelope } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { JiraChatTools } from "./JiraChatTools";
import { JiraWriteApproval } from "./JiraWriteApproval";

type Operation = Extract<ChatToolWriteApprovalView, { kind: "jira-chat-write" }>["operation"];
interface Case { readonly operation: Operation; readonly args: CatalogJsonObject; readonly receipt: CatalogJsonObject }
const COMPONENT = { name: "Reviewed component", description: "", leadUserName: null, assigneeType: "PROJECT_DEFAULT", archived: false, deleted: null };
const VERSION = { name: "Reviewed version", description: "", startDate: null, releaseDate: "2026-01-02", released: false, archived: null };
const REMOTE_VALUE = { globalId: "system:synthetic", applicationType: null, applicationName: "Native application", relationship: null,
  url: "https://remote.invalid/path", title: "Native remote title", summary: "", iconUrl: "https://remote.invalid/icon", iconTitle: null,
  resolved: false, statusIconUrl: null, statusIconTitle: null, statusIconLink: null };
const REMOTE = { id: "31", ...REMOTE_VALUE };
const CONTEXT = { expectedActorKey: "actor-key", expectedProjectId: "10000" };
const VERSION_ARGS = { ...CONTEXT, versionId: "8", expectedVersionSnapshot: VERSION };
const PROJECT = { projectId: "10000", projectKey: "SYN", userKey: "actor-key" };
const LINK_CONTEXT = { issueIdOrKey: "SYN-1", expectedActorKey: "actor-key" };
const LINK = { issueId: "10001", issueKey: "SYN-1", userKey: "actor-key", linkId: "31" };
const RELATION = { inwardIssueIdOrKey: "SYN-1", outwardIssueIdOrKey: "SYN-2", expectedActorKey: "actor-key",
  linkType: { id: "10", name: "Blocks", inward: "is blocked by", outward: "blocks" } };
const EDGE = { ...LINK, linkedIssueId: "10002", linkedIssueKey: "SYN-2", linkTypeId: "10" };
const CASES: readonly Case[] = [
  { operation: "jira.delete-component", args: { ...CONTEXT, componentId: "7", expectedComponentSnapshot: COMPONENT, moveIssuesTo: null },
    receipt: { ...PROJECT, componentId: "7", outcome: "succeeded-unconfirmed", reason: "unavailable" } },
  { operation: "jira.merge-version", args: { ...VERSION_ARGS, moveIssuesTo: "9", expectedTargetSnapshot: { ...VERSION, name: "Reviewed target" } },
    receipt: { ...PROJECT, versionId: "8", targetVersionId: "9", outcome: "succeeded-unconfirmed", reason: "unavailable" } },
  { operation: "jira.move-version", args: { ...VERSION_ARGS, expectedVersionIds: ["9", "8", "10"], afterVersionId: "10" },
    receipt: { ...PROJECT, versionId: "8", outcome: "succeeded" } },
  { operation: "jira.remove-and-swap-version", args: { ...VERSION_ARGS, moveFixIssuesTo: null, moveAffectedIssuesTo: null,
    customFieldReplacementList: [], expectedReplacementVersions: [] },
    receipt: { ...PROJECT, versionId: "8", replacementVersionIds: [], outcome: "succeeded-unconfirmed", reason: "unavailable" } },
  { operation: "jira.create-issue-link", args: RELATION, receipt: { ...EDGE, linkPresent: true, outcome: "succeeded" } },
  { operation: "jira.delete-issue-link", args: { ...RELATION, linkId: "31" }, receipt: { ...EDGE, linkPresent: false, outcome: "succeeded" } },
  { operation: "jira.upsert-remote-link", args: { ...LINK_CONTEXT, expectAbsent: true, value: REMOTE_VALUE }, receipt: { ...LINK, linkPresent: true, outcome: "succeeded" } },
  { operation: "jira.update-remote-link", args: { ...LINK_CONTEXT, linkId: "31", expected: REMOTE, value: { ...REMOTE_VALUE, summary: null } },
    receipt: { ...LINK, linkPresent: true, outcome: "succeeded" } },
  { operation: "jira.delete-remote-link", args: { ...LINK_CONTEXT, linkId: "31", expected: REMOTE }, receipt: { ...LINK, linkPresent: false, outcome: "succeeded" } },
  { operation: "jira.delete-remote-link-by-global-id", args: { ...LINK_CONTEXT, globalId: REMOTE.globalId, expected: REMOTE },
    receipt: { ...LINK, linkPresent: false, outcome: "succeeded" } },
];
function approvalFor(operation: Operation): ChatToolWriteApprovalView {
  return { kind: "jira-chat-write", approvalId: "structural-approval", chatId: "chat-1", podId: "11111111-1111-4111-8111-111111111111",
    bindingGeneration: 1, authenticationGeneration: 1, invocationId: "structural-action", operation, actionDigest: "a".repeat(64),
    requestedAt: Date.now(), expiresAt: Date.now() + 60000, state: "pending" };
}
async function approvePreview(operation: Operation, args: CatalogJsonObject, locale: "en" | "de"): Promise<ReturnType<typeof render>> {
  const approval = approvalFor(operation);
  const result = render(<I18nProvider><JiraWriteApproval approval={approval}
    call={{ id: "structural-action", name: operation.replace(/[.-]/gu, "_"), arguments: args }} turnState="pending"
    observe={vi.fn().mockResolvedValue(approval)} decide={vi.fn()} /></I18nProvider>);
  await waitFor(() => expect(screen.getByRole("button", { name: locale === "en" ? "Approve this action" : "Diese Aktion genehmigen" })).toBeEnabled());
  return result;
}
function savedExchange(name: string, data: CatalogJsonObject, index: number, mutationOutcome?: ChatToolExchange["mutationOutcome"]): ChatToolExchange {
  return { call: { id: `structural-${index}`, name, arguments: {} }, ...(mutationOutcome === undefined ? {} : { mutationOutcome }), result: {
    schemaVersion: 1, invocationId: `structural-${index}`, toolRef: null, projectionDigest: null,
    effectStarted: name !== "jira_remote_link" && name !== "jira_remote_links" && name !== "jira_current_session",
    metrics: { inputBytes: 10, outputBytes: 10, resultCount: 1, durationMs: 10 }, status: "completed", reason: "none",
    page: { truncated: false, reason: "none", cursor: null }, data,
  } };
}
function technicalReads(): readonly ChatToolExchange[] {
  const base = { schemaVersion: 1, invocationId: "technical-read", toolRef: null, projectionDigest: null,
    effectStarted: false, metrics: { inputBytes: 10, outputBytes: 0, resultCount: 0, durationMs: 10 },
    page: null, data: null } as const;
  const results: readonly ToolResultEnvelope[] = [
    { ...base, status: "denied", reason: "effect-denied" },
    { ...base, status: "failed", reason: "handler-failed" },
    { ...base, status: "timeout", reason: "deadline-exceeded" },
    { ...base, status: "cancelled", reason: "parent-cancelled" },
  ];
  return results.map((result, index) => ({ call: { id: `technical-${index}`, name: "jira_current_session", arguments: {} },
    result: { ...result, invocationId: `technical-${index}` } }));
}
function restore(exchanges: readonly ChatToolExchange[]): ReturnType<typeof render> {
  const transcript = JSON.parse(JSON.stringify({ schemaVersion: 1, exchanges })) as ChatToolTranscript;
  const show = (): ReturnType<typeof render> => render(<I18nProvider><JiraChatTools transcript={transcript} turnState="completed" /></I18nProvider>);
  const first = show();
  const previous = first.container.textContent;
  first.unmount();
  const result = show();
  expect(result.container.textContent).toBe(previous);
  for (const summary of result.container.querySelectorAll("details > summary")) fireEvent.click(summary);
  return result;
}
function expectProjectSnapshot(content: string, locale: "en" | "de"): void {
  expect(content).toContain("10000");
  expect(content).toContain(locale === "en" ? "Native metadata not provided (null)" : "Native Metadaten nicht angegeben (null)");
  expect(content).toContain(locale === "en" ? "Boolean: false" : "Wahrheitswert: falsch");
  expect(content).toContain(locale === "en" ? "Value: empty text" : "Wert: leerer Text");
}
function expectSelectors(content: string, args: CatalogJsonObject, locale: "en" | "de"): void {
  if ("expectedProjectId" in args) expectProjectSnapshot(content, locale);
  if ("linkType" in args) for (const value of ["SYN-1", "SYN-2", "Blocks", "is blocked by", "blocks"]) expect(content).toContain(value);
  if ("expected" in args || "value" in args) for (const value of [REMOTE_VALUE.url, REMOTE_VALUE.iconUrl, REMOTE_VALUE.title, REMOTE_VALUE.applicationName]) expect(content).toContain(value);
}
function expectNativeMeaning(content: string, operation: Operation, locale: "en" | "de"): void {
  if (operation === "jira.remove-and-swap-version") expect(content).toContain(locale === "en"
    ? "ALL custom version fields" : "ALLEN benutzerdefinierten Versionsfeldern");
  if (operation === "jira.upsert-remote-link") expect(content).toContain(locale === "en"
    ? "Jira POST creates or replaces" : "Jira POST erstellt oder ersetzt");
  if (operation === "jira.update-remote-link") expect(content).toContain(locale === "en" ? "Requested field value: none (null)." : "Angeforderter Feldwert: nicht vorhanden (null).");
}
afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));
describe.each(["en", "de"] as const)("readable structural Jira changes in %s", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it.each(CASES)("shows every reviewed selector and full snapshot for $operation", async ({ operation, args }) => {
    const { container } = await approvePreview(operation, args, locale);
    const region = screen.getByRole("region", { name: locale === "en" ? "Review Jira action" : "Jira-Aktion prüfen" });
    const content = region.textContent ?? "";
    expect(content).toContain("actor-key");
    expect(content).toContain(locale === "en" ? "Jira does not atomically bind" : "Jira bindet den Schreibvorgang nicht atomar");
    expectSelectors(content, args, locale);
    expectNativeMeaning(content, operation, locale);
    expect(region.querySelector("pre, textarea, details, a, img")).toBeNull();
    expect(content).not.toMatch(/expectedVersionSnapshot|expectedComponentSnapshot|expectedActorKey|statusIconLink/u);
    if (operation === "jira.update-remote-link" || operation === "jira.remove-and-swap-version") expect(await axe(container)).toHaveNoViolations();
  });
  it("shows replacement snapshots, native position and selected custom references without hiding list entries", async () => {
    const { container } = await approvePreview("jira.remove-and-swap-version", { ...VERSION_ARGS, moveFixIssuesTo: "9", moveAffectedIssuesTo: null,
      customFieldReplacementList: [{ customFieldId: "10001", moveTo: "9" }, { customFieldId: "10002", moveTo: null }],
      expectedReplacementVersions: [{ versionId: "9", expectedVersionSnapshot: { ...VERSION, name: "Replacement Nine" } }],
    }, locale);
    for (const value of ["Replacement Nine", "10001", "10002", "2026-01-02"]) expect(container.textContent).toContain(value);
    expect(container.textContent).toContain(locale === "en" ? "Clear this reference; no replacement target." : "Diese Referenz entfernen; kein Ersatzziel.");
    expect(container.textContent).not.toContain(locale === "en" ? "ALL custom version fields" : "ALLEN benutzerdefinierten Versionsfeldern");
  });
  it("restores all ten receipts and complete remote-link read snapshots without linking remote destinations", async () => {
    const exchanges = CASES.map(({ operation, receipt }, index) => savedExchange(operation.replace(/[.-]/gu, "_"),
      { browseUrl: "https://untrusted.invalid/resource", ...receipt }, index, operation === "jira.update-remote-link" ? "unknown" : undefined));
    exchanges.push(savedExchange("jira_remote_link", { outcome: "succeeded", issueId: "10001", issueKey: "SYN-1", id: "31", title: REMOTE.title,
      reviewSnapshotAvailable: true, reviewSnapshot: REMOTE }, 10));
    exchanges.push(savedExchange("jira_remote_links", { outcome: "succeeded", issueId: "10001", issueKey: "SYN-1", items: [
      { id: "32", title: "Incomplete remote value", reviewSnapshotAvailable: false, reviewSnapshot: { ...REMOTE, title: "Excluded stale snapshot" } },
    ], startAt: 0, total: 1 }, 11));
    const { container } = restore(exchanges);
    const names = locale === "en" ? ["Delete Jira component", "Merge Jira versions", "Reorder Jira version", "Remove and replace Jira version references",
      "Create Jira issue link", "Delete Jira issue link", "Create or replace Jira remote link", "Replace Jira remote link", "Delete Jira remote link", "Delete Jira remote link by global ID"]
      : ["Jira-Komponente löschen", "Jira-Versionen zusammenführen", "Jira-Version umordnen", "Jira-Version entfernen und Referenzen ersetzen",
        "Jira-Vorgangsverknüpfung erstellen", "Jira-Vorgangsverknüpfung löschen", "Jira-Remote-Link erstellen oder ersetzen", "Jira-Remote-Link ersetzen", "Jira-Remote-Link löschen", "Jira-Remote-Link anhand globaler ID löschen"];
    for (const name of names) expect(screen.getByRole("group", { name })).toBeVisible();
    const uncertain = screen.getByRole("group", { name: locale === "en" ? "Replace Jira remote link" : "Jira-Remote-Link ersetzen" });
    expect(within(uncertain).getByText(locale === "en" ? "Jira outcome unknown" : "Ausgang der Jira-Aktion unbekannt")).toBeVisible();
    expect(within(uncertain).queryByText(locale === "en" ? "The requested change was independently confirmed for this identity." : "Die angeforderte Änderung wurde für diese Identität unabhängig bestätigt.")).toBeNull();
    for (const value of ["actor-key", "10000", "SYN-1", "SYN-2", REMOTE.url, REMOTE.iconUrl, "Incomplete remote value"]) expect(container.textContent).toContain(value);
    expect(container.textContent).toContain(locale === "en" ? "The complete issue-reference effect remains unconfirmed." : "Die vollständige Wirkung auf Vorgangsreferenzen bleibt unbestätigt.");
    expect(container.textContent).toContain(locale === "en" ? "The complete requested version order" : "Die vollständige angeforderte Versionsreihenfolge");
    expect(container.textContent).toContain(locale === "en" ? "A complete native remote-link review snapshot is unavailable." : "Ein vollständiger nativer Remote-Link-Prüfstand ist nicht verfügbar.");
    expect(container.textContent).not.toMatch(/untrusted\.invalid|Excluded stale snapshot/u);
    expect(container.querySelector("pre, a, img, button")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
  it("keeps authority denial and cancellation actionable after restoring a failed session read", () => {
    const { container } = restore([savedExchange("jira_current_session", { outcome: "failed", reason: "effect-denied" }, 0),
      savedExchange("jira_current_session", { outcome: "failed", reason: "cancelled" }, 1)]);
    expect(container.textContent).toContain(locale === "en" ? "Local authority no longer permits this Jira request." : "Die lokale Autorität erlaubt diese Jira-Anfrage nicht mehr.");
    expect(container.textContent).toContain(locale === "en" ? "This Jira request was cancelled." : "Diese Jira-Anfrage wurde abgebrochen.");
    expect(container.textContent).not.toMatch(/network-error|effect-denied/u);
  });
  it("restores body-free technical read envelopes with their distinct closed causes", async () => {
    const { container } = restore(technicalReads());
    const messages = locale === "en" ? [
      "Local authority no longer permits this Jira request.",
      "Keiko could not finish this Jira read because of an internal handler error.",
      "This Jira read reached its local deadline and is incomplete.", "This Jira request was cancelled.",
    ] : [
      "Die lokale Autorität erlaubt diese Jira-Anfrage nicht mehr.",
      "Keiko konnte diesen Jira-Lesevorgang wegen eines internen Handlerfehlers nicht abschließen.",
      "Dieser Jira-Lesevorgang hat sein lokales Zeitlimit erreicht und ist unvollständig.", "Diese Jira-Anfrage wurde abgebrochen.",
    ];
    for (const message of messages) expect(container.textContent).toContain(message);
    expect(container.querySelector("pre, a, img, button")).toBeNull();
    expect(container.textContent).not.toMatch(/handler-failed|parent-cancelled|deadline-exceeded|network-error/u);
    expect(await axe(container)).toHaveNoViolations();
  });
});
