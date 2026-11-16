// Issue #2245 — the top-level connector management surface: lists connectors, adds one (write-only
// token flow), verifies, manages (scope + sync), and deletes with confirmation. Whole-panel axe
// runs in light AND dark.

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { AtlassianConnectorsPanel } from "./AtlassianConnectorsPanel";
import {
  ATLASSIAN_CONNECTORS_CHANGED_EVENT,
  type AtlassianConnectorMetadata,
  type AtlassianConnectorsClient,
} from "@/lib/atlassian-connectors-api";

const DOCS: AtlassianConnectorMetadata = {
  schemaVersion: "1",
  authRef: "atlassian-cred:AAAAAAAAAAAAAAAAAAAAAA",
  provider: "confluence",
  displayName: "Docs",
  baseUrl: "https://x.atlassian.net",
  authScheme: "basic-api-token",
  createdAt: 1_700_000_000_000,
};

const NEWONE: AtlassianConnectorMetadata = {
  ...DOCS,
  authRef: "atlassian-cred:BBBBBBBBBBBBBBBBBBBBBB",
  displayName: "Ops",
};

function makeClient(overrides: Partial<AtlassianConnectorsClient> = {}): AtlassianConnectorsClient {
  return {
    listConnectors: vi.fn(async () => [DOCS]),
    createConnector: vi.fn(async () => NEWONE),
    updateConnector: vi.fn(async () => DOCS),
    deleteConnector: vi.fn(async () => ({ ok: true as const })),
    verifyConnector: vi.fn(async () => ({ authRef: DOCS.authRef, status: "ok" as const })),
    startSync: vi.fn(async () => ({ job: { jobId: "j", status: "pending" } as never })),
    getSyncJob: vi.fn(async () => ({ job: { jobId: "j", status: "pending" } as never })),
    cancelSyncJob: vi.fn(async () => ({ job: { jobId: "j", status: "cancelled" } as never })),
    listActivity: vi.fn(async () => []),
    listApprovals: vi.fn(async () => []),
    getApproval: vi.fn(async () => ({}) as never),
    approveAction: vi.fn(async () => ({ disposition: "review-required" as const })),
    rejectAction: vi.fn(async () => ({
      approvalId: "x",
      disposition: "review-required" as const,
      outcome: "cancelled" as const,
    })),
    ...overrides,
  };
}

