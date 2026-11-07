import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AtlassianConnectorMetadata } from "@/lib/atlassian-connectors-api";

import type { McpServerChoice } from "../../useMcpServerChoices";
import { useCodingWorkbenchConnectors } from "./useCodingWorkbenchConnectors";

const mocks = vi.hoisted(() => ({
  servers: {
    servers: [] as readonly McpServerChoice[],
    loading: false,
    failed: false,
    reload: vi.fn(),
  },
}));
vi.mock("../../useMcpServerChoices", () => ({
  useMcpServerChoices: (): typeof mocks.servers => mocks.servers,
}));

const READY_POD = "d5f5681e-ce98-4c3c-b27e-51d707c9d018";
const OTHER_POD = "0d6c5d3e-7a41-4f0e-9a52-3c1f8e4b7a10";

function pod(
  podId: string,
  name: string,
  overrides: {
    readonly verificationStatus?: string;
    readonly verificationInProgress?: boolean;
  } = {},
): AtlassianConnectorMetadata {
  return {
    provider: "jira",
    deployment: "data-center",
    authRef: `credential-${podId}`,
    displayName: name,
    baseUrl: "https://jira.example.invalid",
    createdAt: 1,
    livePod: {
      kind: "jira-live",
      podId,
      authenticationGeneration: 1,
      verificationRevision: 1,
      verificationInProgress: overrides.verificationInProgress ?? false,
      verificationStatus: overrides.verificationStatus ?? "ok",
      capabilities: ["live-read", "live-write"],
    },
  } as unknown as AtlassianConnectorMetadata;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.servers = {
    servers: [
      { name: "wiki", state: "connected" },
      { name: "build", state: "idle" },
      { name: "alpha", state: "idle" },
    ],
    loading: false,
    failed: false,
    reload: vi.fn(),
  };
});

