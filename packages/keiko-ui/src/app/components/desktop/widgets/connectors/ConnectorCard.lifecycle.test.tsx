import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import {
  defaultAtlassianConnectorsClient,
  type AtlassianConnectorMetadata,
  type AtlassianConnectorsClient,
} from "@/lib/atlassian-connectors-api";
import { AtlassianConnectorsPanel } from "./AtlassianConnectorsPanel";
import { ApiError } from "@/lib/api";
import { I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { ConnectorCard } from "./ConnectorCard";

const LIVE: AtlassianConnectorMetadata = {
  schemaVersion: "1",
  authRef: "atlassian-cred:AAAAAAAAAAAAAAAAAAAAAA",
  provider: "jira",
  deployment: "data-center",
  authScheme: "bearer-pat",
  generation: 1,
  displayName: "Lab Jira",
  baseUrl: "https://jira.example.invalid",
  createdAt: 1000,
  livePod: {
    kind: "jira-live",
    podId: "11111111-1111-4111-8111-111111111111",
    authenticationGeneration: 1,
    verificationRevision: 1,
    verificationInProgress: false,
    verificationStatus: "ok",
    capabilities: ["live-read", "live-write"],
  },
};
function client(overrides: Partial<AtlassianConnectorsClient> = {}): AtlassianConnectorsClient {
  return {
    ...defaultAtlassianConnectorsClient,
    listConnectors: vi.fn(async () => [LIVE]),
    updateConnector: vi.fn(async () => LIVE),
    verifyConnector: vi.fn(async () => ({ authRef: LIVE.authRef, status: "ok" as const })),
    deleteConnector: vi.fn(async () => ({ ok: true as const })),
    ...overrides,
  };
}
function rotated(): AtlassianConnectorMetadata {
  if (LIVE.deployment !== "data-center" || LIVE.livePod === undefined)
    throw new Error("Invalid fixture");
  return {
    ...LIVE,
    generation: 2,
    livePod: {
      ...LIVE.livePod,
      authenticationGeneration: 2,
      verificationRevision: 2,
      verificationStatus: "unverified" as const,
    },
  };
}
describe("Jira Pod lifecycle in the existing Hub", () => {
  it("exposes Live actions without Data indexing, sync, export or invented storage state", async () => {
    render(<AtlassianConnectorsPanel client={client()} jiraLive />);
    const card = await screen.findByTestId("acx-connector");
    expect(within(card).getByRole("button", { name: "Verify connection" })).toBeVisible();
    expect(within(card).getByRole("button", { name: "Rename Pod" })).toBeVisible();
    expect(within(card).getByRole("button", { name: "Add to workspace" })).toBeVisible();
    expect(
      within(card).queryByRole("button", { name: /\b(?:index|reindex|sync|export|capsule)\b/iu }),
    ).not.toBeInTheDocument();
    expect(card).not.toHaveTextContent(/\b(?:storage|indexed|vectors?|chunks?|capsules?)\b/iu);
  });
  it("uses the canonical Pod card as the sole verification owner after Jira creation", async () => {
    const api = client({
      listConnectors: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([LIVE]),
      createConnector: vi.fn(async () => LIVE),
    });
    const user = userEvent.setup();
    render(<AtlassianConnectorsPanel client={api} jiraLive />);
    await user.click(screen.getByRole("button", { name: "Create Jira Pod" }));
    await user.type(screen.getByLabelText("Label"), "Lab Jira");
    await user.type(screen.getByLabelText("Base URL"), "https://jira.example.invalid");
    await user.type(screen.getByLabelText("API token"), "synthetic-pat");
    await user.click(screen.getByRole("button", { name: "Save connector" }));
    expect(await screen.findByTestId("acx-connector")).toBeVisible();
    expect(screen.getAllByRole("button", { name: "Verify connection" })).toHaveLength(1);
  });
  it("renames through the generation-bound credential API and retains the Pod identity", async () => {
    const api = client({
      updateConnector: vi.fn(async () => ({ ...LIVE, displayName: "Renamed Jira" })),
    });
    render(<AtlassianConnectorsPanel client={api} jiraLive />);
    await userEvent.click(await screen.findByRole("button", { name: "Rename Pod" }));
    const name = screen.getByLabelText("Label");
    await userEvent.clear(name);
    await userEvent.type(name, "Renamed Jira");
    await userEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect(await screen.findByText("Renamed Jira")).toBeVisible();
    expect(api.updateConnector).toHaveBeenCalledExactlyOnceWith(LIVE.authRef, {
      expectedGeneration: 1,
      displayName: "Renamed Jira",
    });
    expect(screen.getByTestId("acx-connector")).toHaveAttribute("data-auth-ref", LIVE.authRef);
    expect(screen.queryByRole("button", { name: "Manage" })).toBeNull();
  });
  it("clears a replacement PAT at dispatch, prevents duplicates and shows that verification is required", async () => {
    let finish: ((value: AtlassianConnectorMetadata) => void) | undefined;
    const api = client({
      updateConnector: vi.fn(
        () =>
          new Promise<AtlassianConnectorMetadata>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    const { container } = render(<AtlassianConnectorsPanel client={api} jiraLive />);
    await userEvent.click(await screen.findByRole("button", { name: "Replace token" }));
    await userEvent.type(screen.getByLabelText("New API token"), "synthetic-replacement-pat");
    const form = screen.getByRole("form", { name: "Replace Jira token" });
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(api.updateConnector).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("New API token")).toHaveValue("");
    expect(container.innerHTML).not.toContain("synthetic-replacement-pat");
    await act(async () => {
      finish?.(rotated());
    });
    expect(
      await screen.findByText("Verify this connection before using it in Chat."),
    ).toBeVisible();
    expect(screen.queryByLabelText("New API token")).toBeNull();
    expect(screen.queryByText("Connection verified")).toBeNull();
    expect(api.updateConnector).toHaveBeenCalledWith(LIVE.authRef, {
      expectedGeneration: 1,
      apiToken: "synthetic-replacement-pat",
    });
  });
  it("does not restore readiness from a late verification reply after token rotation", async () => {
    let finish: ((value: { authRef: string; status: "ok" }) => void) | undefined;
    const api = client({
      verifyConnector: vi.fn(
        () =>
          new Promise<{ authRef: string; status: "ok" }>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    const onUpdated = vi.fn();
    const { rerender } = render(
      <ConnectorCard connector={LIVE} client={api} onDeleted={vi.fn()} onUpdated={onUpdated} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Verify connection" }));
    rerender(
      <ConnectorCard
        connector={rotated()}
        client={api}
        onDeleted={vi.fn()}
        onUpdated={onUpdated}
      />,
    );
    await act(async () => {
      finish?.({ authRef: LIVE.authRef, status: "ok" });
    });
    expect(screen.queryByText("Connection verified")).toBeNull();
    expect(onUpdated).not.toHaveBeenCalled();
  });
  it("requires state refresh after an uncertain replacement without displaying reflected secrets or replaying the write", async () => {
    const api = client({
      listConnectors: vi.fn().mockResolvedValueOnce([LIVE]).mockResolvedValue([rotated()]),
      updateConnector: vi.fn(async () => {
        throw new ApiError("INTERNAL", "synthetic-replacement-pat", 500);
      }),
    });
    const { container } = render(<AtlassianConnectorsPanel client={api} jiraLive />);
    await userEvent.click(await screen.findByRole("button", { name: "Replace token" }));
    await userEvent.type(screen.getByLabelText("New API token"), "synthetic-replacement-pat");
    await userEvent.click(screen.getByRole("button", { name: "Save token" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be confirmed");
    expect(container.innerHTML).not.toContain("synthetic-replacement-pat");
    expect(screen.queryByText("Connection verified")).toBeNull();
    expect(screen.getByRole("button", { name: "Save token" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("form", { name: "Replace Jira token" }));
    expect(api.updateConnector).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    expect(
      await screen.findByText("Verify this connection before using it in Chat."),
    ).toBeVisible();
    expect(screen.queryByLabelText("New API token")).toBeNull();
    expect(api.updateConnector).toHaveBeenCalledOnce();
  });
  it("supports keyboard name editing and clears a replacement token when cancelled", async () => {
    const api = client();
    const user = userEvent.setup();
    const { container } = render(<AtlassianConnectorsPanel client={api} jiraLive />);
    const rename = await screen.findByRole("button", { name: "Rename Pod" });
    rename.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByLabelText("Label")).toHaveFocus();
    expect(await axe(container)).toHaveNoViolations();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Replace token" }));
    expect(screen.getByLabelText("New API token")).toHaveFocus();
    await user.type(screen.getByLabelText("New API token"), "synthetic-cancelled-pat");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(container.innerHTML).not.toContain("synthetic-cancelled-pat");
    await user.click(screen.getByRole("button", { name: "Replace token" }));
    expect(screen.getByLabelText("New API token")).toHaveValue("");
    expect(api.updateConnector).not.toHaveBeenCalled();
  });
  it("explains removal of all Chat bindings, focuses the safe choice and requires confirmation", async () => {
    const api = client();
    const { container } = render(<AtlassianConnectorsPanel client={api} jiraLive />);
    await userEvent.click(await screen.findByRole("button", { name: "Remove Pod" }));
    const confirm = screen.getByRole("alertdialog");
    expect(confirm).toHaveTextContent("all connected Chats");
    expect(within(confirm).getByRole("button", { name: "Keep Pod" })).toHaveFocus();
    expect(await axe(container)).toHaveNoViolations();
    await userEvent.click(within(confirm).getByRole("button", { name: "Remove Pod" }));
    await waitFor(() => expect(screen.queryByText("Lab Jira")).toBeNull());
    expect(api.deleteConnector).toHaveBeenCalledExactlyOnceWith(LIVE.authRef);
  });
  it("explains token rotation and removal in German with labelled keyboard controls", async () => {
    await Promise.all([loadLocaleMessages("de"), loadOptionalWidgetMessages("de")]);
    window.localStorage.setItem("keiko.locale", "de");
    const { container, unmount } = render(
      <I18nProvider>
        <AtlassianConnectorsPanel client={client()} jiraLive />
      </I18nProvider>,
    );
    try {
      await userEvent.click(await screen.findByRole("button", { name: "Token ersetzen" }));
      expect(screen.getByLabelText("Neues API-Token")).toHaveFocus();
      expect(screen.getByText(/Tokenwechsel stoppt den aktuellen Zugriff/u)).toBeVisible();
      expect(await axe(container)).toHaveNoViolations();
      await userEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
      await userEvent.click(screen.getByRole("button", { name: "Pod entfernen" }));
      expect(screen.getByRole("alertdialog")).toHaveTextContent("Alle verbundenen Chats");
      expect(screen.getByRole("button", { name: "Pod behalten" })).toHaveFocus();
    } finally {
      unmount();
      window.localStorage.removeItem("keiko.locale");
      document.documentElement.lang = "en";
    }
  });
});