describe("AtlassianConnectorsPanel", () => {
  it.each([false, true])(
    "suppresses empty claims after a failed fetch (Jira Live: %s)",
    async (jiraLive) => {
      const client = makeClient({
        listConnectors: vi
          .fn()
          .mockRejectedValueOnce(new Error("network error"))
          .mockResolvedValue([]),
      });
      render(<AtlassianConnectorsPanel client={client} jiraLive={jiraLive} />);
      const section = screen.getByRole("region", {
        name: jiraLive ? "Jira Live Pods" : "Connectors",
      });
      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(section.querySelector(".acx-empty")).toBeNull();
      act(() => window.dispatchEvent(new Event(ATLASSIAN_CONNECTORS_CHANGED_EVENT)));
      await waitFor(() => expect(section.querySelector(".acx-empty")).toBeInTheDocument());
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );

  it("keeps cached connectors visible when a reload fails", async () => {
    const client = makeClient({
      listConnectors: vi
        .fn()
        .mockResolvedValueOnce([DOCS])
        .mockRejectedValue(new Error("network error")),
    });
    render(<AtlassianConnectorsPanel client={client} />);
    expect(await screen.findByText("Docs")).toBeInTheDocument();
    act(() => window.dispatchEvent(new Event(ATLASSIAN_CONNECTORS_CHANGED_EVENT)));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Docs")).toBeInTheDocument();
  });

  it("lists configured connectors with provider, label, and base URL", async () => {
    render(<AtlassianConnectorsPanel client={makeClient()} pollIntervalMs={100000} />);
    const card = await screen.findByTestId("acx-connector");
    expect(card).toHaveTextContent("Docs");
    expect(card).toHaveTextContent("Confluence");
    expect(card).toHaveTextContent("https://x.atlassian.net");
  });

  it("adds a connector and shows it in the list", async () => {
    const user = userEvent.setup();
    const client = makeClient();
    render(<AtlassianConnectorsPanel client={client} pollIntervalMs={100000} />);
    await screen.findByTestId("acx-connector");
    await user.click(screen.getByRole("button", { name: "Add connector" }));
    await user.type(screen.getByLabelText("Label"), "Ops");
    await user.type(screen.getByLabelText("Base URL"), "https://x.atlassian.net");
    await user.type(screen.getByLabelText("Account email"), "me@example.com");
    await user.type(screen.getByLabelText("API token"), "tok");
    await user.click(screen.getByRole("button", { name: "Save connector" }));
    expect(await screen.findByText("Ops")).toBeInTheDocument();
  });
  it("retains a newly created connector when an earlier list response arrives late", async () => {
    let finish: ((value: readonly AtlassianConnectorMetadata[]) => void) | undefined;
    const client = makeClient({
      listConnectors: vi.fn(
        () =>
          new Promise<readonly AtlassianConnectorMetadata[]>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    const user = userEvent.setup();
    render(<AtlassianConnectorsPanel client={client} />);
    await user.click(screen.getByRole("button", { name: "Add connector" }));
    await user.type(screen.getByLabelText("Label"), "Ops");
    await user.type(screen.getByLabelText("Base URL"), "https://x.atlassian.net");
    await user.type(screen.getByLabelText("Account email"), "me@example.com");
    await user.type(screen.getByLabelText("API token"), "synthetic-pat");
    await user.click(screen.getByRole("button", { name: "Save connector" }));
    expect(await screen.findByText("Ops")).toBeVisible();
    await act(async () => {
      finish?.([]);
    });
    expect(screen.getByText("Ops")).toBeVisible();
  });
  it("observes credential changes through an authoritative GET", async () => {
    const client = makeClient({
      listConnectors: vi.fn().mockResolvedValueOnce([DOCS]).mockResolvedValue([]),
    });
    render(<AtlassianConnectorsPanel client={client} />);
    expect(await screen.findByText("Docs")).toBeVisible();
    act(() => {
      window.dispatchEvent(new Event(ATLASSIAN_CONNECTORS_CHANGED_EVENT));
    });
    await waitFor(() => expect(screen.queryByText("Docs")).toBeNull());
    expect(client.listConnectors).toHaveBeenCalledTimes(2);
    expect(client.deleteConnector).not.toHaveBeenCalled();
  });

  it("verifies a connector inline and reveals the sync surface on manage", async () => {
    const user = userEvent.setup();
    const client = makeClient();
    render(<AtlassianConnectorsPanel client={client} pollIntervalMs={100000} />);
    await screen.findByTestId("acx-connector");
    await user.click(screen.getByRole("button", { name: "Verify connection" }));
    await waitFor(() => expect(vi.mocked(client.verifyConnector)).toHaveBeenCalled());
    expect(await screen.findByTestId("acx-verify-status")).toHaveAttribute("data-status", "ok");
    await user.click(screen.getByRole("button", { name: "Manage" }));
    expect(screen.getByTestId("acx-sync")).toBeInTheDocument();
  });

  it("deletes a connector after confirmation", async () => {
    const user = userEvent.setup();
    const client = makeClient();
    render(<AtlassianConnectorsPanel client={client} pollIntervalMs={100000} />);
    await screen.findByTestId("acx-connector");
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete connector" }));
    await waitFor(() =>
      expect(vi.mocked(client.deleteConnector)).toHaveBeenCalledWith(DOCS.authRef),
    );
    await waitFor(() => expect(screen.queryByText("Docs")).toBeNull());
  });

  it("has no axe violations across the loaded panel (light and dark)", async () => {
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.setAttribute("data-theme", theme);
      const { container, unmount } = render(
        <AtlassianConnectorsPanel client={makeClient()} pollIntervalMs={100000} />,
      );
      await screen.findByTestId("acx-connector");
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
    document.documentElement.removeAttribute("data-theme");
  });
});

it("shows only owned Live Pods in the Hub without sync or legacy approvals", async () => {
  const user = userEvent.setup();
  const live: AtlassianConnectorMetadata = {
    ...DOCS,
    provider: "jira",
    deployment: "data-center",
    authScheme: "bearer-pat",
    generation: 1,
    displayName: "Live Jira",
    livePod: {
      kind: "jira-live",
      podId: "pod-one",
      authenticationGeneration: 1,
      verificationRevision: 1,
      verificationStatus: "ok",
      verificationInProgress: false,
      capabilities: ["live-read"],
    },
  };
  const client = makeClient({ listConnectors: vi.fn(async () => [DOCS, live]) });
  const { container } = render(<AtlassianConnectorsPanel client={client} jiraLive />);
  const card = await screen.findByTestId("acx-connector");
  expect(card).toHaveTextContent("Live Jira");
  expect(card).not.toHaveTextContent("Ready");
  expect(card).not.toHaveTextContent(live.baseUrl);
  const addToWorkspace = screen.getByRole("button", { name: "Add to workspace" });
  expect(addToWorkspace).toBeVisible();
  expect(addToWorkspace).toHaveClass("lk-btn-ghost");
  expect(addToWorkspace).not.toHaveClass("lk-btn-primary");
  const jiraLogo = within(card).getByRole("img", { name: "Jira" });
  expect(jiraLogo).toHaveAttribute("src", "/assets/brands/jira.svg?v=ad20a139");
  expect(jiraLogo).toHaveAttribute("width", "15");
  expect(jiraLogo).toHaveAttribute("height", "15");
  expect(jiraLogo.parentElement).toHaveClass("lk-capsule-icon");
  expect(within(card).getByText("Live Jira")).toHaveClass("lk-capsule-name");
  expect(jiraLogo.closest("button")).toHaveAttribute("draggable", "true");
  expect(jiraLogo.closest("button")).toHaveAccessibleName(
    "Drag Jira Pod Live Jira to the workspace",
  );
  const workspace = document.createElement("main");
  workspace.className = "workspace";
  document.body.appendChild(workspace);
  const elementFromPoint = document.elementFromPoint;
  document.elementFromPoint = vi.fn(() => workspace);
  const onDrop = vi.fn();
  window.addEventListener("keiko:local-knowledge-connector-drop", onDrop);
  try {
    const handle = within(card).getByRole("button", {
      name: "Drag Jira Pod Live Jira to the workspace",
    });
    fireEvent.pointerDown(handle, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 80, clientY: 90 });
    fireEvent.pointerUp(window, { clientX: 120, clientY: 140 });
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop.mock.calls[0]?.[0].detail).toEqual({
      payload: { kind: "jira-live", id: "pod-one", label: "Live Jira" },
      clientX: 120,
      clientY: 140,
    });
  } finally {
    window.removeEventListener("keiko:local-knowledge-connector-drop", onDrop);
    document.elementFromPoint = elementFromPoint;
    workspace.remove();
  }
  expect(screen.queryByText("Docs")).toBeNull();
  expect(screen.queryByRole("button", { name: /manage/i })).toBeNull();
  expect(client.listApprovals).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Create Jira Pod" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "More actions: Live Jira" }));
  await user.click(screen.getByRole("menuitem", { name: "Verify connection" }));
  await waitFor(() => expect(client.listConnectors).toHaveBeenCalledTimes(2));
  expect(await axe(container)).toHaveNoViolations();
});

it("renders the live Jira Pods as one Knowledge Pods page section", async () => {
  render(
    <AtlassianConnectorsPanel
      jiraLive
      client={makeClient({ listConnectors: vi.fn(async () => []) })}
      pollIntervalMs={100000}
    />,
  );
  await screen.findByText("No Jira Pods yet.");
  // A page section heading like the pod list's, without a nested "Connectors" heading.
  const heading = screen.getByRole("heading", { level: 2, name: "Jira Live Pods" });
  const create = screen.getByRole("button", { name: "Create Jira Pod" });
  expect(heading).toBeVisible();
  expect(heading).toHaveClass("lk-title");
  expect(create).toHaveClass("lk-btn-primary", "lk-btn-lg");
  expect(create.parentElement).toBe(heading.parentElement);
  expect(
    create.compareDocumentPosition(screen.getByText("No Jira Pods yet.")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0);
  expect(screen.queryByRole("heading", { name: "Connectors" })).toBeNull();
  expect(screen.getByRole("region", { name: "Jira Live Pods" })).toBeVisible();
  expect(screen.getByTestId("acx-panel")).toHaveProperty(
    "className",
    expect.stringMatching(/cmpEmbedded/),
  );
});

it("describes an empty live Jira Hub without offering a connector sync", async () => {
  render(
    <AtlassianConnectorsPanel
      jiraLive
      client={makeClient({ listConnectors: vi.fn(async () => []) })}
      pollIntervalMs={100000}
    />,
  );
  expect(await screen.findByText("No Jira Pods yet.")).toBeVisible();
  expect(screen.queryByText(/sync Confluence spaces/u)).toBeNull();
});
