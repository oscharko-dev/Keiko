// Issue #189 Slice 4 — unit tests for CapsuleSetComposeDialog ("zusammenlegen").
// Covers: member rendering, selection counter, the name/selection validation gates,
// a successful compose POSTs the chosen members, API errors surface, and jest-axe.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { CapsuleSetComposeDialog } from "./capsule-set-compose";
import type { CapsuleSetComposeDialogProps } from "./capsule-set-compose";
import type { CapsuleListEntry, CapsuleSetDetail } from "@/lib/local-knowledge-api";
import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import { ApiError } from "@/lib/api";

function capsule(id: string, displayName: string): CapsuleListEntry {
  return {
    id: id as KnowledgeCapsuleId,
    displayName,
    lifecycleState: "ready",
    sourceCount: 1,
    updatedAt: 1,
  };
}

const CAPSULES = [capsule("cap-1", "Alpha"), capsule("cap-2", "Beta"), capsule("cap-3", "Gamma")];

function okSet(): { capsuleSet: CapsuleSetDetail } {
  return {
    capsuleSet: {
      id: "set-1" as CapsuleSetDetail["id"],
      displayName: "Combined",
      capsuleIds: [],
      capsuleCount: 0,
      composedAt: 1,
    },
  };
}

function defaultProps(
  overrides: Partial<CapsuleSetComposeDialogProps> = {},
): CapsuleSetComposeDialogProps {
  return {
    capsules: CAPSULES,
    onCancel: vi.fn(),
    onCreated: vi.fn(),
    createImpl: vi.fn().mockResolvedValue(okSet()),
    ...overrides,
  };
}

describe("CapsuleSetComposeDialog — rendering", () => {
  it("lists every capsule as a selectable member", () => {
    render(<CapsuleSetComposeDialog {...defaultProps()} />);
    const list = screen.getByRole("list", { name: /selectable capsules/i });
    expect(within(list).getAllByRole("checkbox")).toHaveLength(3);
  });

  it("shows a live selection counter", async () => {
    const user = userEvent.setup();
    render(<CapsuleSetComposeDialog {...defaultProps()} />);
    await user.click(screen.getByRole("checkbox", { name: /alpha/i }));
    await user.click(screen.getByRole("checkbox", { name: /beta/i }));
    expect(screen.getByText(/2\/16/)).toBeInTheDocument();
  });
});

describe("CapsuleSetComposeDialog — validation", () => {
  it("requires a set name", async () => {
    const user = userEvent.setup();
    const createImpl = vi.fn().mockResolvedValue(okSet());
    render(<CapsuleSetComposeDialog {...defaultProps({ createImpl })} />);
    await user.click(screen.getByRole("checkbox", { name: /alpha/i }));
    await user.click(screen.getByRole("button", { name: /^combine$/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/set name is required/i);
    expect(createImpl).not.toHaveBeenCalled();
  });

  it("requires at least one selected capsule", async () => {
    const user = userEvent.setup();
    const createImpl = vi.fn().mockResolvedValue(okSet());
    render(<CapsuleSetComposeDialog {...defaultProps({ createImpl })} />);
    await user.type(screen.getByLabelText(/set name/i), "My Set");
    await user.click(screen.getByRole("button", { name: /^combine$/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/at least one capsule/i);
    expect(createImpl).not.toHaveBeenCalled();
  });
});

describe("CapsuleSetComposeDialog — submit", () => {
  it("posts the chosen members and reports success", async () => {
    const user = userEvent.setup();
    const createImpl = vi.fn().mockResolvedValue(okSet());
    const onCreated = vi.fn();
    render(<CapsuleSetComposeDialog {...defaultProps({ createImpl, onCreated })} />);

    await user.type(screen.getByLabelText(/set name/i), "Combined");
    await user.click(screen.getByRole("checkbox", { name: /alpha/i }));
    await user.click(screen.getByRole("checkbox", { name: /gamma/i }));
    await user.click(screen.getByRole("button", { name: /^combine$/i }));

    await waitFor(() => {
      expect(createImpl).toHaveBeenCalledWith({
        displayName: "Combined",
        capsuleIds: ["cap-1", "cap-3"],
      });
    });
    expect(onCreated).toHaveBeenCalledOnce();
  });

  it("surfaces a server composition error", async () => {
    const user = userEvent.setup();
    const createImpl = vi
      .fn()
      .mockRejectedValue(new ApiError("INVALID_REQUEST", "incompatible embedding identity", 400));
    const onCreated = vi.fn();
    render(<CapsuleSetComposeDialog {...defaultProps({ createImpl, onCreated })} />);

    await user.type(screen.getByLabelText(/set name/i), "Combined");
    await user.click(screen.getByRole("checkbox", { name: /alpha/i }));
    await user.click(screen.getByRole("button", { name: /^combine$/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/incompatible embedding identity/i);
    });
    expect(onCreated).not.toHaveBeenCalled();
  });
});

describe("CapsuleSetComposeDialog — accessibility", () => {
  it("has no axe violations", async () => {
    const { container } = render(<CapsuleSetComposeDialog {...defaultProps()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