describe("the Jira Pod the person picks for the next run", () => {
  it("grants administration only through a separate ready-Pod selection and drops it on every Pod switch", async () => {
    const list = vi.fn(() => Promise.resolve([pod(READY_POD, "Acme Jira"), pod(OTHER_POD, "Other Jira")]));
    const { result } = renderHook(() => useCodingWorkbenchConnectors(list));
    await waitFor(() => expect(result.current.menu.pods).toHaveLength(2));
    expect(result.current.menu.jiraAdministrationEnabled).toBe(false);
    act(() => result.current.menu.onJiraAdministrationChange?.(true));
    expect(result.current.connectorScopes).toBeUndefined();
    act(() => result.current.menu.onPodChange(READY_POD));
    expect(result.current.connectorScopes).toBeUndefined();
    act(() => result.current.menu.onJiraAdministrationChange?.(true));
    expect(result.current.menu.jiraAdministrationEnabled).toBe(true);
    expect(result.current.connectorScopes).toEqual(["issue-tracker.admin"]);
    act(() => result.current.menu.onPodChange(OTHER_POD));
    expect(result.current.menu.jiraAdministrationEnabled).toBe(false);
    expect(result.current.connectorScopes).toBeUndefined();
    act(() => result.current.menu.onPodChange(READY_POD));
    expect(result.current.connectorScopes).toBeUndefined();
    act(() => result.current.menu.onJiraAdministrationChange?.(true));
    act(() => result.current.menu.onJiraAdministrationChange?.(false));
    expect(result.current.connectorScopes).toBeUndefined();
  });

  it("never restores an administration opt-in after the selected Pod lost readiness", async () => {
    let pods = [pod(READY_POD, "Acme Jira")];
    const list = vi.fn(() => Promise.resolve(pods));
    const { result } = renderHook(() => useCodingWorkbenchConnectors(list));
    await waitFor(() => expect(result.current.menu.pods).toHaveLength(1));
    act(() => result.current.menu.onPodChange(READY_POD));
    act(() => result.current.menu.onJiraAdministrationChange?.(true));
    expect(result.current.connectorScopes).toEqual(["issue-tracker.admin"]);
    pods = [pod(READY_POD, "Acme Jira", { verificationInProgress: true })];
    act(() => result.current.menu.onOpen?.());
    await waitFor(() => expect(result.current.jiraPodId).toBeUndefined());
    expect(result.current.connectorScopes).toBeUndefined();
    pods = [pod(READY_POD, "Acme Jira")];
    act(() => result.current.menu.onOpen?.());
    await waitFor(() => expect(result.current.jiraPodId).toBe(READY_POD));
    expect(result.current.menu.jiraAdministrationEnabled).toBe(false);
    expect(result.current.connectorScopes).toBeUndefined();
  });

  it("drops administration after a failed Pod refresh and starts a new window without a selection", async () => {
    const list = vi.fn(() => Promise.resolve([pod(READY_POD, "Acme Jira")]));
    const first = renderHook(() => useCodingWorkbenchConnectors(list));
    await waitFor(() => expect(first.result.current.menu.pods).toHaveLength(1));
    act(() => first.result.current.menu.onPodChange(READY_POD));
    act(() => first.result.current.menu.onJiraAdministrationChange?.(true));
    expect(first.result.current.connectorScopes).toEqual(["issue-tracker.admin"]);
    list.mockRejectedValueOnce(new Error("Synthetic listing unavailable"));
    act(() => first.result.current.menu.onOpen?.());
    await waitFor(() => expect(first.result.current.menu.failed).toBe(true));
    expect(first.result.current.connectorScopes).toBeUndefined();
    act(() => first.result.current.menu.onOpen?.());
    await waitFor(() => expect(first.result.current.menu.loading).toBe(false));
    expect(first.result.current.connectorScopes).toBeUndefined();
    first.unmount();
    const next = renderHook(() => useCodingWorkbenchConnectors(list));
    await waitFor(() => expect(next.result.current.menu.pods).toHaveLength(1));
    expect(next.result.current.jiraPodId).toBeUndefined();
    expect(next.result.current.connectorScopes).toBeUndefined();
  });

  it("offers nothing, and selects nothing, when no ready Pod exists", async () => {
    const list = vi.fn(() =>
      Promise.resolve([
        pod(READY_POD, "Unverified", { verificationStatus: "unverified" }),
        { provider: "jira", deployment: "cloud" } as unknown as AtlassianConnectorMetadata,
      ]),
    );
    const { result } = renderHook(() => useCodingWorkbenchConnectors(list));

    await waitFor(() => expect(result.current.menu.loading).toBe(false));
    expect(result.current.menu.pods).toEqual([{ id: READY_POD, name: "Unverified", ready: false }]);
    expect(result.current.jiraPodId).toBeUndefined();
    expect(result.current.menu.boundPodId).toBeUndefined();
  });

  it("starts at none even with Pods to choose from, then follows an explicit pick", async () => {
    const list = vi.fn(() => Promise.resolve([pod(READY_POD, "Acme Jira")]));
    const { result } = renderHook(() => useCodingWorkbenchConnectors(list));

    await waitFor(() => expect(result.current.menu.pods).toHaveLength(1));
    expect(result.current.menu.boundPodId).toBeUndefined();
    expect(result.current.jiraPodId).toBeUndefined();

    act(() => result.current.menu.onPodChange(READY_POD));
    expect(result.current.menu.boundPodId).toBe(READY_POD);
    expect(result.current.jiraPodId).toBe(READY_POD);

    act(() => result.current.menu.onPodChange(null));
    expect(result.current.jiraPodId).toBeUndefined();
    expect(result.current.menu.boundPodId).toBeUndefined();
  });

  it("drops a pick that is no longer ready instead of sending it unseen", async () => {
    let pods = [pod(READY_POD, "Acme Jira"), pod(OTHER_POD, "Other Jira")];
    const list = vi.fn(() => Promise.resolve(pods));
    const { result } = renderHook(() => useCodingWorkbenchConnectors(list));
    await waitFor(() => expect(result.current.menu.pods).toHaveLength(2));
    act(() => result.current.menu.onPodChange(READY_POD));
    expect(result.current.jiraPodId).toBe(READY_POD);

    pods = [pod(READY_POD, "Acme Jira", { verificationStatus: "failed" }), pod(OTHER_POD, "Other")];
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => expect(result.current.menu.pods[0]?.ready).toBe(false));
    expect(result.current.jiraPodId).toBeUndefined();
    expect(result.current.menu.boundPodId).toBeUndefined();
  });

  it("drops a pick whose verification is running again", async () => {
    let pods = [pod(READY_POD, "Acme Jira")];
    const list = vi.fn(() => Promise.resolve(pods));
    const { result } = renderHook(() => useCodingWorkbenchConnectors(list));
    await waitFor(() => expect(result.current.menu.pods).toHaveLength(1));
    act(() => result.current.menu.onPodChange(READY_POD));
    expect(result.current.jiraPodId).toBe(READY_POD);

    pods = [pod(READY_POD, "Acme Jira", { verificationInProgress: true })];
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => expect(result.current.jiraPodId).toBeUndefined());
  });

  it("never selects an id the listing did not offer", async () => {
    const list = vi.fn(() => Promise.resolve([pod(READY_POD, "Acme Jira")]));
    const { result } = renderHook(() => useCodingWorkbenchConnectors(list));
    await waitFor(() => expect(result.current.menu.pods).toHaveLength(1));

    act(() => result.current.menu.onPodChange(OTHER_POD));

    expect(result.current.jiraPodId).toBeUndefined();
    expect(result.current.menu.boundPodId).toBeUndefined();
  });

  it("never selects a Pod that is not ready", async () => {
    const list = vi.fn(() =>
      Promise.resolve([pod(READY_POD, "Unverified", { verificationStatus: "unverified" })]),
    );
    const { result } = renderHook(() => useCodingWorkbenchConnectors(list));
    await waitFor(() => expect(result.current.menu.pods).toHaveLength(1));

    act(() => result.current.menu.onPodChange(READY_POD));

    expect(result.current.jiraPodId).toBeUndefined();
  });
});

