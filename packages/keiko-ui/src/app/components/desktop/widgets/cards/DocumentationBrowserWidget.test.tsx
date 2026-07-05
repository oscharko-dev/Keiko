// Epic #1851 (ADR-0113) — DocumentationBrowserWidget tests. Mocks the typed BFF client so the widget
// drives its governed state machine through the same paths a real BFF would. Covers: render +
// accessible names, empty-input guard, the governed state matrix (deferred/blocked/proxy/preview),
// error surface, reload, no-stale-state after failure, and the disabled indexing affordance.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../../lib/api";
import { navigateDocumentation } from "../../../../../lib/docs-browser-api";
import type {
  DocumentationNavigationReason,
  DocumentationNavigationResult,
  DocumentationReasonSeverity,
} from "../../../../../lib/types";
import { DocumentationBrowserWidget } from "./DocumentationBrowserWidget";

vi.mock("../../../../../lib/docs-browser-api", () => ({
  navigateDocumentation: vi.fn(),
}));

const mockNavigate = vi.mocked(navigateDocumentation);

function result(
  reason: DocumentationNavigationReason,
  severity: DocumentationReasonSeverity,
  originSummary = "https://intranet",
): DocumentationNavigationResult {
  return {
    schemaVersion: "1",
    targetClass: "intranet-http",
    originSummary,
    pathSummary: "/…",
    reason,
    severity,
    capability: {
      previewAvailable: reason === "preview-available",
      backendAvailable: true,
      indexingProposalAvailable: false,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("DocumentationBrowserWidget", () => {
  it("renders the address input and controls with accessible names", () => {
    render(<DocumentationBrowserWidget />);
    expect(screen.getByRole("textbox", { name: "Documentation address" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("shows a disabled indexing affordance that never implies indexing has happened", () => {
    render(<DocumentationBrowserWidget />);
    const indexing = screen.getByRole("button", { name: "Prepare for indexing" });
    expect(indexing).toBeDisabled();
    expect(screen.getByText(/Indexing arrives in a later Keiko release/i)).toBeInTheDocument();
  });

  it("guards against an empty address without calling the BFF", async () => {
    const user = userEvent.setup();
    render(<DocumentationBrowserWidget />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/Enter a documentation address/i);
  });

  it("defers rendering for an intranet manual and shows the current target", async () => {
    const user = userEvent.setup();
    mockNavigate.mockResolvedValue(result("rendering-deferred", "limitation"));
    render(<DocumentationBrowserWidget />);
    await user.type(
      screen.getByRole("textbox", { name: "Documentation address" }),
      "https://intranet/handbook",
    );
    await user.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(screen.getByText("Opened for inspection")).toBeInTheDocument());
    expect(document.querySelector(".db-state")).toHaveTextContent(
      /nothing has been crawled, indexed/i,
    );
    expect(screen.getByText("https://intranet/…")).toBeInTheDocument();
  });

  it("states that a page refused embedding and that Keiko will not bypass the policy", async () => {
    const user = userEvent.setup();
    mockNavigate.mockResolvedValue(result("frame-embedding-refused", "limitation"));
    render(<DocumentationBrowserWidget />);
    await user.type(screen.getByRole("textbox", { name: "Documentation address" }), "https://x");
    await user.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(screen.getByText("Page refused embedding")).toBeInTheDocument());
    expect(document.querySelector(".db-state")).toHaveTextContent(
      /does not bypass the site's embedding policy/i,
    );
  });

  it("respects enterprise network policy for proxy/firewall blocks", async () => {
    const user = userEvent.setup();
    mockNavigate.mockResolvedValue(result("proxy-or-firewall-blocked", "limitation"));
    render(<DocumentationBrowserWidget />);
    await user.type(screen.getByRole("textbox", { name: "Documentation address" }), "https://x");
    await user.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(screen.getByText("Blocked by network policy")).toBeInTheDocument());
    expect(document.querySelector(".db-state")).toHaveTextContent(/will not route around it/i);
  });

  it("marks a reachable loopback backend as ready to preview", async () => {
    const user = userEvent.setup();
    mockNavigate.mockResolvedValue(result("preview-available", "ready", "http://127.0.0.1:8080"));
    render(<DocumentationBrowserWidget />);
    await user.type(
      screen.getByRole("textbox", { name: "Documentation address" }),
      "http://127.0.0.1:8080/docs",
    );
    await user.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() =>
      expect(screen.getByText("Local documentation reachable")).toBeInTheDocument(),
    );
    expect(document.querySelector(".db-state-ready")).toBeInTheDocument();
  });

  it("surfaces a BFF error as an alert and leaves no stale loaded state", async () => {
    const user = userEvent.setup();
    mockNavigate
      .mockResolvedValueOnce(result("rendering-deferred", "limitation"))
      .mockRejectedValueOnce(new ApiError("INTERNAL", "Server error.", 500));
    render(<DocumentationBrowserWidget />);
    const input = screen.getByRole("textbox", { name: "Documentation address" });
    await user.type(input, "https://intranet/handbook");
    await user.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(screen.getByText("Opened for inspection")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Server error."));
    expect(screen.queryByText("Opened for inspection")).not.toBeInTheDocument();
    expect(screen.getByText(/\(INTERNAL\)/)).toBeInTheDocument();
  });

  it("reloads the last target through the BFF", async () => {
    const user = userEvent.setup();
    mockNavigate.mockResolvedValue(result("rendering-deferred", "limitation"));
    render(<DocumentationBrowserWidget />);
    await user.type(
      screen.getByRole("textbox", { name: "Documentation address" }),
      "https://intranet/handbook",
    );
    await user.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(screen.getByText("Opened for inspection")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledTimes(2));
    expect(mockNavigate).toHaveBeenLastCalledWith("https://intranet/handbook");
  });

  it("keeps the widget-scoped class hooks in the rendered markup", async () => {
    const user = userEvent.setup();
    mockNavigate.mockResolvedValue(result("rendering-deferred", "limitation"));
    render(<DocumentationBrowserWidget />);
    expect(document.querySelector(".db-field-label")).toBeInTheDocument();
    expect(document.querySelector(".db-future")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Documentation address" }), "https://x");
    await user.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(document.querySelector(".db-state")).toBeInTheDocument());
    expect(document.querySelector(".db-target")).toBeInTheDocument();
  });
});
