// Epic #1941 (ADR-0118) — SourceRebindControl gained native-dialog Browse integration (picked/
// busy/unsupported/error outcomes) with no dedicated test coverage. These tests mirror the
// pattern already used for the sibling ConnectSourceForm in capsule-actions.test.tsx.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import { SourceRebindControl } from "./source-rebind-control";
import type { SourceIndexStats } from "@/lib/local-knowledge-api";

// The capability hook and the pick call are mocked; nothing else in the module changes.
vi.mock("@/lib/native-file-dialog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/native-file-dialog")>();
  return {
    ...actual,
    nativeFileDialogSupported: vi.fn(async () => true),
    pickWithNativeDialog: vi.fn(async () => ({ kind: "cancelled" }) as const),
  };
});

import { pickWithNativeDialog } from "@/lib/native-file-dialog";

const mockPickWithNativeDialog = vi.mocked(pickWithNativeDialog);

const CAPSULE_ID = "cap-1" as KnowledgeCapsuleId;

function folderSource(overrides: Partial<SourceIndexStats> = {}): SourceIndexStats {
  return {
    sourceId: "src-1",
    displayName: "Docs",
    scope: { kind: "folder", rootPath: "/repo/docs", recursive: true },
    indexedCount: 10,
    failedCount: 0,
    skippedCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  mockPickWithNativeDialog.mockReset();
  mockPickWithNativeDialog.mockResolvedValue({ kind: "cancelled" });
});

describe("SourceRebindControl", () => {
  it("opens the editor pre-filled with the current root and browses natively", async () => {
    const user = userEvent.setup();
    const rebindImpl = vi.fn().mockResolvedValue({});
    const onRebound = vi.fn();
    mockPickWithNativeDialog.mockResolvedValueOnce({ kind: "picked", paths: ["/repo/new-docs"] });

    render(
      <SourceRebindControl
        capsuleId={CAPSULE_ID}
        source={folderSource()}
        onRebound={onRebound}
        rebindImpl={rebindImpl}
      />,
    );

    await user.click(screen.getByRole("button", { name: /rebind/i }));
    expect(screen.getByLabelText(/replacement folder root/i)).toHaveValue("/repo/docs");

    const browse = screen.getByRole("button", { name: /^browse$/i });
    await waitFor(() => expect(browse).not.toBeDisabled());
    await user.click(browse);

    await waitFor(() =>
      expect(mockPickWithNativeDialog).toHaveBeenCalledWith({
        mode: "open-directory",
        title: "Choose replacement root",
        defaultPath: "/repo/docs",
      }),
    );
    expect(screen.getByLabelText(/replacement folder root/i)).toHaveValue("/repo/new-docs");

    await user.click(screen.getByRole("button", { name: /save root/i }));

    await waitFor(() => {
      expect(rebindImpl).toHaveBeenCalledWith(CAPSULE_ID, "src-1", "/repo/new-docs");
    });
    expect(onRebound).toHaveBeenCalledOnce();
  });

  it("surfaces a calm message when another native dialog is already open and keeps manual entry usable", async () => {
    const user = userEvent.setup();
    mockPickWithNativeDialog.mockResolvedValueOnce({ kind: "busy" });

    render(
      <SourceRebindControl
        capsuleId={CAPSULE_ID}
        source={folderSource()}
        onRebound={vi.fn()}
        rebindImpl={vi.fn().mockResolvedValue({})}
      />,
    );

    await user.click(screen.getByRole("button", { name: /rebind/i }));
    const browse = screen.getByRole("button", { name: /^browse$/i });
    await waitFor(() => expect(browse).not.toBeDisabled());
    await user.click(browse);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A native dialog is already open. Close it first.",
    );
    const manualInput = screen.getByLabelText(/replacement folder root/i);
    await user.clear(manualInput);
    await user.type(manualInput, "/manual/root");
    expect(manualInput).toHaveValue("/manual/root");
  });

  it("surfaces a calm message when the native dialog reports the platform as unsupported", async () => {
    const user = userEvent.setup();
    mockPickWithNativeDialog.mockResolvedValueOnce({ kind: "unsupported" });

    render(
      <SourceRebindControl
        capsuleId={CAPSULE_ID}
        source={folderSource()}
        onRebound={vi.fn()}
        rebindImpl={vi.fn().mockResolvedValue({})}
      />,
    );

    await user.click(screen.getByRole("button", { name: /rebind/i }));
    const browse = screen.getByRole("button", { name: /^browse$/i });
    await waitFor(() => expect(browse).not.toBeDisabled());
    await user.click(browse);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Native dialogs are unavailable on this platform. Enter the path manually.",
    );
  });

  it("surfaces the dialog's own error message when the native pick fails", async () => {
    const user = userEvent.setup();
    mockPickWithNativeDialog.mockResolvedValueOnce({
      kind: "error",
      message: "The native dialog request failed.",
    });

    render(
      <SourceRebindControl
        capsuleId={CAPSULE_ID}
        source={folderSource()}
        onRebound={vi.fn()}
        rebindImpl={vi.fn().mockResolvedValue({})}
      />,
    );

    await user.click(screen.getByRole("button", { name: /rebind/i }));
    const browse = screen.getByRole("button", { name: /^browse$/i });
    await waitFor(() => expect(browse).not.toBeDisabled());
    await user.click(browse);

    expect(await screen.findByRole("alert")).toHaveTextContent("The native dialog request failed.");
  });

  it("shows an error banner and keeps the editor open when rebindImpl rejects", async () => {
    const user = userEvent.setup();
    const rebindImpl = vi.fn().mockRejectedValue(new Error("rebind failed"));
    const onRebound = vi.fn();

    render(
      <SourceRebindControl
        capsuleId={CAPSULE_ID}
        source={folderSource()}
        onRebound={onRebound}
        rebindImpl={rebindImpl}
      />,
    );

    await user.click(screen.getByRole("button", { name: /rebind/i }));
    await user.click(screen.getByRole("button", { name: /save root/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("rebind failed");
    expect(onRebound).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /save root/i })).toBeInTheDocument();
  });

  it("cancels the editor without calling rebindImpl", async () => {
    const user = userEvent.setup();
    const rebindImpl = vi.fn().mockResolvedValue({});

    render(
      <SourceRebindControl
        capsuleId={CAPSULE_ID}
        source={folderSource()}
        onRebound={vi.fn()}
        rebindImpl={rebindImpl}
      />,
    );

    await user.click(screen.getByRole("button", { name: /rebind/i }));
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(rebindImpl).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /rebind/i })).toBeInTheDocument();
  });
});
