import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { bffFetchJson } from "@/lib/http";
import type {
  McpSettingsSnapshot,
  McpSettingsUpdate,
} from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import { McpSettingsPanel } from "./McpSettingsPanel";

vi.mock("@/lib/http", () => ({ bffFetchJson: vi.fn() }));
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
function panel(): ReturnType<typeof render> {
  return render(
    <I18nProvider>
      <McpSettingsPanel />
    </I18nProvider>,
  );
}
async function remoteForm(): Promise<void> {
  await screen.findByRole("button", { name: "Save and connect" });
  await waitFor(() => expect(screen.getByLabelText(/^Name /)).toBeEnabled());
  fireEvent.change(screen.getByLabelText(/^Name /), { target: { value: "notes" } });
  fireEvent.change(screen.getByLabelText("MCP endpoint (HTTPS)"), {
    target: { value: "https://synthetic.example.test/mcp" },
  });
}
beforeEach(() => {
  api.mockReset();
});

describe("MCP Settings", () => {
  it("saves token references, connects only after saving, and clears the password field", async () => {
    api
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(saved)
      .mockResolvedValueOnce({ snapshot: saved, toolCount: 2 });
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
    expect(screen.getByLabelText(/^Bearer token/)).toHaveValue("");
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
    expect(screen.getByText("Not checked in this session")).toBeInTheDocument();
    expect(api).toHaveBeenCalledTimes(3);
    expect(screen.queryByText(/Connected ·/)).not.toBeInTheDocument();
  });
  it("retains existing credential references when editing with a blank token", async () => {
    api
      .mockResolvedValueOnce(saved)
      .mockResolvedValueOnce(saved)
      .mockResolvedValueOnce({ snapshot: saved, toolCount: 1 });
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
      .mockResolvedValueOnce({ snapshot: saved, toolCount: 1 });
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
  fireEvent.click(screen.getByRole("button", { name: /^(Save|Save and connect)$/ }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save and connect" })).toBeEnabled(),
  );
  const mutation = JSON.parse(String(api.mock.calls[1]?.[1]?.body)) as McpSettingsUpdate;
  expect(mutation.servers[0]?.enabled).toBe(false);
  expect(api).toHaveBeenCalledTimes(2);
  expect(screen.getByText("Disabled")).toBeInTheDocument();
});
