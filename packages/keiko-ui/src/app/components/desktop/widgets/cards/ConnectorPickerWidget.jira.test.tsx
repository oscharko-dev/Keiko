import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ATLASSIAN_CONNECTORS_CHANGED_EVENT,
  listAtlassianConnectors,
  type AtlassianConnectorMetadata,
} from "@/lib/atlassian-connectors-api";
import { fetchCapsules } from "@/lib/local-knowledge-api";
import { ConnectorPickerWidget } from "./ConnectorPickerWidget";

vi.mock("@/lib/atlassian-connectors-api", async (original) => ({
  ...(await original<typeof import("@/lib/atlassian-connectors-api")>()),
  listAtlassianConnectors: vi.fn(),
}));
vi.mock("@/lib/local-knowledge-api", async (original) => ({
  ...(await original<typeof import("@/lib/local-knowledge-api")>()),
  fetchCapsules: vi.fn(),
}));

const POD: AtlassianConnectorMetadata = {
  schemaVersion: "1",
  authRef: "synthetic-jira",
  provider: "jira",
  deployment: "data-center",
  authScheme: "bearer-pat",
  generation: 1,
  displayName: "Current Jira name",
  baseUrl: "https://jira.example.invalid",
  createdAt: 1,
  livePod: {
    kind: "jira-live",
    podId: "jira-one",
    authenticationGeneration: 1,
    verificationRevision: 1,
    verificationInProgress: false,
    verificationStatus: "ok",
    capabilities: ["live-read", "live-write"],
  },
};

function node(id = "jira-one"): React.ReactNode {
  return (
    <ConnectorPickerWidget
      presentation="node"
      selectedKind="jira-live"
      selectedId={id}
      selectedLabel="Dropped name"
      onSelect={vi.fn()}
    />
  );
}

describe("saved Jira workspace node", () => {
  it("renders current public Pod identity and live capabilities without reading a capsule catalog", async () => {
    vi.mocked(listAtlassianConnectors).mockResolvedValue([POD]);
    render(node());
    expect(await screen.findByText("Current Jira name")).toBeVisible();
    expect(screen.getByText("Verified Jira Pod")).toBeVisible();
    expect(screen.getByText("Live Jira tools")).toBeVisible();
    expect(fetchCapsules).not.toHaveBeenCalled();
  });

  it("refetches rename, invalidation and deletion instead of trusting the dropped snapshot", async () => {
    vi.mocked(listAtlassianConnectors).mockResolvedValue([POD]);
    render(node());
    await screen.findByText("Current Jira name");
    if (POD.deployment !== "data-center" || POD.livePod === undefined)
      throw new TypeError("Missing fixture");
    vi.mocked(listAtlassianConnectors).mockResolvedValue([
      {
        ...POD,
        displayName: "Renamed Jira",
        livePod: { ...POD.livePod, verificationStatus: "unverified" as const },
      },
    ]);
    act(() => {
      window.dispatchEvent(new Event(ATLASSIAN_CONNECTORS_CHANGED_EVENT));
    });
    expect(await screen.findByText("Renamed Jira")).toBeVisible();
    expect(screen.queryByText("Verified Jira Pod")).not.toBeInTheDocument();
    vi.mocked(listAtlassianConnectors).mockResolvedValue([]);
    await act(async () => {
      window.dispatchEvent(new Event(ATLASSIAN_CONNECTORS_CHANGED_EVENT));
    });
    expect(screen.queryByText("Renamed Jira")).not.toBeInTheDocument();
    expect(screen.getByText(/Jira Pod unavailable/)).toBeVisible();
  });
});
