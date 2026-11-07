import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { JiraChatTools } from "./JiraChatTools";

const CASES: readonly [string, CatalogJsonObject][] = [
  ["jira_cluster_nodes", { items: [{ nodeId: "node-A", alive: false, ip: "192.0.2.10", cacheListenerPort: 40001 }], startAt: 0, total: 1 }],
  ["jira_cluster_upgrade_state", { state: "READY_TO_UPGRADE", build: { buildNumber: 0, version: "11.3.0" } }],
  ["jira_index_snapshot_status", { running: false }],
  ["jira_index_summary", { nodeId: "node-A", reportTime: "2026-11-07T22:00:00+01:00", issueIndex: { indexReadable: false, countInIndex: 0 },
    replicationQueues: [], externalPlatformIndexReplay: [{ nodeId: "node-B", queueSize: 0, lastConsumedOperation: { id: -1, journalWriteTime: "Journal at 21:00" } }] }],
];
afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));
describe.each(["en", "de"] as const)("saved maintenance observations in %s", (locale) => {
  beforeEach(async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
  });
  it("restores four named status cards without network addresses or computed availability", async () => {
    const exchanges = CASES.map(([name, data]): ChatToolExchange => ({ call: { id: name, name, arguments: {} }, result: {
      schemaVersion: 1, invocationId: name, toolRef: null, projectionDigest: null, effectStarted: false,
      metrics: { inputBytes: 10, outputBytes: 10, resultCount: 1, durationMs: 20 },
      status: "completed", reason: "none", page: { truncated: false, reason: "none", cursor: null },
      data: { outcome: "succeeded", ...data },
    } }));
    const restored = JSON.parse(JSON.stringify({ schemaVersion: 1, exchanges })) as ChatToolTranscript;
    const show = (): ReturnType<typeof render> => render(<I18nProvider><JiraChatTools transcript={restored} turnState="completed" /></I18nProvider>);
    const first = show();
    const previous = first.container.textContent;
    first.unmount();
    const { container } = show();
    expect(container.textContent).toBe(previous);
    for (const name of locale === "en" ? [
      "Read Jira cluster node observations", "Read Jira cluster upgrade state", "Read Jira index snapshot status", "Read Jira index summary",
    ] : [
      "Beobachtungen zu Jira-Clusterknoten lesen", "Jira-Cluster-Upgradestatus lesen", "Jira-Index-Snapshotstatus lesen", "Jira-Indexübersicht lesen",
    ]) expect(screen.getByRole("group", { name })).toBeVisible();
    const expected = locale === "en" ? [
      "Native alive flag: false", "The state was not provided.", "Snapshot running flag: false",
      "Reported index count: 0", "Some native index counts were not provided.", "Replication queue observations returned: 0",
      "No maintenance job was started, and they do not establish overall availability.",
    ] : [
      "Natives Alive-Flag: falsch", "Der Zustand wurde nicht bereitgestellt.", "Snapshot-Laufflag: falsch",
      "Gemeldete Indexanzahl: 0", "Einige native Indexzählwerte wurden nicht bereitgestellt.", "Gelieferte Replikationswarteschlangen-Beobachtungen: 0",
      "Kein Wartungsauftrag wurde gestartet; sie belegen keine Gesamtverfügbarkeit.",
    ];
    for (const value of [...expected, "READY_TO_UPGRADE", "Journal at 21:00"])
      expect(container.textContent).toContain(value);
    expect(container.textContent).not.toMatch(/192\.0\.2\.10|40001/u);
    expect(container.querySelector("pre, a, img")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
});
