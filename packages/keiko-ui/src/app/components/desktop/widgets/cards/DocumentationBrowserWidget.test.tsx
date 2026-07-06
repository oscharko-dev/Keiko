// Epic #1851/#1852 — DocumentationBrowserWidget tests. Mocks the typed BFF clients so the widget drives
// its governed state machines (navigation + indexing consent) through the same paths a real BFF would.
// Covers: render + accessible names, empty-input guard, the governed navigation matrix, the
// indexing-proposal affordance gating, consent (propose → approve), cancel, and the denied/degraded/
// already-indexed states that must never offer approval — plus jest-axe across the key states.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../../lib/api";
import {
  approveDocumentationIndexing,
  navigateDocumentation,
  proposeDocumentationIndexing,
} from "../../../../../lib/docs-browser-api";
import type {
  DocumentationIndexingApproval,
  DocumentationIndexingProposal,
  DocumentationManualProposalState,
  DocumentationManualScopePreview,
  DocumentationNavigationReason,
  DocumentationNavigationResult,
  DocumentationReasonSeverity,
} from "../../../../../lib/types";
import { DocumentationBrowserWidget } from "./DocumentationBrowserWidget";

vi.mock("../../../../../lib/docs-browser-api", () => ({
  navigateDocumentation: vi.fn(),
  proposeDocumentationIndexing: vi.fn(),
  approveDocumentationIndexing: vi.fn(),
}));

const mockNavigate = vi.mocked(navigateDocumentation);
const mockPropose = vi.mocked(proposeDocumentationIndexing);
const mockApprove = vi.mocked(approveDocumentationIndexing);

function result(
  reason: DocumentationNavigationReason,
  severity: DocumentationReasonSeverity,
  originSummary = "https://intranet",
  indexingProposalAvailable = true,
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
      indexingProposalAvailable,
    },
  };
}

function scopePreview(): DocumentationManualScopePreview {
  return {
    sourceKind: "html-manual-http",
    originSummary: "https://intranet",
    pathPrefixSummary: "/…",
    proposedPodName: "https://intranet — HTML manual",
    estimatedPageCount: null,
    limits: {
      maxPages: 200,
      maxDepth: 4,
      maxBytes: 25_000_000,
      maxLinkSample: 64,
      timeoutMs: 15_000,
      followRedirects: false,
    },
    deniedLinkClasses: ["cross-origin", "outside-path-prefix"],
    robotsPosture: "honor-robots-txt",
  };
}

function proposal(
  state: DocumentationManualProposalState,
  withPreview: boolean,
  alreadyIndexedPodId: string | null = null,
): DocumentationIndexingProposal {
  return {
    schemaVersion: "1",
    state,
    targetClass: "intranet-http",
    sourceKind: withPreview ? "html-manual-http" : null,
    confidence: withPreview ? "high" : "none",
    reasons: [],
    originSummary: "https://intranet",
    pathPrefixSummary: "/…",
    scopePreview: withPreview ? scopePreview() : null,
    alreadyIndexedPodId,
    approvalRequired: true,
    approved: false,
  };
}

function approval(): DocumentationIndexingApproval {
  return {
    schemaVersion: "1",
    approved: true,
    sourceKind: "html-manual-http",
    sourceFingerprint: "a".repeat(64),
    originSummary: "https://intranet",
    pathPrefixSummary: "/…",
    proposedPodName: "https://intranet — HTML manual",
    limits: scopePreview().limits,
  };
}

