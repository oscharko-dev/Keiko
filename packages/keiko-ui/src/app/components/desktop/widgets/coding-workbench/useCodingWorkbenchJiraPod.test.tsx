import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AtlassianConnectorMetadata } from "@/lib/atlassian-connectors-api";

import { useCodingWorkbenchJiraPod } from "./useCodingWorkbenchJiraPod";

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

describe("the Jira Pod the person picks for the next run", () => {
  it("offers nothing, and selects nothing, when no ready Pod exists", async () => {
    const list = vi.fn(() =>
      Promise.resolve([
        pod(READY_POD, "Unverified", { verificationStatus: "unverified" }),
        { provider: "jira", deployment: "cloud" } as unknown as AtlassianConnectorMetadata,
      ]),
    );
    const { result } = renderHook(() => useCodingWorkbenchJiraPod(list));

    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(result.current.selection).toBeUndefined();
    expect(result.current.podId).toBeUndefined();
  });

  it("starts at none even with Pods to choose from, then follows an explicit pick", async () => {
    const list = vi.fn(() => Promise.resolve([pod(READY_POD, "Acme Jira")]));
    const { result } = renderHook(() => useCodingWorkbenchJiraPod(list));

    await waitFor(() => expect(result.current.selection?.choices).toHaveLength(1));
    expect(result.current.selection?.value).toBe("");
    expect(result.current.podId).toBeUndefined();

    act(() => result.current.selection?.onChange(READY_POD));
    expect(result.current.selection?.value).toBe(READY_POD);
    expect(result.current.podId).toBe(READY_POD);

    act(() => result.current.selection?.onChange(""));
    expect(result.current.podId).toBeUndefined();
  });

  it("drops a pick that is no longer offered as a ready Pod instead of sending it unseen", async () => {
    let pods = [pod(READY_POD, "Acme Jira"), pod(OTHER_POD, "Other Jira")];
    const list = vi.fn(() => Promise.resolve(pods));
    const { result } = renderHook(() => useCodingWorkbenchJiraPod(list));
    await waitFor(() => expect(result.current.selection?.choices).toHaveLength(2));
    act(() => result.current.selection?.onChange(READY_POD));
    expect(result.current.podId).toBe(READY_POD);

    pods = [pod(READY_POD, "Acme Jira", { verificationStatus: "failed" }), pod(OTHER_POD, "Other")];
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() =>
      expect(result.current.selection?.choices.map((p) => p.id)).toEqual([OTHER_POD]),
    );
    expect(result.current.podId).toBeUndefined();
    expect(result.current.selection?.value).toBe("");
  });

  it("never selects an id the listing did not offer", async () => {
    const list = vi.fn(() => Promise.resolve([pod(READY_POD, "Acme Jira")]));
    const { result } = renderHook(() => useCodingWorkbenchJiraPod(list));
    await waitFor(() => expect(result.current.selection?.choices).toHaveLength(1));

    act(() => result.current.selection?.onChange(OTHER_POD));

    expect(result.current.podId).toBeUndefined();
  });
});
