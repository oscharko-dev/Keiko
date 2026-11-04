// Owner request 2026-11-02: MCP servers and Jira Pods appear in Chat context management. The meter
// draws the tool definitions of a Chat's active connectors as one share of the window and lists the
// connectors under the breakdown; a Chat without connectors shows neither.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatContextStatusWire } from "@oscharko-dev/keiko-contracts/bff-wire";
import { ChatContextMeter } from "./ChatContextMeter";
import { ChatContextMeterContainer } from "./ChatContextMeterContainer";
import {
  I18N_STORAGE_KEY,
  I18nProvider,
  loadLocaleMessages,
  resetLoadedMessageCatalogs,
} from "@/lib/i18n";

const contextApi = vi.hoisted(() => ({ fetch: vi.fn(), compact: vi.fn() }));
vi.mock("@/lib/api", async () => ({
  ...(await vi.importActual<typeof import("@/lib/api")>("@/lib/api")),
  fetchChatContextStatus: contextApi.fetch,
  compactChatContext: contextApi.compact,
}));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));

function connectorStatus(
  connectors: ChatContextStatusWire["connectors"],
  toolTokens = 1_850,
): ChatContextStatusWire {
  return {
    modelId: "fixture",
    contextWindowTokens: 16_384,
    inputBudgetTokens: 11_776,
    reservedOutputTokens: 4_096,
    safetyMarginTokens: 512,
    estimatedInputTokens: 3_340 + toolTokens,
    canCompact: false,
    autoCompactionAtTokens: 10_598,
    ...(connectors === undefined ? {} : { connectors }),
    segments: [
      { id: "system", tokens: 310 },
      ...(toolTokens > 0 ? [{ id: "tools" as const, tokens: toolTokens, count: 14 }] : []),
      { id: "messages", tokens: 3_030, count: 4 },
      { id: "free", tokens: 5_408 },
      { id: "compaction-buffer", tokens: 1_178 },
      { id: "output-reserve", tokens: 4_096 },
      { id: "safety-margin", tokens: 512 },
    ],
  };
}

const CONNECTORS: NonNullable<ChatContextStatusWire["connectors"]> = [
  { kind: "mcp", name: "notes", toolCount: 2, tokens: 410 },
  { kind: "mcp", name: "calendar" },
  { kind: "jira", name: "Synthetic Jira", toolCount: 1, tokens: 1_440 },
];

function openPanel(status: ChatContextStatusWire, locale: "en" | "de" = "en"): HTMLElement {
  window.localStorage.setItem(I18N_STORAGE_KEY, locale);
  render(
    <I18nProvider>
      <ChatContextMeter
        status={status}
        busy={false}
        compacting={false}
        error={false}
        onCompact={vi.fn()}
        onRetry={vi.fn()}
      />
    </I18nProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /Gesprächskontext:|Conversation context:/u }));
  return screen.getByRole("region", { name: /Gesprächskontext|Conversation context/u });
}

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(I18N_STORAGE_KEY);
  resetLoadedMessageCatalogs();
});

