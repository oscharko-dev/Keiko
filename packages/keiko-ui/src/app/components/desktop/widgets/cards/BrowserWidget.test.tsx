// ADR-0017 D11 — BrowserWidget tests. Mocks the typed BFF client + EventSource so the panel
// drives the UI through the same paths a real BFF would. Covers: render, navigate POSTs,
// SSE event display, accessible error surface for ORIGIN_NOT_ALLOWED, and screenshot apply.

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../../lib/api";
import {
  browserApplyScreenshot,
  browserContent,
  browserNavigate,
  browserScreenshot,
  createBrowserSession,
  deleteBrowserSession,
  fetchBrowserStatus,
} from "../../../../../lib/browser-api";
import { BrowserWidget } from "./BrowserWidget";

vi.mock("../../../../../lib/browser-api", () => ({
  fetchBrowserStatus: vi.fn(),
  createBrowserSession: vi.fn(),
  deleteBrowserSession: vi.fn(),
  browserNavigate: vi.fn(),
  browserScreenshot: vi.fn(),
  browserApplyScreenshot: vi.fn(),
  browserContent: vi.fn(),
  browserEventsUrl: (id: string): string => `/api/browser/sessions/${id}/events`,
}));

type EsListener = (ev: MessageEvent<string>) => void;

class FakeEventSource {
  public readonly url: string;
  public readonly listeners = new Map<string, EsListener[]>();
  public closed = false;
  public static last: FakeEventSource | null = null;

  public constructor(url: string) {
    this.url = url;
    FakeEventSource.last = this;
  }

  public addEventListener(type: string, listener: EsListener): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  public close(): void {
    this.closed = true;
  }

  public dispatch(type: string, data: string): void {
    const handlers = this.listeners.get(type) ?? [];
    for (const h of handlers) h(new MessageEvent(type, { data }));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
  FakeEventSource.last = null;
});

afterEach(() => {
  delete (globalThis as { EventSource?: unknown }).EventSource;
});

const sessionMeta = {
  sessionId: "session-1",
  cdpPort: 9222,
  targetId: "TARGET-1",
  status: "open" as const,
  createdAt: 1,
};

