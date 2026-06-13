// Issue #211 — tests for MemoryDetail: loading, error/retry, not-found, success states,
// formatScope branches, ValiditySection copy, staleReason, optional provenance fields.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryDetail } from "./MemoryDetail";
import type { MemoryDetailResponse } from "@/lib/memory-api";
import type {
  MemoryRecord,
  MemoryId,
  MemoryUserId,
  MemoryWorkspaceId,
  MemoryWorkflowDefinitionId,
} from "@oscharko-dev/keiko-contracts";

// ---------------------------------------------------------------------------
// next/navigation + next/link mocks (required because MemoryDetail renders
// RecordHeader which contains a <Link> pointing back to /memoriaviva)
// ---------------------------------------------------------------------------

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => ({ get: vi.fn().mockReturnValue(null) }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// ---------------------------------------------------------------------------
// MemoryActions mock — the component pulls in EditMemoryDialog and
// ForgetConfirmDialog which have their own heavy dependencies. Stub at the
// module boundary so tests stay fast and focused on MemoryDetail behaviour.
// ---------------------------------------------------------------------------

vi.mock("./MemoryActions", () => ({
  MemoryActions: () => <div data-testid="memory-actions" />,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMemoryId(raw: string): MemoryId {
  return raw as MemoryId;
}

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: makeMemoryId("mem-001"),
    schemaVersion: "1",
    scope: { kind: "global" },
    type: "preference",
    body: "Always use TypeScript strict mode.",
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: 1_700_000_000_000,
      confidence: 0.75,
      sensitivity: "public",
      modelIdentity: { provider: "anthropic", modelId: "claude-opus-4" },
    },
    validity: { validFrom: 1_700_000_000_000 },
    status: "accepted",
    pinned: false,
    tags: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeDetailResponse(record: MemoryRecord): MemoryDetailResponse {
  return { memory: record };
}

// ---------------------------------------------------------------------------
// fetchMemoryImpl helpers
// ---------------------------------------------------------------------------

function neverResolves(): Promise<MemoryDetailResponse> {
  return new Promise(() => undefined);
}

function resolvesWith(record: MemoryRecord) {
  return vi.fn().mockResolvedValue(makeDetailResponse(record));
}

function resolvesWithNull() {
  // The BFF returns { memory: null } when the record is not found.
  // MemoryDetail sets record = res.memory which becomes null.
  return vi.fn().mockResolvedValue({ memory: null } as unknown as MemoryDetailResponse);
}

function rejectsWith(message: string) {
  return vi.fn().mockRejectedValue(new Error(message));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MemoryDetail — loading state", () => {
  it("renders role=status with 'Loading memory…' while fetchImpl is pending", () => {
    render(<MemoryDetail id="mem-001" fetchMemoryImpl={() => neverResolves()} />);

    const status = screen.getByRole("status");
    expect(status).toBeInTheDocument();
    expect(status).toHaveTextContent("Loading memory…");
  });

  it("does NOT render role=alert or MemoryActions while still loading", () => {
    render(<MemoryDetail id="mem-001" fetchMemoryImpl={() => neverResolves()} />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByTestId("memory-actions")).not.toBeInTheDocument();
  });
});

describe("MemoryDetail — error state", () => {
  it("renders role=alert with the rejection message when fetchImpl rejects", async () => {
    render(<MemoryDetail id="mem-001" fetchMemoryImpl={rejectsWith("network timeout")} />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByText(/network timeout/i)).toBeInTheDocument();
  });

  it("renders a Retry button in the error state", async () => {
    render(<MemoryDetail id="mem-001" fetchMemoryImpl={rejectsWith("fetch failed")} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    });
  });

  it("clicking Retry re-invokes fetchImpl (called twice total)", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("first failure"))
      .mockRejectedValue(new Error("second failure"));

    const user = userEvent.setup();
    render(<MemoryDetail id="mem-001" fetchMemoryImpl={fetchMock} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /retry/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  it("does NOT render MemoryActions in the error state", async () => {
    render(<MemoryDetail id="mem-001" fetchMemoryImpl={rejectsWith("some error")} />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("memory-actions")).not.toBeInTheDocument();
  });
});

describe("MemoryDetail — not-found state", () => {
  it("renders 'Memory not found' when fetchImpl resolves to null record", async () => {
    render(<MemoryDetail id="mem-missing" fetchMemoryImpl={resolvesWithNull()} />);

    await waitFor(() => {
      expect(screen.getByText("Memory not found")).toBeInTheDocument();
    });
  });

  it("does NOT render MemoryActions when record is null", async () => {
    render(<MemoryDetail id="mem-missing" fetchMemoryImpl={resolvesWithNull()} />);

    await waitFor(() => {
      expect(screen.getByText("Memory not found")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("memory-actions")).not.toBeInTheDocument();
  });
});

describe("MemoryDetail — success state with full record", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the record body text", async () => {
    const record = makeRecord({ body: "Always use TypeScript strict mode." });
    render(<MemoryDetail id="mem-001" fetchMemoryImpl={resolvesWith(record)} />);

    await waitFor(() => {
      expect(screen.getByText("Always use TypeScript strict mode.")).toBeInTheDocument();
    });
  });

  it("renders the type in the article heading", async () => {
    const record = makeRecord({ type: "preference" });
    render(<MemoryDetail id="mem-001" fetchMemoryImpl={resolvesWith(record)} />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/preference/i);
    });
  });

  it("renders the status badge as a static label (no live region)", async () => {
    const record = makeRecord({ status: "accepted" });
    render(<MemoryDetail id="mem-001" fetchMemoryImpl={resolvesWith(record)} />);

    await waitFor(() => {
      expect(screen.getByText("accepted")).toBeInTheDocument();
    });
    // Static metadata badges must not be role="status" live regions (uiux-fix F005).
    expect(screen.getByText("accepted").className).toContain("mc-badge-accepted");
  });

  it("renders the sensitivity from provenance", async () => {
    const record = makeRecord({
      provenance: {
        sourceKind: "explicit-user-instruction",
        capturedAt: 1_700_000_000_000,
        confidence: 0.8,
        sensitivity: "confidential",
      },
    });
    render(<MemoryDetail id="mem-001" fetchMemoryImpl={resolvesWith(record)} />);

    await waitFor(() => {
      expect(screen.getByText("confidential")).toBeInTheDocument();
    });
  });

  it("renders confidence as a rounded percentage", async () => {
    const record = makeRecord({
      provenance: {
        sourceKind: "explicit-user-instruction",
        capturedAt: 1_700_000_000_000,
        confidence: 0.75,
        sensitivity: "public",
      },
    });
    render(<MemoryDetail id="mem-001" fetchMemoryImpl={resolvesWith(record)} />);

    await waitFor(() => {
      expect(screen.getByText("75%")).toBeInTheDocument();
    });
  });

  it("renders the captured-at timestamp from provenance", async () => {
    const capturedAt = 1_700_000_000_000;
    const record = makeRecord({
      provenance: {
        sourceKind: "explicit-user-instruction",
        capturedAt,
        confidence: 0.9,
        sensitivity: "public",
      },
    });
    render(<MemoryDetail id="mem-001" fetchMemoryImpl={resolvesWith(record)} />);

    const expectedDate = new Date(capturedAt).toLocaleString();
    await waitFor(() => {
      expect(screen.getAllByText(expectedDate).length).toBeGreaterThanOrEqual(1);
    });
  });

  it("renders the model identity (provider / modelId) from provenance", async () => {
    const record = makeRecord({
      provenance: {
        sourceKind: "explicit-user-instruction",
        capturedAt: 1_700_000_000_000,
        confidence: 0.9,
        sensitivity: "public",
        modelIdentity: { provider: "anthropic", modelId: "claude-opus-4" },
      },
    });
    render(<MemoryDetail id="mem-001" fetchMemoryImpl={resolvesWith(record)} />);

    await waitFor(() => {
      expect(screen.getByText("anthropic / claude-opus-4")).toBeInTheDocument();
    });
  });

  it("renders the validity section", async () => {
    const record = makeRecord({ validity: { validFrom: 1_700_000_000_000 } });
    render(<MemoryDetail id="mem-001" fetchMemoryImpl={resolvesWith(record)} />);

    await waitFor(() => {
      expect(screen.getByRole("region", { name: /validity/i })).toBeInTheDocument();
    });
  });

  it("renders MemoryActions when record is loaded successfully", async () => {
    const record = makeRecord();
    render(<MemoryDetail id="mem-001" fetchMemoryImpl={resolvesWith(record)} />);

    await waitFor(() => {
      expect(screen.getByTestId("memory-actions")).toBeInTheDocument();
    });
  });
});

