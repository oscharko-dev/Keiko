import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { bffFetchJson } from "@/lib/http";
import type {
  McpServerDefinition,
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
const empty: McpSettingsSnapshot = { revision: "b".repeat(64), servers: [] };
const remote: McpServerDefinition = {
  name: "synthetic",
  description: undefined,
  enabled: true,
  transport: {
    kind: "remote",
    url: "https://synthetic.example.invalid/mcp",
    headers: {
      Authorization: { secretEnv: "KEIKO_MCP_SECRET_AUTH", prefix: "Bearer " },
      "X-Workspace": { secretEnv: "KEIKO_MCP_SECRET_WORKSPACE" },
    },
  },
  tools: { get_status: "read" },
};
function snapshot(server: McpServerDefinition = remote): McpSettingsSnapshot {
  return { revision: "a".repeat(64), servers: [server] };
}
function panel(): ReturnType<typeof render> {
  return render(
    <I18nProvider>
      <McpSettingsPanel />
    </I18nProvider>,
  );
}
function mutation(): McpSettingsUpdate {
  const call = api.mock.calls.find(([, init]) => init?.method === "PUT");
  if (call === undefined) throw new Error("Expected Settings save");
  return JSON.parse(String(call[1]?.body)) as McpSettingsUpdate;
}
async function editAndSave(change?: () => void): Promise<void> {
  panel();
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  change?.();
  fireEvent.click(screen.getByRole("button", { name: "Save and connect" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Save and connect" })).not.toBeInTheDocument(),
  );
  await waitFor(() => expect(api).toHaveBeenCalledTimes(3));
}
beforeEach(() => api.mockReset());

it("preserves other credential headers when replacing only the Bearer token", async () => {
  api
    .mockResolvedValueOnce(snapshot())
    .mockResolvedValueOnce(snapshot())
    .mockResolvedValueOnce({ snapshot: snapshot(), toolCount: 1 });
  await editAndSave(() =>
    fireEvent.change(screen.getByLabelText(/^Bearer token/), {
      target: { value: "synthetic-replacement-token" },
    }),
  );
  const transport = mutation().servers[0]?.transport;
  if (transport?.kind !== "remote") throw new Error("Expected remote definition");
  expect(transport.headers?.["X-Workspace"]).toEqual({ secretEnv: "KEIKO_MCP_SECRET_WORKSPACE" });
});

it("does not widen a manually selected tool set when saving an unchanged server", async () => {
  api
    .mockResolvedValueOnce(snapshot())
    .mockResolvedValueOnce(snapshot())
    .mockResolvedValueOnce({ snapshot: snapshot(), toolCount: 1 });
  await editAndSave();
  expect(mutation().servers[0]?.discovery).toBeUndefined();
  expect(mutation().servers[0]?.tools).toEqual({ get_status: "read" });
});

it("drops the imported environment payload when changing from local to remote", async () => {
  const local: McpServerDefinition = {
    name: "synthetic",
    description: undefined,
    enabled: true,
    discovery: "automatic",
    tools: {},
    transport: { kind: "local", command: ["/synthetic/mcp"], environment: {} },
  };
  api
    .mockResolvedValueOnce(snapshot(local))
    .mockResolvedValueOnce(snapshot())
    .mockResolvedValueOnce({ snapshot: snapshot(), toolCount: 1 });
  panel();
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const file = new File(["TOKEN=synthetic"], "synthetic.env");
  Object.defineProperty(file, "text", {
    value: (): Promise<string> => Promise.resolve("TOKEN=synthetic"),
  });
  fireEvent.change(screen.getByLabelText("Import .env file"), { target: { files: [file] } });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save and connect" })).toBeEnabled(),
  );
  fireEvent.change(screen.getByLabelText("Connection type"), { target: { value: "remote" } });
  fireEvent.change(screen.getByLabelText("MCP endpoint (HTTPS)"), {
    target: { value: "https://synthetic.example.invalid/mcp" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save and connect" }));
  await waitFor(() => expect(api.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(true));
  expect(mutation().environmentFiles).toBeUndefined();
});

it("does not restore a removed server from a reload response started before deletion", async () => {
  let finishReload: ((value: McpSettingsSnapshot) => void) | undefined;
  api
    .mockResolvedValueOnce(snapshot())
    .mockRejectedValueOnce(new Error("Synthetic offline"))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishReload = resolve;
        }),
    )
    .mockResolvedValueOnce(empty);
  panel();
  fireEvent.click(await screen.findByRole("button", { name: /^(Connect|Check connection)$/ }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  await waitFor(() => expect(api).toHaveBeenCalledTimes(3));
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove server" }));
  await screen.findByText("No servers yet");
  await act(async () => {
    finishReload?.(snapshot());
  });
  expect(screen.getByText("No servers yet")).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "synthetic" })).not.toBeInTheDocument();
});

it("refuses retargeting retained remote credentials before persisting the changed endpoint", async () => {
  api
    .mockResolvedValueOnce(snapshot())
    .mockResolvedValueOnce(snapshot())
    .mockResolvedValueOnce({ snapshot: snapshot(), toolCount: 1 });
  panel();
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("MCP endpoint (HTTPS)"), {
    target: { value: "https://another.example.invalid/mcp" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save and connect" }));
  await act(async () => undefined);
  expect(api.mock.calls.filter(([, init]) => init?.method === "PUT")).toEqual([]);
});

it("requires replacing every bound header when retargeting, not just the Bearer token", async () => {
  api
    .mockResolvedValueOnce(snapshot())
    .mockResolvedValueOnce(snapshot())
    .mockResolvedValueOnce({ snapshot: snapshot(), toolCount: 1 });
  panel();
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("MCP endpoint (HTTPS)"), {
    target: { value: "https://another.example.invalid/mcp" },
  });
  fireEvent.change(screen.getByLabelText(/^Bearer token/), {
    target: { value: "synthetic-replacement-token" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save and connect" }));
  await act(async () => undefined);
  expect(api.mock.calls.filter(([, init]) => init?.method === "PUT")).toEqual([]);
});

it("refuses a changed local command while its bound environment credentials remain unchanged", async () => {
  const local: McpServerDefinition = {
    name: "synthetic",
    description: undefined,
    enabled: true,
    discovery: "automatic",
    tools: {},
    transport: {
      kind: "local",
      command: ["/synthetic/mcp"],
      environment: {},
      secretEnvironment: { TOKEN: { secretEnv: "KEIKO_MCP_SECRET_LOCAL" } },
    },
  };
  api
    .mockResolvedValueOnce(snapshot(local))
    .mockResolvedValueOnce(snapshot(local))
    .mockResolvedValueOnce({ snapshot: snapshot(local), toolCount: 1 });
  panel();
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Executable (absolute path)"), {
    target: { value: "/synthetic/other-mcp" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save and connect" }));
  await act(async () => undefined);
  expect(api.mock.calls.filter(([, init]) => init?.method === "PUT")).toEqual([]);
});

it("does not carry old target-bound secret references into a changed command with a replacement env file", async () => {
  const local: McpServerDefinition = {
    name: "synthetic",
    description: undefined,
    enabled: true,
    discovery: "automatic",
    tools: {},
    transport: {
      kind: "local",
      command: ["/synthetic/mcp"],
      environment: {},
      secretEnvironment: {
        TOKEN: { secretEnv: "KEIKO_MCP_SECRET_LOCAL" },
        OTHER: { secretEnv: "KEIKO_MCP_SECRET_OTHER" },
      },
    },
  };
  api
    .mockResolvedValueOnce(snapshot(local))
    .mockResolvedValueOnce(snapshot(local))
    .mockResolvedValueOnce({ snapshot: snapshot(local), toolCount: 1 });
  panel();
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Executable (absolute path)"), {
    target: { value: "/synthetic/other-mcp" },
  });
  const file = new File(["TOKEN=synthetic-replacement"], "synthetic.env");
  Object.defineProperty(file, "text", {
    value: (): Promise<string> => Promise.resolve("TOKEN=synthetic-replacement"),
  });
  fireEvent.change(screen.getByLabelText("Import .env file"), { target: { files: [file] } });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save and connect" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save and connect" }));
  await waitFor(() => expect(api.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(true));
  const changed = mutation();
  const transport = changed.servers[0]?.transport;
  if (transport?.kind !== "local") throw new Error("Expected local definition");
  expect(Object.keys(transport.secretEnvironment ?? {})).toEqual([]);
  expect(changed.environmentFiles).toEqual({ synthetic: "TOKEN=synthetic-replacement" });
});

it("returns focus to the actual form opener after cancelling add and edit", async () => {
  api.mockResolvedValueOnce(snapshot());
  panel();
  const edit = await screen.findByRole("button", { name: "Edit" });
  fireEvent.click(edit);
  await waitFor(() => expect(screen.getByLabelText(/^Name /)).toHaveFocus());
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(edit).toHaveFocus());
  const add = screen.getByRole("button", { name: "Add MCP server" });
  fireEvent.click(add);
  await waitFor(() => expect(screen.getByLabelText(/^Name /)).toHaveFocus());
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(add).toHaveFocus());
});

it("focuses safe cancellation first and returns focus after abandoning removal", async () => {
  api.mockResolvedValueOnce(snapshot());
  panel();
  fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
  const cancel = screen.getByRole("button", { name: "Cancel" });
  await waitFor(() => expect(cancel).toHaveFocus());
  fireEvent.click(cancel);
  await waitFor(() => expect(screen.getByRole("button", { name: "Remove" })).toHaveFocus());
  expect(api).toHaveBeenCalledTimes(1);
});

it("sends exactly one deletion while its first response is pending", async () => {
  let finish: ((value: McpSettingsSnapshot) => void) | undefined;
  api.mockResolvedValueOnce(snapshot()).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  panel();
  fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
  const confirm = screen.getByRole("button", { name: "Remove server" });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  expect(api.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
  await act(async () => {
    finish?.(empty);
  });
  await screen.findByText("No servers yet");
});

it("still accepts the initial server list after a local env import during loading", async () => {
  let finishLoad: ((value: McpSettingsSnapshot) => void) | undefined;
  api.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishLoad = resolve;
      }),
  );
  panel();
  await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Add MCP server" }));
  fireEvent.change(screen.getByLabelText("Connection type"), { target: { value: "local" } });
  const file = new File(["TOKEN=synthetic"], "synthetic.env");
  Object.defineProperty(file, "text", {
    value: (): Promise<string> => Promise.resolve("TOKEN=synthetic"),
  });
  fireEvent.change(screen.getByLabelText("Import .env file"), { target: { files: [file] } });
  await waitFor(() => expect(screen.getByLabelText("Executable (absolute path)")).toBeEnabled());
  await act(async () => {
    finishLoad?.(empty);
  });
  expect(screen.getByRole("button", { name: "Save and connect" })).toBeEnabled();
});
