// Issue #189 Slice 4 — unit tests for CapsuleRename ("beschriften").
// Covers: toggle, prefilled values, minimal-patch computation (name-only, description-only,
// no-op), the non-empty-name gate, API error surfacing, and jest-axe on both states.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { CapsuleRename } from "./capsule-rename";
import type { CapsuleRenameProps } from "./capsule-rename";
import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import type { CapsuleDetail } from "@/lib/local-knowledge-api";
import { ApiError } from "@/lib/api";

const DEFAULT_ID = "cap-42" as KnowledgeCapsuleId;

function okRename(): CapsuleDetail {
  return {} as unknown as CapsuleDetail;
}

function defaultProps(overrides: Partial<CapsuleRenameProps> = {}): CapsuleRenameProps {
  return {
    capsuleId: DEFAULT_ID,
    displayName: "Engineering Docs",
    description: "Original description",
    onRenamed: vi.fn(),
    renameImpl: vi.fn().mockResolvedValue(okRename()),
    ...overrides,
  };
}

describe("CapsuleRename — toggle and prefill", () => {
  it("shows a Rename button and opens a prefilled form on click", async () => {
    const user = userEvent.setup();
    render(<CapsuleRename {...defaultProps()} />);

    await user.click(screen.getByRole("button", { name: /rename capsule/i }));

    expect(screen.getByLabelText(/capsule display name/i)).toHaveValue("Engineering Docs");
    expect(screen.getByLabelText(/capsule description/i)).toHaveValue("Original description");
  });
});

describe("CapsuleRename — minimal patch", () => {
  it("sends only the displayName when only the name changed", async () => {
    const user = userEvent.setup();
    const renameImpl = vi.fn().mockResolvedValue(okRename());
    const onRenamed = vi.fn();
    render(<CapsuleRename {...defaultProps({ renameImpl, onRenamed })} />);

    await user.click(screen.getByRole("button", { name: /rename capsule/i }));
    const nameInput = screen.getByLabelText(/capsule display name/i);
    await user.clear(nameInput);
    await user.type(nameInput, "Renamed Docs");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(renameImpl).toHaveBeenCalledWith(DEFAULT_ID, { displayName: "Renamed Docs" });
    });
    expect(onRenamed).toHaveBeenCalledOnce();
  });

  it("sends only the description when only the description changed", async () => {
    const user = userEvent.setup();
    const renameImpl = vi.fn().mockResolvedValue(okRename());
    render(<CapsuleRename {...defaultProps({ renameImpl })} />);

    await user.click(screen.getByRole("button", { name: /rename capsule/i }));
    const descInput = screen.getByLabelText(/capsule description/i);
    await user.clear(descInput);
    await user.type(descInput, "New description");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(renameImpl).toHaveBeenCalledWith(DEFAULT_ID, { description: "New description" });
    });
  });

  it("does not call the API when nothing changed", async () => {
    const user = userEvent.setup();
    const renameImpl = vi.fn().mockResolvedValue(okRename());
    const onRenamed = vi.fn();
    render(<CapsuleRename {...defaultProps({ renameImpl, onRenamed })} />);

    await user.click(screen.getByRole("button", { name: /rename capsule/i }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(renameImpl).not.toHaveBeenCalled();
    expect(onRenamed).not.toHaveBeenCalled();
    // editor closed back to the Rename button
    expect(screen.getByRole("button", { name: /rename capsule/i })).toBeInTheDocument();
  });
});

describe("CapsuleRename — validation and errors", () => {
  it("blocks an empty display name and does not call the API", async () => {
    const user = userEvent.setup();
    const renameImpl = vi.fn().mockResolvedValue(okRename());
    render(<CapsuleRename {...defaultProps({ renameImpl })} />);

    await user.click(screen.getByRole("button", { name: /rename capsule/i }));
    await user.clear(screen.getByLabelText(/capsule display name/i));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(screen.getByRole("alert")).toHaveTextContent(/display name is required/i);
    expect(renameImpl).not.toHaveBeenCalled();
  });

  it("surfaces an API error and keeps the form open", async () => {
    const user = userEvent.setup();
    const renameImpl = vi.fn().mockRejectedValue(new ApiError("INVALID_REQUEST", "bad name", 400));
    const onRenamed = vi.fn();
    render(<CapsuleRename {...defaultProps({ renameImpl, onRenamed })} />);

    await user.click(screen.getByRole("button", { name: /rename capsule/i }));
    const nameInput = screen.getByLabelText(/capsule display name/i);
    await user.clear(nameInput);
    await user.type(nameInput, "Whatever");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/bad name/i);
    });
    expect(onRenamed).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/capsule display name/i)).toBeInTheDocument();
  });
});

describe("CapsuleRename — accessibility", () => {
  it("has no axe violations in the collapsed state", async () => {
    const { container } = render(<CapsuleRename {...defaultProps()} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no axe violations in the editing state", async () => {
    const user = userEvent.setup();
    const { container } = render(<CapsuleRename {...defaultProps()} />);
    await user.click(screen.getByRole("button", { name: /rename capsule/i }));
    expect(await axe(container)).toHaveNoViolations();
  });
});