async function openEligibleManual(opts?: { readonly onOpenKnowledgePods?: () => void }): Promise<{
  readonly user: ReturnType<typeof userEvent.setup>;
  readonly container: HTMLElement;
}> {
  const user = userEvent.setup();
  mockNavigate.mockResolvedValue(result("rendering-deferred", "limitation"));
  const { container } = render(
    <DocumentationBrowserWidget onOpenKnowledgePods={opts?.onOpenKnowledgePods} />,
  );
  await user.type(
    screen.getByRole("textbox", { name: "Documentation address" }),
    "https://intranet/handbook/index.html",
  );
  await user.click(screen.getByRole("button", { name: "Open" }));
  await waitFor(() => expect(screen.getByText("Opened for inspection")).toBeInTheDocument());
  return { user, container };
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("DocumentationBrowserWidget — navigation", () => {
  it("renders the address input and controls with accessible names", () => {
    render(<DocumentationBrowserWidget />);
    expect(screen.getByRole("textbox", { name: "Documentation address" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("keeps the indexing affordance disabled until an eligible target is opened", () => {
    render(<DocumentationBrowserWidget />);
    const indexing = screen.getByRole("button", { name: "Prepare for indexing" });
    expect(indexing).toBeDisabled();
    expect(screen.getByText(/Open a local or intranet manual to check/i)).toBeInTheDocument();
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

  it("respects enterprise network policy for proxy/firewall blocks", async () => {
    const user = userEvent.setup();
    mockNavigate.mockResolvedValue(result("proxy-or-firewall-blocked", "limitation"));
    render(<DocumentationBrowserWidget />);
    await user.type(screen.getByRole("textbox", { name: "Documentation address" }), "https://x");
    await user.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(screen.getByText("Blocked by network policy")).toBeInTheDocument());
    expect(document.querySelector(".db-state")).toHaveTextContent(/will not route around it/i);
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
  });
});

describe("DocumentationBrowserWidget — indexing consent (#1868)", () => {
  it("enables the affordance for an eligible target and proposes a bounded scope", async () => {
    const { user } = await openEligibleManual();
    mockPropose.mockResolvedValue(proposal("likely-manual", true));
    const prepare = screen.getByRole("button", { name: "Prepare for indexing" });
    expect(prepare).not.toBeDisabled();
    await user.click(prepare);
    await waitFor(() =>
      expect(screen.getByText("Looks like an indexable manual")).toBeInTheDocument(),
    );
    expect(mockPropose).toHaveBeenCalledWith(
      "https://intranet/handbook/index.html",
      "rendering-deferred",
    );
    expect(screen.getByText(/up to 200 pages, depth 4, no redirects/i)).toBeInTheDocument();
    expect(screen.getByText(/Not yet sampled/i)).toBeInTheDocument();
  });

  it("records explicit consent through the approve endpoint", async () => {
    const { user } = await openEligibleManual();
    mockPropose.mockResolvedValue(proposal("likely-manual", true));
    mockApprove.mockResolvedValue(approval());
    await user.click(screen.getByRole("button", { name: "Prepare for indexing" }));
    await waitFor(() =>
      expect(screen.getByText("Looks like an indexable manual")).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "Create Knowledge Pod from this manual" }));
    await waitFor(() => expect(screen.getByText("Approved for indexing")).toBeInTheDocument());
    expect(mockApprove).toHaveBeenCalledWith(
      "https://intranet/handbook/index.html",
      "rendering-deferred",
    );
    expect(screen.getByText(/stays on this device/i)).toBeInTheDocument();
  });

  it("cancels a proposal without approving", async () => {
    const { user } = await openEligibleManual();
    mockPropose.mockResolvedValue(proposal("likely-manual", true));
    await user.click(screen.getByRole("button", { name: "Prepare for indexing" }));
    await waitFor(() =>
      expect(screen.getByText("Looks like an indexable manual")).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Looks like an indexable manual")).not.toBeInTheDocument();
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it("surfaces a propose error without offering consent", async () => {
    const { user } = await openEligibleManual();
    mockPropose.mockRejectedValue(new ApiError("INTERNAL", "Proposal failed.", 500));
    await user.click(screen.getByRole("button", { name: "Prepare for indexing" }));
    await waitFor(() => expect(screen.getByText(/Proposal failed\./)).toBeInTheDocument());
    expect(
      screen.queryByRole("button", { name: "Create Knowledge Pod from this manual" }),
    ).not.toBeInTheDocument();
  });
});

describe("DocumentationBrowserWidget — authentication-required (#1869)", () => {
  it("disables the indexing affordance and never proposes indexing after an auth-walled navigation", async () => {
    const user = userEvent.setup();
    mockNavigate.mockResolvedValue(result("authentication-required", "limitation"));
    render(<DocumentationBrowserWidget />);
    await user.type(
      screen.getByRole("textbox", { name: "Documentation address" }),
      "https://intranet/handbook/index.html",
    );
    await user.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(screen.getByText("Sign-in required")).toBeInTheDocument());
    const prepare = screen.getByRole("button", { name: "Prepare for indexing" });
    expect(prepare).toBeDisabled();
    await user.click(prepare);
    expect(mockPropose).not.toHaveBeenCalled();
  });
});

describe("DocumentationBrowserWidget — denied/degraded/already-indexed (#1869)", () => {
  it("never offers approval for a degraded (action page) proposal", async () => {
    const { user } = await openEligibleManual();
    mockPropose.mockResolvedValue(proposal("degraded", false));
    await user.click(screen.getByRole("button", { name: "Prepare for indexing" }));
    await waitFor(() => expect(screen.getByText("Not a static manual")).toBeInTheDocument());
    expect(
      screen.queryByRole("button", { name: "Create Knowledge Pod from this manual" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("points an already-indexed manual at the existing pod and can open Knowledge Pods", async () => {
    const onOpenKnowledgePods = vi.fn();
    const { user } = await openEligibleManual({ onOpenKnowledgePods });
    mockPropose.mockResolvedValue(proposal("already-indexed", false, "capsule-7"));
    await user.click(screen.getByRole("button", { name: "Prepare for indexing" }));
    await waitFor(() => expect(screen.getByText("Already in a Knowledge Pod")).toBeInTheDocument());
    expect(screen.getByText(/Open the existing pod/i)).toBeInTheDocument();
    // The concrete pod reference is surfaced so the user can locate it.
    expect(screen.getByText("capsule-7")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create Knowledge Pod from this manual" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "View your Knowledge Pods" }));
    expect(onOpenKnowledgePods).toHaveBeenCalledTimes(1);
  });

  it("never offers approval for a denied (credentialed/unsafe-scheme) proposal", async () => {
    const { user } = await openEligibleManual();
    mockPropose.mockResolvedValue(proposal("denied", false));
    await user.click(screen.getByRole("button", { name: "Prepare for indexing" }));
    await waitFor(() => expect(screen.getByText("Cannot index this target")).toBeInTheDocument());
    expect(
      screen.queryByRole("button", { name: "Create Knowledge Pod from this manual" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("never offers approval for an unsupported (public site / unsupported scheme) proposal", async () => {
    const { user } = await openEligibleManual();
    mockPropose.mockResolvedValue(proposal("unsupported", false));
    await user.click(screen.getByRole("button", { name: "Prepare for indexing" }));
    await waitFor(() => expect(screen.getByText("Not offered for indexing")).toBeInTheDocument());
    expect(
      screen.queryByRole("button", { name: "Create Knowledge Pod from this manual" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });
});

describe("DocumentationBrowserWidget — consent re-entry guard (#1868)", () => {
  it("offers no second approve while the first is pending and calls approve once", async () => {
    const { user } = await openEligibleManual();
    mockPropose.mockResolvedValue(proposal("likely-manual", true));
    let resolveApprove: (value: DocumentationIndexingApproval) => void = () => undefined;
    mockApprove.mockImplementation(
      () =>
        new Promise<DocumentationIndexingApproval>((resolve) => {
          resolveApprove = resolve;
        }),
    );
    await user.click(screen.getByRole("button", { name: "Prepare for indexing" }));
    await waitFor(() =>
      expect(screen.getByText("Looks like an indexable manual")).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "Create Knowledge Pod from this manual" }));
    // While the approval is in flight the consent panel is replaced by a busy state, so no second
    // approve can be triggered; the re-entry guard keeps the call count at one.
    await waitFor(() => expect(screen.getByText("Recording your consent…")).toBeInTheDocument());
    expect(
      screen.queryByRole("button", { name: "Create Knowledge Pod from this manual" }),
    ).not.toBeInTheDocument();
    expect(mockApprove).toHaveBeenCalledTimes(1);
    resolveApprove(approval());
    await waitFor(() => expect(screen.getByText("Approved for indexing")).toBeInTheDocument());
  });
});

describe("DocumentationBrowserWidget — cross-target navigation race (#1868)", () => {
  it("blocks navigating to a different target while a propose/approve call is in flight", async () => {
    // Regression for #1868: previously, handleOpen/handleReload only checked nav.working, which
    // propose/approve never set, so a user could open a different manual B while propose('A') was
    // still pending. runNavigate would then reset `indexing` to idle and, on success, make B the
    // displayed current target — but the late-resolving propose('A') call would unconditionally
    // repopulate `indexing` with A's stale scope preview, and a later approve click would read
    // nav.lastTarget at that time ('B'), sending an approval for a manual the user never reviewed.
    // Disabling Open/Reload while an indexing call is in flight removes the only UI path that could
    // trigger this interleaving.
    const { user } = await openEligibleManual();
    let resolvePropose: (value: DocumentationIndexingProposal) => void = () => undefined;
    mockPropose.mockImplementation(
      () =>
        new Promise<DocumentationIndexingProposal>((resolve) => {
          resolvePropose = resolve;
        }),
    );
    await user.click(screen.getByRole("button", { name: "Prepare for indexing" }));
    await waitFor(() => expect(screen.getByText("Checking for a manual…")).toBeInTheDocument());

    expect(screen.getByRole("button", { name: "Open" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Reload" })).toHaveAttribute("aria-disabled", "true");

    // Attempting to navigate to a different target while busy must not call the BFF at all.
    const input = screen.getByRole("textbox", { name: "Documentation address" });
    await user.clear(input);
    await user.type(input, "https://intranet-b/other.html{Enter}");
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(mockNavigate).toHaveBeenCalledTimes(1); // only the initial openEligibleManual() navigation
    expect(screen.getByText("https://intranet/…")).toBeInTheDocument();

    // Once the in-flight propose resolves, the proposal for the still-current target A is applied
    // and navigation is unblocked again.
    resolvePropose(proposal("likely-manual", true));
    await waitFor(() =>
      expect(screen.getByText("Looks like an indexable manual")).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Open" })).toHaveAttribute("aria-disabled", "false");
  });
});

describe("DocumentationBrowserWidget — a11y (jest-axe)", () => {
  it("has no axe violations in the initial (pre-navigation) state", async () => {
    const { container } = render(<DocumentationBrowserWidget />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no axe violations while a proposal with a scope preview is shown", async () => {
    const { user, container } = await openEligibleManual();
    mockPropose.mockResolvedValue(proposal("likely-manual", true));
    await user.click(screen.getByRole("button", { name: "Prepare for indexing" }));
    await waitFor(() =>
      expect(screen.getByText("Looks like an indexable manual")).toBeInTheDocument(),
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no axe violations in the approved state", async () => {
    const { user, container } = await openEligibleManual();
    mockPropose.mockResolvedValue(proposal("likely-manual", true));
    mockApprove.mockResolvedValue(approval());
    await user.click(screen.getByRole("button", { name: "Prepare for indexing" }));
    await waitFor(() =>
      expect(screen.getByText("Looks like an indexable manual")).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "Create Knowledge Pod from this manual" }));
    await waitFor(() => expect(screen.getByText("Approved for indexing")).toBeInTheDocument());
    expect(await axe(container)).toHaveNoViolations();
  });
});
