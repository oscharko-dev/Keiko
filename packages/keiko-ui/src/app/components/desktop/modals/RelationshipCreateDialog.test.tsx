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

  // WCAG 2.1.1 (item #26) — the dialog container must carry role=dialog + aria-modal
  // so screen readers switch to dialog-browse mode, and must have an accessible name
  // via aria-labelledby pointing at the visible title (WCAG 4.1.2).
  it("dialog container exposes role=dialog, aria-modal=true, and an accessible name via aria-labelledby (WCAG 2.1.1/4.1.2)", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog", { name: /create relationship/i });
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  // WCAG 2.1.1 — focus must move into the dialog on open so keyboard users can
  // interact without tabbing through the entire page behind the overlay.
  it("moves focus into the dialog on open (WCAG 2.1.1)", () => {
    renderDialog();
    expect(screen.getByRole("combobox", { name: /relationship type/i })).toHaveFocus();
  });

  it("does not submit via Ctrl/Cmd+Enter while the form is incomplete", () => {
    renderDialog();
    fireEvent.keyDown(screen.getByTestId("rel-create-dialog"), { key: "Enter", ctrlKey: true });
    expect(mockCreateRelationship).not.toHaveBeenCalled();
  });

  // MD-01 (WCAG 2.1.2): Escape/focus-trap handlers are dialog-scoped, not
  // window-scoped, so a concurrent overlay's Escape does not close this dialog.
  it("Escape on the dialog element closes it; Escape dispatched to window does not (MD-01)", () => {
    const onClose = vi.fn();
    render(<RelationshipCreateDialog onClose={onClose} />);
    const dialog = screen.getByTestId("rel-create-dialog");

    // Escape on window must NOT trigger close — handler is dialog-scoped.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    // Escape on the dialog element itself MUST trigger close.
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // GEN-UI-INTERACTION-005 / test-plan #52 — a backdrop click must not discard a
  // dirty form. While the user has typed data, pointer-down on the overlay is a
  // no-op; Escape and the explicit Cancel/Close controls still close.
  it("does not close on a backdrop pointer-down while the form is dirty", () => {
    const onClose = vi.fn();
    render(<RelationshipCreateDialog onClose={onClose} />);

    // Empty form: a backdrop click still dismisses (nothing to lose).
    fireEvent.pointerDown(screen.getByTestId("rel-create-overlay"));
    expect(onClose).toHaveBeenCalledTimes(1);
    onClose.mockClear();

    // Type into the ID fields — the form is now dirty.
    setProposal("src-dirty", "tgt-dirty");

    // A backdrop pointer-down must NOT discard the typed data.
    fireEvent.pointerDown(screen.getByTestId("rel-create-overlay"));
    expect(onClose).not.toHaveBeenCalled();

    // The explicit Cancel control still closes unconditionally.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledWith(null);
  });

  // GEN-UI-FOCUS-010 / test-plan #51 — the type combobox portals its options to
  // document.body, outside the dialog. Pressing Tab on a focused option must not
  // let focus escape the modal: the menu closes and focus returns to the trigger,
  // which lives inside the role=dialog container.
  it("keeps focus inside the dialog when Tab is pressed on an open type-combobox option", () => {
    render(<RelationshipCreateDialog onClose={vi.fn()} />);

    const dialog = screen.getByTestId("rel-create-dialog");
    const trigger = screen.getByRole("combobox", { name: /relationship type/i });

    // Open the listbox from the trigger. openMenu sets state and the popup is
    // positioned in a layout effect, both flushed synchronously by fireEvent's
    // act wrapper (this file runs on fake timers, so async find* helpers would
    // never resolve). Scope to the KeikoSelect popup — the native Source/Target
    // kind <select>s also expose role=option, so a page-wide option query is
    // ambiguous.
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const menu = document.querySelector(".ksel-menu");
    expect(menu).not.toBeNull();
    const options = Array.from(menu!.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    expect(options.length).toBeGreaterThan(0);
    const focusedOption = options.find((el) => el === document.activeElement) ?? options[0]!;

    // Tab on the option must close the menu and keep focus within the dialog.
    fireEvent.keyDown(focusedOption, { key: "Tab" });

    expect(document.querySelector(".ksel-menu")).toBeNull();
    expect(document.activeElement).not.toBeNull();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(trigger).toHaveFocus();
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
