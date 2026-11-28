import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { ApiError } from "@/lib/api";
import { bffFetchJson } from "@/lib/http";
import type { McpSettingsSnapshot } from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
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
const revision = "a".repeat(64);
const empty: McpSettingsSnapshot = { revision, servers: [] };
const text = '{"mcp":{"fixture":{"type":"remote","url":"https://example.test/mcp"}}}';
const preview = { kind: "preview", revision, servers: [{ name: "fixture", kind: "remote" }] };
const saved: McpSettingsSnapshot = {
  revision: "b".repeat(64),
  servers: [
    {
      name: "fixture",
      description: undefined,
      enabled: false,
      discovery: "automatic",
      tools: {},
      transport: { kind: "remote", url: "https://example.test/mcp" },
    },
  ],
};

beforeEach(() => {
  api.mockReset();
  api.mockResolvedValueOnce(empty);
});

async function openImport(): Promise<HTMLElement> {
  render(
    <I18nProvider>
      <McpSettingsPanel />
    </I18nProvider>,
  );
  await screen.findByText("No servers yet");
  fireEvent.click(screen.getByRole("button", { name: "Import JSON" }));
  return screen.getByRole("textbox", { name: "JSON configuration" });
}

function review(): void {
  fireEvent.click(screen.getByRole("button", { name: "Review servers" }));
}

function add(): void {
  fireEvent.click(screen.getByRole("button", { name: "Add servers" }));
}

it("previews before saving and puts focus back on the opener after saving", async () => {
  api.mockResolvedValueOnce(preview).mockResolvedValueOnce({ kind: "saved", snapshot: saved });
  const json = await openImport();
  expect(json).toHaveFocus();
  expect(json).toHaveAccessibleDescription(/one or several servers/u);
  fireEvent.change(json, { target: { value: text } });
  review();
  const heading = await screen.findByRole("heading", { name: "Servers to add" });
  expect(heading).toHaveFocus();
  expect(screen.queryByRole("textbox", { name: "JSON configuration" })).toBeNull();
  expect(api.mock.calls[1]?.[1]).toMatchObject({ method: "POST", body: JSON.stringify({ text }) });
  add();
  expect(await screen.findByText(/Servers added: 1/u)).toBeVisible();
  expect(api.mock.calls[2]?.[1]).toMatchObject({
    method: "POST",
    body: JSON.stringify({ text, revision }),
  });
  expect(await screen.findByRole("button", { name: "Import JSON" })).toHaveFocus();
  const servers = screen.getByRole("list", { name: "Your servers" });
  expect(within(servers).getByRole("button", { name: "Check connection" })).toBeDisabled();
});

it("retains the draft and requires a new preview after a conflict", async () => {
  api
    .mockResolvedValueOnce(preview)
    .mockRejectedValueOnce(new ApiError("MCP_SETTINGS_CONFLICT", "conflict", 409));
  const json = await openImport();
  fireEvent.change(json, { target: { value: text } });
  review();
  await screen.findByRole("heading", { name: "Servers to add" });
  add();
  expect(await screen.findByRole("alert")).toHaveTextContent("changed since the review");
  const editor = screen.getByRole("textbox", { name: "JSON configuration" });
  expect(editor).toHaveValue(text);
  expect(editor).toHaveFocus();
  expect(screen.queryByRole("button", { name: "Add servers" })).toBeNull();
  expect(screen.getByRole("button", { name: "Review servers" })).toBeEnabled();
});

it("rejects invalid entries without clearing the pasted document", async () => {
  api.mockResolvedValueOnce({ kind: "invalid", issue: "duplicate", entry: 2 });
  const json = await openImport();
  fireEvent.change(json, { target: { value: text } });
  review();
  expect(await screen.findByRole("alert")).toHaveTextContent("Server 2");
  expect(json).toHaveValue(text);
  expect(json).toHaveAttribute("aria-invalid", "true");
  expect(screen.queryByRole("button", { name: "Add servers" })).toBeNull();
});

it("keeps the draft but invalidates confirmation when a replacement file cannot be opened", async () => {
  api.mockResolvedValueOnce(preview);
  const json = await openImport();
  fireEvent.click(screen.getByRole("button", { name: "Insert example" }));
  expect(json).toHaveFocus();
  fireEvent.change(json, { target: { value: text } });
  review();
  await screen.findByRole("heading", { name: "Servers to add" });
  fireEvent.click(screen.getByRole("button", { name: "Edit JSON" }));
  const editor = screen.getByRole("textbox", { name: "JSON configuration" });
  expect(editor).toHaveValue(text);
  expect(editor).toHaveFocus();
  const file = new File(["{}"], "settings.json");
  Object.defineProperty(file, "text", {
    value: () => Promise.reject(new Error("File unavailable")),
  });
  const chooser = screen.getByLabelText("Choose JSON file");
  fireEvent.change(chooser, { target: { files: [file] } });
  expect(await screen.findByRole("alert")).toHaveTextContent("could not read the file");
  expect(chooser).toHaveAttribute("aria-invalid", "true");
  expect(chooser).toHaveAccessibleDescription(/could not read the file/u);
  expect(editor).not.toHaveAccessibleDescription(/could not read the file/u);
  expect(editor).toHaveValue(text);
  expect(screen.queryByRole("button", { name: "Add servers" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Import JSON" })).toHaveFocus());
});

it("describes an oversized file on the file picker and clears the error on a new selection", async () => {
  const json = await openImport();
  const chooser = screen.getByLabelText("Choose JSON file");
  const tooLarge = new File([" ".repeat(64 * 1024 + 1)], "large.json");
  fireEvent.change(chooser, { target: { files: [tooLarge] } });
  expect(await screen.findByRole("alert")).toHaveTextContent("configuration is too large");
  expect(chooser).toHaveAttribute("aria-invalid", "true");
  expect(chooser).toHaveAccessibleDescription(/configuration is too large/u);
  const file = new File([text], "settings.json");
  Object.defineProperty(file, "text", { value: () => Promise.resolve(text) });
  fireEvent.change(chooser, { target: { files: [file] } });
  await waitFor(() => expect(json).toHaveValue(text));
  expect(chooser).toHaveAttribute("aria-invalid", "false");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("checks the UTF-8 byte limit without truncating a paste", async () => {
  const json = await openImport();
  const tooLarge = "ä".repeat(33_000);
  fireEvent.change(json, { target: { value: tooLarge } });
  expect(await screen.findByRole("alert")).toHaveTextContent("configuration is too large");
  expect(json).toHaveValue(tooLarge);
  expect(screen.getByRole("button", { name: "Review servers" })).toBeDisabled();
  expect(api).toHaveBeenCalledTimes(1);
});
