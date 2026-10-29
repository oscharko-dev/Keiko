import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type {
  McpServerDefinition,
  McpSettingsSnapshot,
} from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import { bffFetchJson } from "@/lib/http";
import { McpServerAvailability } from "./McpServerAvailability";

vi.mock("@/lib/http", () => ({ bffFetchJson: vi.fn() }));
vi.mock("@/lib/coding-app-session-client", () => ({
  codingAppSessionPairingSettled: (): Promise<boolean> => Promise.resolve(true),
  useCodingAppSessionRedemptions: (): number => 0,
}));
const api = vi.mocked(bffFetchJson);
const server = (name: string, enabled = true): McpServerDefinition => ({
  name,
  enabled,
  description: undefined,
  transport: { kind: "local", command: ["/synthetic/runtime"], environment: {} },
  tools: {},
});
const snapshot: McpSettingsSnapshot = {
  revision: "a".repeat(64),
  servers: [server("available"), server("sign-in"), server("disabled", false)],
  connections: [
    { name: "available", state: "connected", toolCount: 1, authentication: "none" },
    { name: "sign-in", state: "idle", toolCount: null, authentication: "required" },
    { name: "disabled", state: "disabled", toolCount: null, authentication: "required" },
  ],
};
beforeEach(() => {
  api.mockReset();
});

it("shows central availability separately from conversation authority without disclosing launch details", async () => {
  api.mockResolvedValue(snapshot);
  render(<McpServerAvailability />);
  expect(await screen.findByText("available · Connected · Tools: 1")).toBeInTheDocument();
  expect(screen.getByText("sign-in · Sign-in required")).toBeInTheDocument();
  expect(screen.getByText("disabled · Disabled")).toBeInTheDocument();
  expect(
    screen.getByText("Each conversation and coding task keeps its own permissions."),
  ).toBeInTheDocument();
  expect(screen.queryByText("/synthetic/runtime")).not.toBeInTheDocument();
  expect(api).toHaveBeenCalledWith("/api/mcp/servers", { signal: expect.any(AbortSignal) });
});
it("shows an empty central registry without implying a grant", async () => {
  api.mockResolvedValue({ revision: "empty", servers: [] });
  render(<McpServerAvailability />);
  expect(await screen.findByText("No servers yet")).toBeInTheDocument();
});
it("recovers from a failed snapshot using only a fresh central read", async () => {
  api.mockRejectedValueOnce(new Error("synthetic-unavailable")).mockResolvedValueOnce(snapshot);
  render(<McpServerAvailability />);
  expect(await screen.findByRole("status")).toHaveTextContent(/unavailable/iu);
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  expect(await screen.findByText("available · Connected · Tools: 1")).toBeInTheDocument();
  expect(api).toHaveBeenCalledTimes(2);
});
it("cancels a pending central read when its consumer closes", async () => {
  let resolve: (value: McpSettingsSnapshot) => void = () => undefined;
  api.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const view = render(<McpServerAvailability />);
  await act(async () => {
    await Promise.resolve();
  });
  const request = api.mock.calls[0]?.[1];
  const signal = request?.signal;
  view.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    resolve(snapshot);
  });
  expect(screen.queryByRole("region", { name: "MCP servers" })).not.toBeInTheDocument();
});
