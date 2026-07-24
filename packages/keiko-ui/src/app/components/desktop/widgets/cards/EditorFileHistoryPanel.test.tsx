import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EDITOR_LOCAL_HISTORY_ENCRYPTION,
  EDITOR_LOCAL_HISTORY_SCHEMA_VERSION,
  isWorkspaceContentDigest,
  isWorkspaceHistoryEntryRef,
  isWorkspaceIsoInstant,
  isWorkspacePathDigest,
  isWorkspaceRootIdentityDigest,
  isWorkspaceRootRef,
  isWorkspaceVaultEntryRef,
  type EditorLocalHistoryEntry,
} from "@oscharko-dev/keiko-contracts";

import {
  deleteEditorLocalHistory,
  fetchEditorLocalHistory,
  fetchEditorLocalHistoryEntry,
  setEditorLocalHistoryPinned,
} from "../../../../../lib/api";
import { I18nProvider } from "../../../../../lib/i18n";
import {
  buildEditorHistoryDiffModel,
  editorLocalHistorySizeDelta,
  EditorFileHistoryPanel,
  historyVirtualWindow,
} from "./EditorFileHistoryPanel";

vi.mock("../../../../../lib/api", async () => {
  const actual =
    await vi.importActual<typeof import("../../../../../lib/api")>("../../../../../lib/api");
  return {
    ...actual,
    deleteEditorLocalHistory: vi.fn(),
    fetchEditorLocalHistory: vi.fn(),
    fetchEditorLocalHistoryEntry: vi.fn(),
    setEditorLocalHistoryPinned: vi.fn(),
  };
});

const diffProbe: { model: ReturnType<typeof buildEditorHistoryDiffModel> | null } = { model: null };
vi.mock("next/dynamic", () => ({
  default: () =>
    function DiffProbe(props: {
      readonly model: ReturnType<typeof buildEditorHistoryDiffModel>;
    }): ReactElement {
      diffProbe.model = props.model;
      return <div data-testid="history-diff" />;
    },
}));

function checked<Value>(value: string, guard: (input: unknown) => input is Value): Value {
  if (!guard(value)) throw new Error(`Invalid test fixture: ${value}`);
  return value;
}

function entry(
  sequence: number,
  origin: EditorLocalHistoryEntry["origin"] = "user-save",
  pinned = false,
): EditorLocalHistoryEntry {
  const recordedAt = `2026-07-19T12:${String(sequence).padStart(2, "0")}:00.000Z`;
  return {
    kind: "local-history-entry",
    schemaVersion: EDITOR_LOCAL_HISTORY_SCHEMA_VERSION,
    entryRef: checked(`hist_${String(sequence).padStart(16, "0")}`, isWorkspaceHistoryEntryRef),
    workspaceId: "workspace-test",
    rootRef: checked("root_aaaaaaaaaaaaaaaa", isWorkspaceRootRef),
    rootIdentityDigest: checked("a".repeat(64), isWorkspaceRootIdentityDigest),
    relativePath: "src/app.ts",
    relativePathDigest: checked("b".repeat(64), isWorkspacePathDigest),
    predecessor: { outcome: "absent" },
    sequence,
    origin,
    recordedAt: checked(recordedAt, isWorkspaceIsoInstant),
    lastAccessedAt: checked(recordedAt, isWorkspaceIsoInstant),
    plaintextContentDigest: checked("c".repeat(64), isWorkspaceContentDigest),
    plaintextByteLength: sequence * 10,
    payloadBindingDigest: checked("d".repeat(64), isWorkspaceContentDigest),
    encryptedContent: {
      kind: "vault-reference",
      vaultEntryRef: checked(
        `vault_${String(sequence).padStart(16, "0")}`,
        isWorkspaceVaultEntryRef,
      ),
      encryption: EDITOR_LOCAL_HISTORY_ENCRYPTION,
    },
    pinned,
    pinnedAt: pinned
      ? { outcome: "known", value: checked(recordedAt, isWorkspaceIsoInstant) }
      : { outcome: "absent" },
  };
}

