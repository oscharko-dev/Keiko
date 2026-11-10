// #4335 — the "Connected …" confirmation belongs to one connect attempt: a later attempt, a failure
// or a removal clears it, and Index now takes focus once per successful connect, never again.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import { CapsuleActions } from "./capsule-actions";
import type { CapsuleActionsProps } from "./capsule-actions";

vi.mock("@/lib/native-file-dialog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/native-file-dialog")>();
  return { ...actual, nativeFileDialogSupported: vi.fn(() => Promise.resolve(false)) };
});

const ID = "cap-confirm" as KnowledgeCapsuleId;
const CONFIRMATION = /next step: index it/i;

function props(overrides: Partial<CapsuleActionsProps> = {}): CapsuleActionsProps {
  return {
    capsuleId: ID,
    capsuleDisplayName: "Pod",
    sourceCount: 0,
    lifecycleState: "draft",
    onActionComplete: vi.fn(),
    ...overrides,
  };
}

async function connectTo(user: ReturnType<typeof userEvent.setup>, path: string): Promise<void> {
  const field = await screen.findByLabelText(/source path/i);
  await user.clear(field);
  await user.type(field, path);
  await user.click(screen.getByRole("button", { name: /^connect$/i }));
}

describe("CapsuleActions connect confirmation (#4335)", () => {
  it("drops the previous confirmation when the next connect fails", async () => {
    const user = userEvent.setup();
    const connect = vi
      .fn()
      .mockResolvedValueOnce({ capsule: {} })
      .mockRejectedValueOnce(new Error("Path is outside the workspace"));
    render(<CapsuleActions {...props({ connectCapsuleSourceImpl: connect })} />);

    await connectTo(user, "/tmp/a");
    // The notice names the bare path, never the "Selected source: …" summary sentence.
    expect(await screen.findByText(CONFIRMATION)).toHaveTextContent(
      /^Connected \/tmp\/a\. Next step: index it/u,
    );

    await connectTo(user, "/tmp/b");
    expect(await screen.findByRole("alert")).toHaveTextContent(/outside the workspace/i);
    expect(screen.queryByText(CONFIRMATION)).toBeNull();
  });

  it("focuses Index now once per connect, not on later source-count changes", async () => {
    const user = userEvent.setup();
    const connect = vi.fn().mockResolvedValue({ capsule: {} });
    const { rerender } = render(
      <CapsuleActions {...props({ connectCapsuleSourceImpl: connect })} />,
    );

    await connectTo(user, "/tmp/a");
    expect(await screen.findByText(CONFIRMATION)).toBeInTheDocument();
    rerender(<CapsuleActions {...props({ connectCapsuleSourceImpl: connect, sourceCount: 1 })} />);
    const index = await screen.findByRole("button", { name: /index this knowledge pod now/i });
    await waitFor(() => expect(index).toHaveFocus());

    // The person moves on; a later change of the source count must not pull focus back.
    screen.getByLabelText(/source path/i).focus();
    rerender(<CapsuleActions {...props({ connectCapsuleSourceImpl: connect, sourceCount: 2 })} />);
    expect(screen.getByLabelText(/source path/i)).toHaveFocus();
  });

  it("clears the confirmation when a source is removed and never refocuses Index", async () => {
    const user = userEvent.setup();
    const connect = vi.fn().mockResolvedValue({ capsule: {} });
    const { rerender } = render(
      <CapsuleActions {...props({ connectCapsuleSourceImpl: connect, sourceCount: 2 })} />,
    );
    await connectTo(user, "/tmp/a");
    expect(await screen.findByText(CONFIRMATION)).toBeInTheDocument();

    screen.getByLabelText(/source path/i).focus();
    rerender(<CapsuleActions {...props({ connectCapsuleSourceImpl: connect, sourceCount: 1 })} />);
    await waitFor(() => expect(screen.queryByText(CONFIRMATION)).toBeNull());
    expect(screen.getByLabelText(/source path/i)).toHaveFocus();
  });
});
