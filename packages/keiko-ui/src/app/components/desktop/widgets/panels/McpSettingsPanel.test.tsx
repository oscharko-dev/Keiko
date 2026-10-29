import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { bffFetchJson, isDeniedError } from "@/lib/http";
import type {
  McpSettingsSnapshot,
  McpSettingsUpdate,
} from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import { McpSettingsPanel } from "./McpSettingsPanel";

vi.mock("@/lib/http", () => ({
  bffFetchJson: vi.fn(),
  isDeniedError: vi.fn().mockReturnValue(false),
}));
vi.mock("@/lib/coding-app-session-client", () => ({
  codingAppSessionPairingSettled: (): Promise<boolean> => Promise.resolve(true),
  useCodingAppSessionRedemptions: (): number => 0,
}));
const api = vi.mocked(bffFetchJson);
const empty: McpSettingsSnapshot = { revision: "a".repeat(64), servers: [] };
const saved: McpSettingsSnapshot = {
  revision: "b".repeat(64),
  servers: [
    {
      name: "notes",
      enabled: true,
      description: undefined,
      discovery: "automatic",
      transport: {
        kind: "remote",
        url: "https://synthetic.example.test/mcp",
        headers: { Authorization: { secretEnv: "KEIKO_MCP_SECRET_EXISTING", prefix: "Bearer " } },
      },
      tools: {},
    },
  ],
};
function connectedSnapshot(count: number): { snapshot: McpSettingsSnapshot; toolCount: number } {
  return {
    snapshot: { ...saved, connections: [{ name: "notes", state: "connected", toolCount: count }] },
    toolCount: count,
  };
}
function panel(): ReturnType<typeof render> {
  return render(
    <I18nProvider>
      <McpSettingsPanel />
    </I18nProvider>,
  );
}
async function remoteForm(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Add MCP server" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save and connect" })).toBeEnabled(),
  );
  await waitFor(() => expect(screen.getByLabelText(/^Name /)).toBeEnabled());
  fireEvent.change(screen.getByLabelText(/^Name /), { target: { value: "notes" } });
  fireEvent.change(screen.getByLabelText("MCP endpoint (HTTPS)"), {
    target: { value: "https://synthetic.example.test/mcp" },
  });
}
beforeEach(() => {
  api.mockReset();
  vi.mocked(isDeniedError).mockReturnValue(false);
});

describe("MCP Settings", () => {
  it("edits OAuth definitions without dropping their issuer, scopes or tool admission", async () => {
    const previous = saved.servers[0];
    if (previous === undefined) throw new Error("Missing fixture server");
    const oauth: McpSettingsSnapshot = {
      ...saved,
      servers: [
        {
          ...previous,
          transport: {
            kind: "remote",
            url: "https://synthetic.example.test/mcp",
            oauth: {
              issuer: "https://identity.example.test",
              clientId: "synthetic-public",
              scope: "tools.read",
            },
          },
          tools: { search: "read" },
        },
      ],
    };
    api.mockResolvedValueOnce(oauth).mockResolvedValueOnce(oauth);
    panel();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Expected OAuth issuer (HTTPS)")).toHaveValue(
      "https://identity.example.test",
    );
    expect(screen.getByLabelText("Public client ID (optional)")).toHaveValue("synthetic-public");
    fireEvent.click(screen.getByRole("button", { name: "Save and connect" }));
    await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
    const update = JSON.parse(String(api.mock.calls[1]?.[1]?.body)) as McpSettingsUpdate;
    expect(update.servers[0]?.transport).toEqual(oauth.servers[0]?.transport);
    expect(update.servers[0]?.tools).toEqual({ search: "read" });
  });
  it("saves token references, connects only after saving, and clears the password field", async () => {
    api
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(saved)
      .mockResolvedValueOnce(connectedSnapshot(2));
    const { container } = panel();
    await remoteForm();
    fireEvent.change(screen.getByLabelText(/^Bearer token/), {
      target: { value: "synthetic-private-ui-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save and connect" }));
    await screen.findByText("Connected · 2 tools");
    expect(api.mock.calls.map(([path, init]) => [path, init?.method ?? "GET"])).toEqual([
      ["/api/mcp/servers", "GET"],
      ["/api/mcp/servers", "PUT"],
      ["/api/mcp/servers/notes/connect", "POST"],
    ]);
    const mutation = JSON.parse(String(api.mock.calls[1]?.[1]?.body)) as McpSettingsUpdate;
    expect(Object.values(mutation.secrets)).toEqual([
      { server: "notes", value: "synthetic-private-ui-token" },
    ]);
    expect(JSON.stringify(mutation.servers)).not.toContain("synthetic-private-ui-token");
    expect(screen.queryByLabelText(/^Bearer token/)).not.toBeInTheDocument();
    expect(container.textContent).not.toContain("synthetic-private-ui-token");
    expect(await axe(container)).toHaveNoViolations();
  });
  it("keeps a saved server unverified when connection fails, without replaying the mutation", async () => {
    api
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(saved)
      .mockRejectedValueOnce(new Error("unavailable"));
    panel();
    await remoteForm();
    fireEvent.click(screen.getByRole("button", { name: "Save and connect" }));
    await screen.findByRole("alert");
    expect(screen.getByText("notes")).toBeInTheDocument();
    expect(screen.getByText("Status unavailable")).toBeInTheDocument();
    expect(api).toHaveBeenCalledTimes(3);
    expect(screen.queryByText(/Connected ·/)).not.toBeInTheDocument();
  });
  it("retains existing credential references when editing with a blank token", async () => {
    api
      .mockResolvedValueOnce(saved)
      .mockResolvedValueOnce(saved)
      .mockResolvedValueOnce(connectedSnapshot(1));
    panel();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText(/^Name /)).toHaveAttribute("readonly");
    fireEvent.click(screen.getByRole("button", { name: "Save and connect" }));
    await screen.findByText("Connected · 1 tools");
    const mutation = JSON.parse(String(api.mock.calls[1]?.[1]?.body)) as McpSettingsUpdate;
    expect(mutation.secrets).toEqual({});
    expect(mutation.servers[0]?.transport).toEqual(saved.servers[0]?.transport);
  });
  it("suppresses duplicate submissions while the initial save is pending", async () => {
    let resolveSave: ((snapshot: McpSettingsSnapshot) => void) | undefined;
    api
      .mockResolvedValueOnce(empty)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSave = resolve;
          }),
      )
      .mockResolvedValueOnce(connectedSnapshot(1));
    const { container } = panel();
    await remoteForm();
    const form = container.querySelector("form");
    if (form === null) throw new Error("Missing form");
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(api).toHaveBeenCalledTimes(2);
    resolveSave?.(saved);
    await screen.findByText("Connected · 1 tools");
    expect(api).toHaveBeenCalledTimes(3);
  });
});