describe("BrowserWidget", () => {
  it("renders the URL and port inputs with accessible labels", () => {
    render(<BrowserWidget />);
    expect(screen.getByRole("textbox", { name: "Port" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "URL" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Apply$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open session/i })).toBeEnabled();
  });

  it("keeps the visible labels in the accessible names for label-in-name compliance", () => {
    render(<BrowserWidget />);
    expect(screen.getByRole("textbox", { name: "Port" })).toHaveAccessibleName("Port");
    expect(screen.getByRole("textbox", { name: "URL" })).toHaveAccessibleName("URL");
    expect(screen.getByRole("button", { name: /^Apply$/i })).toHaveAccessibleName("Apply");
  });

  it("opens a session, then enables Navigate / Screenshot / Close buttons", async () => {
    vi.mocked(createBrowserSession).mockResolvedValueOnce(sessionMeta);
    render(<BrowserWidget />);
    await userEvent.click(screen.getByRole("button", { name: /Open session/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Navigate$/i })).toBeEnabled();
    });
    expect(screen.getByRole("button", { name: /^Close$/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Screenshot$/i })).toBeEnabled();
  });

  it("POSTs navigate and reflects the SSE navigated event", async () => {
    vi.mocked(createBrowserSession).mockResolvedValueOnce(sessionMeta);
    vi.mocked(browserNavigate).mockResolvedValueOnce({
      originOnly: "http://127.0.0.1:5173",
      httpStatus: 200,
    });
    render(<BrowserWidget />);
    await userEvent.click(screen.getByRole("button", { name: /Open session/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Navigate$/i })).toBeEnabled();
    });
    await userEvent.click(screen.getByRole("button", { name: /^Navigate$/i }));
    await waitFor(() => {
      expect(browserNavigate).toHaveBeenCalledWith("session-1", "http://localhost:5173");
    });
    // Drive an SSE navigated event through the fake EventSource.
    expect(FakeEventSource.last).not.toBeNull();
    act(() => {
      FakeEventSource.last?.dispatch(
        "browser:navigated",
        JSON.stringify({
          kind: "navigated",
          sessionId: "session-1",
          payload: { originOnly: "http://127.0.0.1:5173", httpStatus: 200 },
        }),
      );
    });
    await waitFor(() => {
      expect(screen.getByText("http://127.0.0.1:5173")).toBeInTheDocument();
    });
  });

  it("surfaces ORIGIN_NOT_ALLOWED via role=alert", async () => {
    vi.mocked(createBrowserSession).mockResolvedValueOnce(sessionMeta);
    vi.mocked(browserNavigate).mockRejectedValueOnce(
      new ApiError("ORIGIN_NOT_ALLOWED", "Post-navigate origin is not loopback.", 403),
    );
    render(<BrowserWidget />);
    await userEvent.click(screen.getByRole("button", { name: /Open session/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Navigate$/i })).toBeEnabled();
    });
    await userEvent.click(screen.getByRole("button", { name: /^Navigate$/i }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/ORIGIN_NOT_ALLOWED/);
    expect(alert).toHaveTextContent(/Post-navigate origin is not loopback/);
  });

  it("dry-run screenshot enables Apply, then Apply persists", async () => {
    vi.mocked(createBrowserSession).mockResolvedValueOnce(sessionMeta);
    vi.mocked(browserScreenshot).mockResolvedValueOnce({
      seq: 1,
      viewportPx: { width: 1280, height: 800 },
      dataBase64: "AAAA",
      persisted: false,
    });
    vi.mocked(browserApplyScreenshot).mockResolvedValueOnce({
      seq: 1,
      viewportPx: { width: 1280, height: 800 },
      persisted: true,
      path: "browser-1.png",
      sha256: "a".repeat(64),
      bytes: 4,
    });
    render(<BrowserWidget />);
    await userEvent.click(screen.getByRole("button", { name: /Open session/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Screenshot$/i })).toBeEnabled();
    });
    await userEvent.click(screen.getByRole("button", { name: /^Screenshot$/i }));
    const applyButton = await screen.findByRole("button", { name: /^Apply$/i });
    await waitFor(() => {
      expect(applyButton).toBeEnabled();
    });
    await userEvent.click(applyButton);
    await waitFor(() => {
      expect(screen.getByText(/browser-1\.png/)).toBeInTheDocument();
    });
  });

  it("fetches status when not in a session", async () => {
    vi.mocked(fetchBrowserStatus).mockResolvedValueOnce({
      reachable: true,
      userAgent: "Chrome/130",
      browserVersion: "Chrome/130",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/xyz",
    });
    render(<BrowserWidget />);
    await userEvent.click(screen.getByRole("button", { name: /^Check$/i }));
    await waitFor(() => {
      expect(screen.getByText(/Reachable: yes/)).toBeInTheDocument();
    });
  });

  it("closes a session and clears state", async () => {
    vi.mocked(createBrowserSession).mockResolvedValueOnce(sessionMeta);
    vi.mocked(deleteBrowserSession).mockResolvedValueOnce(undefined);
    render(<BrowserWidget />);
    await userEvent.click(screen.getByRole("button", { name: /Open session/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Close$/i })).toBeEnabled();
    });
    await userEvent.click(screen.getByRole("button", { name: /^Close$/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Open session/i })).toBeEnabled();
    });
    expect(deleteBrowserSession).toHaveBeenCalledWith("session-1");
  });

  it("event log container has aria-live polite for screen-reader announcements", () => {
    render(<BrowserWidget />);
    const log = document.querySelector(".bw-log");
    expect(log).toHaveAttribute("aria-live", "polite");
    expect(log).toHaveAttribute("aria-atomic", "false");
  });

  it("keeps the contrast-sensitive widget class hooks in the rendered markup", async () => {
    vi.mocked(fetchBrowserStatus).mockResolvedValueOnce({
      reachable: true,
      userAgent: "Chrome/130",
      browserVersion: "Chrome/130",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/xyz",
    });
    vi.mocked(createBrowserSession).mockResolvedValueOnce(sessionMeta);
    render(<BrowserWidget />);
    expect(document.querySelector(".bw-field-label")).toBeInTheDocument();
    expect(document.querySelector(".bw-overlay")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Close$/i })).toHaveClass("bw-btn-danger");

    await userEvent.click(screen.getByRole("button", { name: /^Check$/i }));
    await waitFor(() => {
      expect(screen.getByText(/Reachable: yes/)).toBeInTheDocument();
    });
    const status = screen.getByText(/Reachable: yes/).closest(".bw-status");
    expect(status).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Open session/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Navigate$/i })).toBeEnabled();
    });
    expect(FakeEventSource.last).not.toBeNull();
    act(() => {
      FakeEventSource.last?.dispatch(
        "browser:navigated",
        JSON.stringify({
          kind: "navigated",
          sessionId: "session-1",
          payload: { originOnly: "http://127.0.0.1:5173", httpStatus: 200 },
        }),
      );
    });
    await waitFor(() => {
      expect(document.querySelector(".bw-status")).toHaveTextContent(/http:\/\/127\.0\.0\.1:5173/);
    });
    const logItem = document.querySelector(".bw-log-item");
    const logKind = document.querySelector(".bw-log-kind");
    expect(logItem).toBeInTheDocument();
    expect(logKind).toBeInTheDocument();
  });

  it("invokes content capture", async () => {
    vi.mocked(createBrowserSession).mockResolvedValueOnce(sessionMeta);
    vi.mocked(browserContent).mockResolvedValueOnce({
      seq: 2,
      byteLength: 9,
      redactedHtml: "<html>x</html>",
    });
    render(<BrowserWidget />);
    await userEvent.click(screen.getByRole("button", { name: /Open session/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Capture HTML/i })).toBeEnabled();
    });
    await userEvent.click(screen.getByRole("button", { name: /Capture HTML/i }));
    await waitFor(() => {
      expect(browserContent).toHaveBeenCalledWith("session-1");
    });
  });
});