describe("MemoryDetail — formatScope branches", () => {
  it("scope.kind='workspace' renders workspace:<id>", async () => {
    const record = makeRecord({
      scope: { kind: "workspace", workspaceId: "ws-abc" as MemoryWorkspaceId },
    });
    render(<MemoryDetail id="mem-001" fetchMemoryImpl={resolvesWith(record)} />);

    await waitFor(() => {
      expect(screen.getByText("workspace:ws-abc")).toBeInTheDocument();
    });
  });

  it("scope.kind='global' renders 'global'", async () => {
    const record = makeRecord({ scope: { kind: "global" } });
    render(<MemoryDetail id="mem-001" fetchMemoryImpl={resolvesWith(record)} />);

    await waitFor(() => {
      expect(screen.getByText("global")).toBeInTheDocument();
    });
  });

  it("scope.kind='user' renders user:<userId>", async () => {
    const record = makeRecord({
      scope: { kind: "user", userId: "user-42" as MemoryUserId },
    });
    render(<MemoryDetail id="mem-001" fetchMemoryImpl={resolvesWith(record)} />);

    await waitFor(() => {
      expect(screen.getByText("user:user-42")).toBeInTheDocument();
    });
  });

  it("scope.kind='workflow' renders workflow:<workflowDefinitionId>", async () => {
    const record = makeRecord({
      scope: {
        kind: "workflow",
        workflowDefinitionId: "wf-99" as MemoryWorkflowDefinitionId,
      },
    });
    render(<MemoryDetail id="mem-001" fetchMemoryImpl={resolvesWith(record)} />);

    await waitFor(() => {
      expect(screen.getByText("workflow:wf-99")).toBeInTheDocument();
    });
  });
});