describe("the MCP servers the person picks for the next run", () => {
  const list = (): Promise<AtlassianConnectorMetadata[]> => Promise.resolve([]);

  it("offers every enabled server until the person narrows the selection", async () => {
    const { result } = renderHook(() => useCodingWorkbenchConnectors(list));
    await waitFor(() => expect(result.current.menu.loading).toBe(false));
    expect(result.current.mcpServers).toBeUndefined();
    expect(result.current.menu.selectedServers).toBeUndefined();
    expect(result.current.menu.servers).toBe(mocks.servers.servers);
  });

  it("follows a narrowed selection and resets to all on null", async () => {
    const { result } = renderHook(() => useCodingWorkbenchConnectors(list));
    await waitFor(() => expect(result.current.menu.loading).toBe(false));

    act(() => result.current.menu.onServersChange(["alpha", "wiki"]));
    expect(result.current.mcpServers).toEqual(["alpha", "wiki"]);
    expect(result.current.menu.selectedServers).toEqual(["alpha", "wiki"]);

    act(() => result.current.menu.onServersChange(null));
    expect(result.current.mcpServers).toBeUndefined();
    expect(result.current.menu.selectedServers).toBeUndefined();
  });

  it("keeps an explicitly empty selection distinct from all servers", async () => {
    const { result } = renderHook(() => useCodingWorkbenchConnectors(list));
    await waitFor(() => expect(result.current.menu.loading).toBe(false));

    act(() => result.current.menu.onServersChange([]));

    expect(result.current.mcpServers).toEqual([]);
  });

  it("keeps the server selection independent of the Pod pick", async () => {
    const pods = (): Promise<AtlassianConnectorMetadata[]> =>
      Promise.resolve([pod(READY_POD, "Acme Jira")]);
    const { result } = renderHook(() => useCodingWorkbenchConnectors(pods));
    await waitFor(() => expect(result.current.menu.pods).toHaveLength(1));

    act(() => result.current.menu.onServersChange(["wiki"]));
    act(() => result.current.menu.onPodChange(READY_POD));
    act(() => result.current.menu.onPodChange(null));

    expect(result.current.mcpServers).toEqual(["wiki"]);
    expect(result.current.jiraPodId).toBeUndefined();
  });
});

describe("the connector menu state", () => {
  it("reports loading while either list loads and failure when either fails", async () => {
    const list = vi.fn(() => Promise.resolve([] as AtlassianConnectorMetadata[]));
    mocks.servers = { ...mocks.servers, loading: true };
    const { result, rerender } = renderHook(() => useCodingWorkbenchConnectors(list));
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(result.current.menu.loading).toBe(true);
    expect(result.current.menu.failed).toBe(false);

    mocks.servers = { ...mocks.servers, loading: false, failed: true };
    rerender();
    await waitFor(() => expect(result.current.menu.loading).toBe(false));
    expect(result.current.menu.failed).toBe(true);
  });

  it("reports a failed Pod listing", async () => {
    const list = vi.fn(() => Promise.reject(new Error("offline")));
    const { result } = renderHook(() => useCodingWorkbenchConnectors(list));
    await waitFor(() => expect(result.current.menu.failed).toBe(true));
    expect(result.current.menu.loading).toBe(false);
  });

  it("reads both lists again when the menu opens", async () => {
    const list = vi.fn(() => Promise.resolve([pod(READY_POD, "Acme Jira")]));
    const { result } = renderHook(() => useCodingWorkbenchConnectors(list));
    await waitFor(() => expect(result.current.menu.pods).toHaveLength(1));
    const reads = list.mock.calls.length;

    act(() => result.current.menu.onOpen?.());

    expect(mocks.servers.reload).toHaveBeenCalledOnce();
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(reads));
  });
});
