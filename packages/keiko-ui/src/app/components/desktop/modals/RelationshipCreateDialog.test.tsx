import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RelationshipDenialCode } from "@oscharko-dev/keiko-contracts";
import { RelationshipCreateDialog } from "./RelationshipCreateDialog";

vi.mock("../../../relationships/api", () => ({
  createRelationship: vi.fn(),
  validateRelationshipProposal: vi.fn(),
  BACKEND_UNREACHABLE_MESSAGE:
    "Unable to reach the local backend. Check that the Keiko server is running (keiko ui).",
  RelationshipApiError: class RelationshipApiError extends Error {
    readonly code: string;
    readonly status: number;
    readonly reasons: ReadonlyArray<{
      readonly code: RelationshipDenialCode;
      readonly message: string;
    }>;

    constructor(
      code: string,
      message: string,
      status: number,
      reasons: ReadonlyArray<{
        readonly code: RelationshipDenialCode;
        readonly message: string;
      }> = [],
    ) {
      super(message);
      this.name = "RelationshipApiError";
      this.code = code;
      this.status = status;
      this.reasons = reasons;
    }
  },
}));

import {
  createRelationship,
  validateRelationshipProposal,
  RelationshipApiError,
} from "../../../relationships/api";

const mockCreateRelationship = vi.mocked(createRelationship);
const mockValidateRelationshipProposal = vi.mocked(validateRelationshipProposal);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makePreviewDenial(code: RelationshipDenialCode, message: string) {
  return new RelationshipApiError("relationship/policy-denied", message, 422, [{ code, message }]);
}

function renderDialog() {
  return render(<RelationshipCreateDialog onClose={vi.fn()} />);
}

function setProposal(sourceId: string, targetId: string) {
  fireEvent.change(screen.getByLabelText("Source endpoint ID"), {
    target: { value: sourceId },
  });
  fireEvent.change(screen.getByLabelText("Target endpoint ID"), {
    target: { value: targetId },
  });
}

async function advancePreviewDebounce() {
  await act(async () => {
    vi.advanceTimersByTime(250);
  });
}

async function settlePreview(work: () => void) {
  await act(async () => {
    work();
    await Promise.resolve();
  });
}

describe("RelationshipCreateDialog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockValidateRelationshipProposal.mockReset();
    mockCreateRelationship.mockReset();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("ignores a stale denial response after a newer preview succeeds", async () => {
    const firstPreview = deferred<{ decision: { allowed: true; reasons: readonly [] } }>();
    const secondPreview = deferred<{ decision: { allowed: true; reasons: readonly [] } }>();

    mockValidateRelationshipProposal
      .mockImplementationOnce(() => firstPreview.promise)
      .mockImplementationOnce(() => secondPreview.promise);

    renderDialog();

    setProposal("src-old", "tgt-old");
    await advancePreviewDebounce();
    expect(mockValidateRelationshipProposal).toHaveBeenCalledTimes(1);

    setProposal("src-new", "tgt-new");
    await advancePreviewDebounce();
    expect(mockValidateRelationshipProposal).toHaveBeenCalledTimes(2);

    await settlePreview(() => {
      secondPreview.resolve({ decision: { allowed: true, reasons: [] } });
    });
    expect(screen.queryByTestId("server-denial-banner")).not.toBeInTheDocument();

    await settlePreview(() => {
      firstPreview.reject(
        makePreviewDenial("denied/non-existent-target", "Target does not exist."),
      );
    });
    expect(screen.queryByTestId("server-denial-banner")).not.toBeInTheDocument();
  });

  it("ignores a stale success response after a newer preview is denied", async () => {
    const firstPreview = deferred<{ decision: { allowed: true; reasons: readonly [] } }>();
    const secondPreview = deferred<{ decision: { allowed: true; reasons: readonly [] } }>();

    mockValidateRelationshipProposal
      .mockImplementationOnce(() => firstPreview.promise)
      .mockImplementationOnce(() => secondPreview.promise);

    renderDialog();

    setProposal("src-old", "tgt-old");
    await advancePreviewDebounce();
    expect(mockValidateRelationshipProposal).toHaveBeenCalledTimes(1);

    setProposal("src-new", "tgt-new");
    await advancePreviewDebounce();
    expect(mockValidateRelationshipProposal).toHaveBeenCalledTimes(2);

    await settlePreview(() => {
      secondPreview.reject(
        makePreviewDenial("denied/non-existent-target", "Target does not exist."),
      );
    });
    expect(screen.getByTestId("server-denial-banner")).toHaveTextContent("Target does not exist.");

    await settlePreview(() => {
      firstPreview.resolve({ decision: { allowed: true, reasons: [] } });
    });
    expect(screen.getByTestId("server-denial-banner")).toHaveTextContent("Target does not exist.");
  });

  it("keeps security denials visible across later successful previews until dismissed", async () => {
    const firstPreview = deferred<{ decision: { allowed: true; reasons: readonly [] } }>();
    const secondPreview = deferred<{ decision: { allowed: true; reasons: readonly [] } }>();

    mockValidateRelationshipProposal
      .mockImplementationOnce(() => firstPreview.promise)
      .mockImplementationOnce(() => secondPreview.promise);

    renderDialog();

    setProposal("src-path", "tgt-path");
    await advancePreviewDebounce();
    expect(mockValidateRelationshipProposal).toHaveBeenCalledTimes(1);

    await settlePreview(() => {
      firstPreview.reject(
        makePreviewDenial(
          "denied/path-not-contained",
          "The workspace path is outside the project boundary or matches a deny-listed pattern.",
        ),
      );
    });
    expect(screen.getByTestId("server-denial-banner")).toHaveTextContent(
      "denied/path-not-contained",
    );
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();

    setProposal("src-valid", "tgt-valid");
    await advancePreviewDebounce();
    expect(mockValidateRelationshipProposal).toHaveBeenCalledTimes(2);

    await settlePreview(() => {
      secondPreview.resolve({ decision: { allowed: true, reasons: [] } });
    });
    expect(screen.getByTestId("server-denial-banner")).toHaveTextContent(
      "denied/path-not-contained",
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("server-denial-banner")).not.toBeInTheDocument();
  });

  it("mounts the overlay on document.body so position:fixed escapes the transformed canvas", () => {
    renderDialog();
    expect(screen.getByTestId("rel-create-overlay").parentElement).toBe(document.body);
  });

  it("does not submit via Ctrl/Cmd+Enter while the form is incomplete", () => {
    renderDialog();
    fireEvent.keyDown(screen.getByTestId("rel-create-dialog"), { key: "Enter", ctrlKey: true });
    expect(mockCreateRelationship).not.toHaveBeenCalled();
  });

  it("clears a non-security submit denial on the next form edit so Create is not a dead end", async () => {
    mockValidateRelationshipProposal.mockResolvedValue({
      decision: { allowed: true, reasons: [] },
    });
    mockCreateRelationship.mockRejectedValueOnce(
      new RelationshipApiError("relationship/bad-request", 'Field "id" is required.', 400),
    );

    renderDialog();
    setProposal("src-a", "tgt-a");
    await advancePreviewDebounce();

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId("server-denial-banner")).toHaveTextContent(
      "relationship/bad-request",
    );
    expect(screen.getByRole("button", { name: "Create" })).toHaveAttribute("aria-disabled", "true");

    // Editing the form clears the stale non-security submit denial.
    setProposal("src-b", "tgt-b");
    expect(screen.queryByTestId("server-denial-banner")).not.toBeInTheDocument();
  });
});