describe("MemoryDetail — ValiditySection", () => {
  it("renders 'No expiry' when validUntil is absent", async () => {
    const record = makeRecord({ validity: { validFrom: 1_700_000_000_000 } });
    render(<MemoryDetail id="mem-001" fetchMemoryImpl={resolvesWith(record)} />);

    await waitFor(() => {
      expect(screen.getByText("No expiry")).toBeInTheDocument();
    });
  });

  it("renders the formatted validUntil date when present", async () => {
    const validUntil = 1_800_000_000_000;
    const record = makeRecord({ validity: { validFrom: 1_700_000_000_000, validUntil } });
    render(<MemoryDetail id="mem-001" fetchMemoryImpl={resolvesWith(record)} />);

    const expectedDate = new Date(validUntil).toLocaleString();
    await waitFor(() => {
      expect(screen.getByText(expectedDate)).toBeInTheDocument();
    });
  });

  it("does NOT render 'No expiry' when validUntil is present", async () => {
    const record = makeRecord({
      validity: { validFrom: 1_700_000_000_000, validUntil: 1_800_000_000_000 },
    });
    render(<MemoryDetail id="mem-001" fetchMemoryImpl={resolvesWith(record)} />);

    await waitFor(() => {
      expect(screen.queryByText("No expiry")).not.toBeInTheDocument();
    });
  });
});

describe("MemoryDetail — staleReason", () => {
  it("renders the staleReason text when present", async () => {
    const record = makeRecord({ staleReason: "source workflow was rejected" });
    render(<MemoryDetail id="mem-001" fetchMemoryImpl={resolvesWith(record)} />);

    await waitFor(() => {
      expect(screen.getByText("source workflow was rejected")).toBeInTheDocument();
    });
  });

  it("does NOT render the stale reason row when staleReason is absent", async () => {
    const record = makeRecord();
    render(<MemoryDetail id="mem-001" fetchMemoryImpl={resolvesWith(record)} />);

    await waitFor(() => {
      expect(screen.getByTestId("memory-actions")).toBeInTheDocument();
    });
    expect(screen.queryByText(/stale reason/i)).not.toBeInTheDocument();
  });
});

describe("MemoryDetail — optional provenance fields", () => {
  it("does NOT render Model row when provenance.modelIdentity is absent", async () => {
    const record = makeRecord({
      provenance: {
        sourceKind: "explicit-user-instruction",
        capturedAt: 1_700_000_000_000,
        confidence: 0.8,
        sensitivity: "public",
        // modelIdentity deliberately omitted
      },
    });
    render(<MemoryDetail id="mem-001" fetchMemoryImpl={resolvesWith(record)} />);

    await waitFor(() => {
      expect(screen.getByTestId("memory-actions")).toBeInTheDocument();
    });
    expect(screen.queryByText(/model/i)).not.toBeInTheDocument();
  });

  it("does NOT render Rationale row when captureRationale is absent", async () => {
    const record = makeRecord({
      provenance: {
        sourceKind: "explicit-user-instruction",
        capturedAt: 1_700_000_000_000,
        confidence: 0.8,
        sensitivity: "public",
        // captureRationale deliberately omitted
      },
    });
    render(<MemoryDetail id="mem-001" fetchMemoryImpl={resolvesWith(record)} />);

    await waitFor(() => {
      expect(screen.getByTestId("memory-actions")).toBeInTheDocument();
    });
    expect(screen.queryByText("Rationale")).not.toBeInTheDocument();
  });

  it("renders the Rationale row when captureRationale is present", async () => {
    const record = makeRecord({
      provenance: {
        sourceKind: "explicit-user-instruction",
        capturedAt: 1_700_000_000_000,
        confidence: 0.8,
        sensitivity: "public",
        captureRationale: "User said this explicitly",
      },
    });
    render(<MemoryDetail id="mem-001" fetchMemoryImpl={resolvesWith(record)} />);

    await waitFor(() => {
      expect(screen.getByText("User said this explicitly")).toBeInTheDocument();
    });
  });
});