function renderPanel(
  overrides: {
    readonly entries?: readonly EditorLocalHistoryEntry[];
    readonly dirty?: boolean;
    readonly onRestore?: (content: string) => Promise<boolean>;
  } = {},
): ReturnType<typeof render> {
  vi.mocked(fetchEditorLocalHistory).mockResolvedValue({
    session: "active",
    entries: overrides.entries ?? [entry(3, "pre-restore", true), entry(2, "agent-apply")],
  });
  return render(
    <I18nProvider>
      <EditorFileHistoryPanel
        root="/repo"
        file="src/app.ts"
        currentContent={"export const value = 3;\n"}
        dirty={overrides.dirty ?? false}
        onClose={vi.fn()}
        onRestore={overrides.onRestore ?? vi.fn(() => Promise.resolve(true))}
      />
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  diffProbe.model = null;
  vi.mocked(deleteEditorLocalHistory).mockResolvedValue({ deleted: true });
  vi.mocked(setEditorLocalHistoryPinned).mockImplementation((_root, _ref, pinned) =>
    Promise.resolve({ entry: entry(3, "pre-restore", pinned) }),
  );
  vi.mocked(fetchEditorLocalHistoryEntry).mockImplementation((_root, entryRef) =>
    Promise.resolve({
      entry: entryRef.endsWith("3") ? entry(3, "pre-restore", true) : entry(2, "agent-apply"),
      content: entryRef.endsWith("3") ? "export const value = 1;\n" : "export const value = 2;\n",
    }),
  );
});