describe("Chat context meter connectors", () => {
  it("draws the tool definitions as a protected share of the window", () => {
    const panel = openPanel(connectorStatus(CONNECTORS));
    const legend = within(panel).getByRole("list", { name: "Context window breakdown" });
    const rows = within(legend).getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("data-segment"))).toEqual([
      "system",
      "tools",
      "messages",
      "free",
      "compaction-buffer",
      "output-reserve",
      "safety-margin",
    ]);
    const tools = rows[1];
    expect(tools).toHaveTextContent("Tool definitions");
    expect(tools).toHaveTextContent("1,850");
    expect(tools).toHaveTextContent("11.3%");
    expect(within(tools as HTMLElement).getByRole("img", { name: "Not compacted" })).toBeVisible();
  });

  it("lists the active connectors with their tools and tokens", () => {
    const panel = openPanel(connectorStatus(CONNECTORS));
    const list = within(panel).getByRole("list", { name: "Connectors" });
    expect(within(panel).getByRole("heading", { name: "Connectors", level: 4 })).toBeVisible();
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("notes");
    expect(rows[0]).toHaveTextContent("MCP server");
    expect(rows[0]).toHaveTextContent("2 tools");
    expect(rows[0]).toHaveTextContent("~410");
    expect(rows[1]).toHaveTextContent("calendar");
    expect(rows[1]).toHaveTextContent("Not connected");
    expect(rows[1]).not.toHaveTextContent("tools");
    expect(rows[2]).toHaveTextContent("Synthetic Jira");
    expect(rows[2]).toHaveTextContent("Jira Pod");
    expect(rows[2]).toHaveTextContent("1 tool");
    expect(rows[2]).not.toHaveTextContent("1 tools");
    expect(rows[2]).toHaveTextContent("~1,440");
  });

  it("labels a Pod without a resolvable name by its kind", () => {
    const panel = openPanel(connectorStatus([{ kind: "jira" }], 0));
    const row = within(within(panel).getByRole("list", { name: "Connectors" })).getByRole(
      "listitem",
    );
    expect(row).toHaveTextContent("Jira Pod");
    expect(row).toHaveTextContent("Not connected");
  });

  it("shows neither a tools share nor a connector list for a Chat without connectors", () => {
    const panel = openPanel(connectorStatus(undefined, 0));
    expect(within(panel).queryByRole("list", { name: "Connectors" })).toBeNull();
    expect(within(panel).queryByRole("heading", { name: "Connectors" })).toBeNull();
    expect(panel.querySelector('[data-segment="tools"]')).toBeNull();
    cleanup();
    const empty = openPanel(connectorStatus([], 0));
    expect(within(empty).queryByRole("list", { name: "Connectors" })).toBeNull();
  });

  it("speaks German", async () => {
    await loadLocaleMessages("de");
    const panel = openPanel(connectorStatus(CONNECTORS), "de");
    await waitFor(() =>
      expect(within(panel).getByRole("list", { name: "Konnektoren" })).toBeInTheDocument(),
    );
    expect(within(panel).getByText("Werkzeugdefinitionen")).toBeInTheDocument();
    const rows = within(within(panel).getByRole("list", { name: "Konnektoren" })).getAllByRole(
      "listitem",
    );
    expect(rows[0]).toHaveTextContent("2 Werkzeuge");
    expect(rows[1]).toHaveTextContent("Nicht verbunden");
    expect(rows[2]).toHaveTextContent("1 Werkzeug");
  });

  it("has no accessibility violations", async () => {
    const panel = openPanel(connectorStatus(CONNECTORS));
    expect(await axe(panel)).toHaveNoViolations();
  });
});

type ContainerSession = Parameters<typeof ChatContextMeterContainer>[0]["session"];

function session(chat: Partial<NonNullable<ContainerSession["activeChat"]>>): ContainerSession {
  return {
    activeChat: {
      id: "chat-1",
      projectPath: "/project",
      title: "Chat",
      selectedModel: "fixture",
      branchLabel: undefined,
      status: "open",
      connectedScope: undefined,
      localKnowledgeScope: undefined,
      createdAt: 1,
      updatedAt: 1,
      ...chat,
    },
    selectedModel: "fixture",
    models: [],
    messages: [],
    sending: false,
    regeneratingMessageId: undefined,
    loading: false,
  };
}

const POD_BINDING = {
  podId: "pod",
  bindingGeneration: 1,
  authenticationGeneration: 1,
  connectedAtMs: 1,
};

describe("Chat context meter refresh on connector changes", () => {
  beforeEach(() => {
    contextApi.fetch.mockReset().mockResolvedValue(connectorStatus(undefined, 0));
  });

  it.each([
    ["server selection", { mcpServers: ["notes"] }],
    ["Pod binding", { jiraPodBinding: POD_BINDING }],
  ])("reads the status again when the %s changes", async (_label, change) => {
    const view = render(<ChatContextMeterContainer session={session({})} />);
    await screen.findByRole("button", { name: /Conversation context:/ });
    expect(contextApi.fetch).toHaveBeenCalledTimes(1);
    view.rerender(<ChatContextMeterContainer session={session(change)} />);
    await waitFor(() => expect(contextApi.fetch).toHaveBeenCalledTimes(2));
  });

  it("does not read again for an unchanged selection", async () => {
    const view = render(<ChatContextMeterContainer session={session({ mcpServers: ["notes"] })} />);
    await screen.findByRole("button", { name: /Conversation context:/ });
    view.rerender(<ChatContextMeterContainer session={session({ mcpServers: ["notes"] })} />);
    await screen.findByRole("button", { name: /Conversation context:/ });
    expect(contextApi.fetch).toHaveBeenCalledTimes(1);
  });
});