it("keeps a disabled server disabled when editing and does not start its transport", async () => {
  const disabled = {
    ...saved,
    servers: saved.servers.map((server) => ({ ...server, enabled: false })),
  };
  api.mockResolvedValueOnce(disabled).mockResolvedValueOnce(disabled);
  panel();
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("MCP endpoint (HTTPS)"), {
    target: { value: "https://changed.example.test/mcp" },
  });
  fireEvent.change(screen.getByLabelText(/^Bearer token/), {
    target: { value: "synthetic-replacement" },
  });
  fireEvent.click(screen.getByRole("button", { name: /^(Save|Save and connect)$/ }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument(),
  );
  const mutation = JSON.parse(String(api.mock.calls[1]?.[1]?.body)) as McpSettingsUpdate;
  expect(mutation.servers[0]?.enabled).toBe(false);
  expect(api).toHaveBeenCalledTimes(2);
  expect(screen.getByText("Disabled")).toBeInTheDocument();
});

it("keeps connection fields editable during a load failure and preserves the draft on reload", async () => {
  api.mockRejectedValueOnce(new Error("unavailable")).mockResolvedValueOnce(empty);
  panel();
  await screen.findByRole("alert");
  expect(screen.queryByLabelText(/^Name /)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Add MCP server" }));
  const name = screen.getByLabelText(/^Name /);
  expect(name).toBeEnabled();
  fireEvent.change(name, { target: { value: "draft-server" } });
  fireEvent.change(screen.getByLabelText("MCP endpoint (HTTPS)"), {
    target: { value: "https://synthetic.example.test/mcp" },
  });
  expect(screen.getByRole("button", { name: "Save and connect" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save and connect" })).toBeEnabled(),
  );
  expect(name).toHaveValue("draft-server");
  expect(api).toHaveBeenCalledTimes(2);
});

it("explains an expired browser session without presenting a broken MCP configuration", async () => {
  vi.mocked(isDeniedError).mockReturnValue(true);
  api.mockRejectedValueOnce(new Error("denied"));
  panel();
  expect(await screen.findByText("Connect this browser to Keiko")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("browser connection has expired");
});

it("shows saved servers first and only opens the form on demand", async () => {
  api.mockResolvedValueOnce(saved);
  const { container } = panel();
  expect(await screen.findByRole("list", { name: "Your servers" })).toHaveTextContent("notes");
  expect(screen.queryByLabelText(/^Name /)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(screen.getByLabelText(/^Name /)).toHaveValue("notes");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByLabelText(/^Name /)).not.toBeInTheDocument();
  expect(await axe(container)).toHaveNoViolations();
});

it("requires confirmation before removing a saved server and supports cancellation", async () => {
  api.mockResolvedValueOnce(saved).mockResolvedValueOnce(empty);
  panel();
  fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
  expect(screen.getByRole("group", { name: "Remove notes" })).toBeInTheDocument();
  expect(api).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(api).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove server" }));
  await screen.findByText("No servers yet");
  expect(JSON.parse(String(api.mock.calls[1]?.[1]?.body)).servers).toEqual([]);
});

it("shows the server-owned connection state on initial load", async () => {
  api.mockResolvedValueOnce(connectedSnapshot(3).snapshot);
  panel();
  expect(await screen.findByText("Connected · 3 tools")).toBeInTheDocument();
  expect(api).toHaveBeenCalledTimes(1);
});

it("does not keep a green connection badge after the connection can no longer be verified", async () => {
  api
    .mockResolvedValueOnce(connectedSnapshot(3).snapshot)
    .mockRejectedValueOnce(new Error("connection lost"));
  panel();
  await screen.findByText("Connected · 3 tools");
  fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
  await screen.findByRole("alert");
  expect(screen.queryByText("Connected · 3 tools")).not.toBeInTheDocument();
  expect(screen.getByText("Status unavailable")).toBeInTheDocument();
});