describe("EditorFileHistoryPanel", () => {
  it("renders distinct origin labels, pinned state, and an axe-clean keyboard path", async () => {
    const view = renderPanel();
    expect(
      await screen.findByRole("button", { name: /Restore point 3, Restore,/u }),
    ).toBeInTheDocument();
    expect(screen.getByText("Agent apply")).toBeInTheDocument();
    expect(screen.getByText("Pinned")).toBeInTheDocument();
    expect(screen.queryByText("Timeline")).not.toBeInTheDocument();

    const rows = screen.getAllByRole("button", { name: /Restore point/u });
    rows[0]?.focus();
    fireEvent.keyDown(rows[0]!, { key: "ArrowDown" });
    expect(rows[1]).toHaveFocus();
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it("compares a checkpoint with the live buffer through the existing diff model", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click((await screen.findAllByText("Compare with current"))[0]!);
    expect(await screen.findByTestId("history-diff")).toBeInTheDocument();
    expect(diffProbe.model?.files[0]).toMatchObject({
      original: "export const value = 1;\n",
      modified: "export const value = 3;\n",
      hasChanges: true,
    });
  });

  it("requires confirmation, restores without persisting checkpoint content in browser storage", async () => {
    const user = userEvent.setup();
    const onRestore = vi.fn(() => Promise.resolve(true));
    renderPanel({ onRestore });
    await user.click((await screen.findAllByText("Restore"))[1]!);
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Restore version" }));
    await waitFor(() => expect(onRestore).toHaveBeenCalledWith("export const value = 1;\n"));
    expect(JSON.stringify(window.localStorage)).not.toContain("export const value");
  });

  it("surfaces a dirty-buffer conflict and never reads or restores the checkpoint", async () => {
    const user = userEvent.setup();
    const onRestore = vi.fn(() => Promise.resolve(true));
    renderPanel({ dirty: true, onRestore });
    await user.click((await screen.findAllByText("Restore"))[1]!);
    expect(await screen.findByRole("alert")).toHaveTextContent("Unsaved edits prevent restore");
    expect(fetchEditorLocalHistoryEntry).not.toHaveBeenCalled();
    expect(onRestore).not.toHaveBeenCalled();
  });

  it("confirms deletion and removes the entry without leaving dead actions", async () => {
    const user = userEvent.setup();
    renderPanel({ entries: [entry(3)] });
    await screen.findByText("User save");
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete restore point" }));
    await waitFor(() => expect(deleteEditorLocalHistory).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });
});

describe("EditorFileHistoryPanel failure surfaces", () => {
  it("shows the unpaired-session projection and the load-error retry path", async () => {
    vi.mocked(fetchEditorLocalHistory).mockResolvedValueOnce({ session: "unpaired", entries: [] });
    renderPanel();
    expect(await screen.findByText(/pair|session/iu)).toBeInTheDocument();

    vi.mocked(fetchEditorLocalHistory).mockRejectedValueOnce(new Error("offline"));
    vi.mocked(fetchEditorLocalHistory).mockResolvedValueOnce({
      session: "active",
      entries: [entry(2, "agent-apply")],
    });
    renderPanel();
    const retry = await screen.findByRole("button", { name: /retry|erneut/iu });
    fireEvent.click(retry);
    expect(await screen.findAllByText(/agent/iu)).not.toHaveLength(0);
  });

  it("prunes a checkpoint whose read 404s and notices other read failures", async () => {
    const { ApiError } =
      await vi.importActual<typeof import("../../../../../lib/api")>("../../../../../lib/api");
    vi.mocked(fetchEditorLocalHistoryEntry).mockRejectedValueOnce(
      new ApiError("ENTRY_NOT_FOUND", "gone", 404),
    );
    renderPanel({ entries: [entry(5, "user-save")] });
    const compare = await screen.findByRole("button", { name: /compare with current/iu });
    fireEvent.click(compare);
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /compare with current/iu })).toBeNull();
    });

    vi.mocked(fetchEditorLocalHistoryEntry).mockRejectedValueOnce(new Error("offline"));
    renderPanel({ entries: [entry(6, "user-save")] });
    const failing = await screen.findAllByRole("button", { name: /compare with current/iu });
    fireEvent.click(failing[failing.length - 1] as HTMLElement);
    expect((await screen.findAllByText(/could not be loaded/iu)).length).toBeGreaterThan(0);
  });

  it("reports a failed restore and a failed delete without dropping the entry", async () => {
    renderPanel({
      entries: [entry(7, "user-save")],
      onRestore: vi.fn(() => Promise.resolve(false)),
    });
    fireEvent.click(await screen.findByRole("button", { name: /^restore$/iu }));
    fireEvent.click(await screen.findByRole("button", { name: /restore version/iu }));
    expect((await screen.findAllByText(/version was not restored/iu)).length).toBeGreaterThan(0);

    vi.mocked(deleteEditorLocalHistory).mockRejectedValueOnce(new Error("denied"));
    fireEvent.click(screen.getByRole("button", { name: /^delete$/iu }));
    fireEvent.click(await screen.findByRole("button", { name: /delete restore point/iu }));
    expect((await screen.findAllByText(/could not be deleted/iu)).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /^delete$/iu })).toBeInTheDocument();
  });

  it("surfaces a pin failure as a notice", async () => {
    vi.mocked(setEditorLocalHistoryPinned).mockRejectedValueOnce(new Error("denied"));
    renderPanel({ entries: [entry(8, "user-save")] });
    fireEvent.click(await screen.findByRole("button", { name: /pin restore point/iu }));
    expect(
      (await screen.findAllByText(/pinned state could not be changed/iu)).length,
    ).toBeGreaterThan(0);
  });
});

describe("file-history bounded projections", () => {
  it("virtualizes a long chain with bounded overscan and honest padding", () => {
    const windowed = historyVirtualWindow(50, 148 * 30, 148 * 3);
    expect(windowed).toEqual({ start: 27, end: 36, paddingStart: 3996, paddingEnd: 2072 });
    expect(windowed.end - windowed.start).toBeLessThan(50);
  });

  it("derives each size delta from its predecessor and bounds diff content", () => {
    expect(editorLocalHistorySizeDelta([entry(3), entry(2)], 0)).toBe(10);
    const oversized = "x".repeat(300_000);
    const model = buildEditorHistoryDiffModel("src/app.ts", oversized, "short", "bounded");
    expect(model.truncated).toBe(true);
    expect(model.files[0]?.original.length).toBeLessThan(oversized.length);
  });
});
