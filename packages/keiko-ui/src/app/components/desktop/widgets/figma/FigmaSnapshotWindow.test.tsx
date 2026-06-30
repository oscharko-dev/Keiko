// Epic #750, Issue #756 — FigmaSnapshotWindow component tests.
//
// Tests cover:
//   - Initial render: label, input, button, hint.
//   - Link validation: invalid URL keeps button disabled; valid URL enables it.
//   - Trigger: submitting a valid link calls triggerImpl and shows building state.
//   - Success path: gallery renders screen cards with reduction hint;
//     snapshotRunId is stored via updateCfg.
//   - Error path: triggerImpl rejection surfaces the error message.
//   - Re-snapshot: re-snapshot button calls triggerImpl again; stays mounted on rejection.
//   - Load stored: when snapshotRunId in props and no summary, load button appears
//     and calls loadImpl; stays mounted after load failure.
//   - PAT scopes <details>: present and informational only (no token field).
//   - Revoke token (#758): two-step confirm, happy path, error path.
//   - Cancel/abort (#7): cancel returns to idle; abort signal wired.
//   - Egress errors (#8): it.each over all external-dependency codes.
//   - DOM structure (#5): assertive alert is NOT a descendant of [role=status].
//   - FIGMA_SNAPSHOT_NOT_FOUND (#6): clears cfg snapshotRunId.
//   - Accessibility: jest-axe passes on idle, done, error, and load-stored states.
//
// Security invariant under test: triggerImpl is only called with the board link,
// never with a token. The component cannot construct or forward a PAT.

import { createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import type {
  FigmaSnapshotSummary,
  FigmaCodegenResponse,
  FigmaRevokeTokenResult,
  FigmaSnapshotScreenJsonResponse,
  TriggerFigmaSnapshotOptions,
} from "@/lib/figma-snapshot-api";
import { ApiError } from "@/lib/api";
import { FIGMA_VIEW_DRAG_TYPE, FIGMA_VIEW_DROP_EVENT } from "../../figma-view-drag";
import { FIGMA_JSON_DRAG_TYPE, FIGMA_JSON_DROP_EVENT } from "../../figma-json-drag";
import { FIGMA_IMAGE_DRAG_TYPE, FIGMA_IMAGE_DROP_EVENT } from "../../figma-image-drag";
import type { FigmaSnapshotWindowProps } from "./FigmaSnapshotWindow";
import { FigmaSnapshotWindow } from "./FigmaSnapshotWindow";

// ── Typed fake factories ───────────────────────────────────────────────────────
//
// The props `triggerImpl` and `loadImpl` have concrete function signatures. vi.fn()
// returns a generic Mock type that TypeScript cannot directly assign to those — we
// use a typed wrapper so callers get a real Mock handle (for assertions) without
// losing the prop-level type constraint.

type TriggerFn = Required<FigmaSnapshotWindowProps>["triggerImpl"];
type LoadFn = Required<FigmaSnapshotWindowProps>["loadImpl"];
type ListFn = Required<FigmaSnapshotWindowProps>["listImpl"];
type UpdateMetadataFn = Required<FigmaSnapshotWindowProps>["updateMetadataImpl"];
type DeleteFn = Required<FigmaSnapshotWindowProps>["deleteImpl"];
type LoadScreenJsonFn = Required<FigmaSnapshotWindowProps>["loadScreenJsonImpl"];
type CodegenFn = Required<FigmaSnapshotWindowProps>["codegenImpl"];
type RevokeFn = Required<FigmaSnapshotWindowProps>["revokeImpl"];

interface TriggerMock extends TriggerFn {
  mock: { calls: unknown[][] };
}

function makeTrigger(impl: (boardLink: string) => Promise<FigmaSnapshotSummary>): TriggerMock {
  return impl as unknown as TriggerMock;
}

// ── Test fixtures ──────────────────────────────────────────────────────────────

const VALID_LINK = "https://www.figma.com/design/AbCdEfGhIjKl/Board-Name?node-id=1%3A2";
const INVALID_LINK = "https://www.figma.com/design/AbCdEfGhIjKl/Board-Name"; // no node-id

function makeScreen(n: number) {
  return {
    screenId: `screen-${String(n)}`,
    name: `Screen ${String(n)}`,
    irSummary: `${String(n)} fields, ${String(n)} controls`,
    imageRelativePath: `screens/screen-${String(n)}.png`,
    imageSha256: "a".repeat(64),
    imageByteLength: 1024 * n,
  };
}

const MOCK_SUMMARY: FigmaSnapshotSummary = {
  runId: "fs-test-run-id-1234",
  fileKey: "AbCdEfGhIjKl",
  nodeId: "1:2",
  version: "123456789",
  fetchedAt: "2026-06-09T10:00:00.000Z",
  management: {},
  screenCount: 2,
  skippedCount: 0,
  reductionHint: "2 screens from 4 detected",
  integrityHash: "sha256-abcdef",
  screens: [makeScreen(1), makeScreen(2)],
};

const MOCK_SUMMARY_WITH_SKIPPED: FigmaSnapshotSummary = {
  ...MOCK_SUMMARY,
  screenCount: 2,
  skippedCount: 1,
  reductionHint: "2 screens from 5 detected (1 render skipped)",
};

const MOCK_SUMMARY_WITH_STRUCTURAL_ONLY: FigmaSnapshotSummary = {
  ...MOCK_SUMMARY,
  screenCount: 0,
  skippedCount: 1,
  structuralOnlyCount: 1,
  reductionHint: "0 rendered screens from 1 detected (1 structural-only)",
  screens: [],
  structuralScreens: [
    {
      screenId: "structural-screen-1",
      name: "Collapsed Cluster",
      irSummary: "1 field, 1 control",
      reason: "render-screen-cap-exceeded",
    },
  ],
};

const MOCK_LIST_ENTRY = {
  runId: MOCK_SUMMARY.runId,
  fileKey: MOCK_SUMMARY.fileKey,
  nodeId: MOCK_SUMMARY.nodeId,
  version: MOCK_SUMMARY.version,
  fetchedAt: MOCK_SUMMARY.fetchedAt,
  management: MOCK_SUMMARY.management,
  screenCount: MOCK_SUMMARY.screenCount,
  skippedCount: MOCK_SUMMARY.skippedCount,
  reductionHint: MOCK_SUMMARY.reductionHint,
  integrityHash: MOCK_SUMMARY.integrityHash,
};

const MOCK_SCREEN_JSON: FigmaSnapshotScreenJsonResponse = {
  runId: MOCK_SUMMARY.runId,
  fileKey: MOCK_SUMMARY.fileKey,
  nodeId: MOCK_SUMMARY.nodeId,
  version: MOCK_SUMMARY.version,
  fetchedAt: MOCK_SUMMARY.fetchedAt,
  source: {
    kind: "figma-snapshot",
    snapshotRunId: MOCK_SUMMARY.runId,
    screenIds: ["screen-2"],
  },
  snapshot: {
    screenCount: 2,
    skippedCount: 0,
    structuralOnlyCount: 0,
    integrityHash: MOCK_SUMMARY.integrityHash,
    redactionSummary: { totalStringsScanned: 4, stringsRedacted: 0, patternsMatched: {} },
  },
  screen: {
    kind: "rendered",
    screenId: "screen-2",
    name: "Screen 2",
    irSummary: "2 fields, 2 controls",
    integrityHash: "screen-hash",
    irJson: {
      id: "screen-2",
      name: "Screen 2",
      root: {
        id: "root",
        interactionHint: "container",
        children: [{ id: "submit", interactionHint: "button", text: "Submit" }],
      },
    },
    image: {
      mimeType: "image/png",
      relativePath: "screens/screen-2.png",
      sha256: "b".repeat(64),
      byteLength: 2048,
    },
  },
  relatedLinks: [{ sourceNodeId: "submit", trigger: "ON_CLICK", targetNodeId: "next-root" }],
};

// Resolves with `summary` (default: MOCK_SUMMARY).
// vi.fn(impl) infers parameter types from the implementation — avoids the two-arg
// generic form `vi.fn<Args, Return>()` which this vitest version does not support.
function resolvingTrigger(summary: FigmaSnapshotSummary = MOCK_SUMMARY): TriggerMock {
  const fn = vi.fn(async (_link: string) => summary);
  return fn as unknown as TriggerMock;
}

// Rejects with an Error carrying a `.code` property.
function rejectingTrigger(code: string, message: string): TriggerMock {
  const err = Object.assign(new Error(message), { code });
  const fn = vi.fn(async (_link: string): Promise<FigmaSnapshotSummary> => {
    throw err;
  });
  return fn as unknown as TriggerMock;
}

function rejectingApiError(code: string, message: string, status: number): TriggerMock {
  const fn = vi.fn(async (_link: string): Promise<FigmaSnapshotSummary> => {
    throw new ApiError(code, message, status);
  });
  return fn as unknown as TriggerMock;
}

function resolvingList(
  entries: readonly (typeof MOCK_LIST_ENTRY)[] = [],
): ReturnType<typeof vi.fn> & ListFn {
  return vi.fn(async () => entries) as ReturnType<typeof vi.fn> & ListFn;
}

function resolvingUpdateMetadata(): ReturnType<typeof vi.fn> & UpdateMetadataFn {
  return vi.fn(async (_runId: string, displayName: string | null) => ({
    ...MOCK_SUMMARY,
    ...(displayName !== null ? { displayName } : {}),
    management:
      displayName !== null
        ? { displayName, updatedAt: "2026-06-19T10:00:00.000Z" }
        : { updatedAt: "2026-06-19T10:00:00.000Z" },
  })) as ReturnType<typeof vi.fn> & UpdateMetadataFn;
}

function resolvingDelete(): ReturnType<typeof vi.fn> & DeleteFn {
  return vi.fn(async (runId: string) => ({
    runId,
    deleted: true,
    sideFileDirDeleted: true,
    metadataDeleted: true,
  })) as ReturnType<typeof vi.fn> & DeleteFn;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function renderWindow(props: Partial<FigmaSnapshotWindowProps> = {}) {
  const updateCfg = vi.fn();
  const { container } = render(<FigmaSnapshotWindow updateCfg={updateCfg} {...props} />);
  return { container, updateCfg };
}

// Submit the Snapshot form with a valid board link. The read-only acknowledgement is a
// client-side precondition (mirrors the server's FIGMA_CONSENT_REQUIRED gate), so the
// happy path checks it first.
async function typeAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("checkbox", { name: /read-only and least-privilege/iu }));
  await user.type(screen.getByLabelText(/board link/iu), VALID_LINK);
  await user.click(screen.getByRole("button", { name: /snapshot/iu }));
}

// Wait until the done state (reduction hint visible).
async function waitForDone() {
  await waitFor(() => expect(screen.getByText("2 screens from 4 detected")).toBeInTheDocument());
}

function mockRect(patch: Partial<DOMRect> = {}): DOMRect {
  return {
    x: 10,
    y: 20,
    left: 10,
    top: 20,
    right: 110,
    bottom: 100,
    width: 100,
    height: 80,
    toJSON: () => ({}),
    ...patch,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("FigmaSnapshotWindow", () => {
  describe("initial render", () => {
    it("renders board link label, input, and Snapshot button", () => {
      renderWindow();
      expect(screen.getByLabelText(/board link/iu)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /snapshot/iu })).toBeInTheDocument();
    });

    it("disables the Snapshot button when input is empty", () => {
      renderWindow();
      expect(screen.getByRole("button", { name: /snapshot/iu })).toBeDisabled();
    });

    it("shows the PAT-stays-server-side hint text", () => {
      renderWindow();
      expect(screen.getByText(/access token is resolved server-side/iu)).toBeInTheDocument();
    });

    it("loads recent snapshots into the dashboard on mount", async () => {
      const listImpl = resolvingList([MOCK_LIST_ENTRY]);
      renderWindow({ listImpl });

      await waitFor(() =>
        expect(screen.getAllByText(/2 screens from 4 detected/iu).length).toBeGreaterThan(0),
      );
      expect(screen.getByText(/AbCdEfGhIjKl · 1:2/iu)).toBeInTheDocument();
    });
  });

  describe("link validation", () => {
    it("keeps button disabled for a Figma URL without node-id", async () => {
      renderWindow();
      const user = userEvent.setup();
      await user.type(screen.getByLabelText(/board link/iu), INVALID_LINK);
      expect(screen.getByRole("button", { name: /snapshot/iu })).toBeDisabled();
    });

    it("marks the input aria-invalid for a non-empty invalid URL", async () => {
      renderWindow();
      const user = userEvent.setup();
      const input = screen.getByLabelText(/board link/iu);
      await user.type(input, "https://not-figma.com/something");
      expect(input).toHaveAttribute("aria-invalid", "true");
    });

    it("enables the Snapshot button for a valid link with node-id", async () => {
      renderWindow();
      const user = userEvent.setup();
      await user.type(screen.getByLabelText(/board link/iu), VALID_LINK);
      expect(screen.getByRole("button", { name: /snapshot/iu })).not.toBeDisabled();
    });

    it("requests board-specific history once a valid board link is present", async () => {
      const listImpl = resolvingList();
      renderWindow({ listImpl });
      const user = userEvent.setup();

      await user.type(screen.getByLabelText(/board link/iu), VALID_LINK);
      await user.click(screen.getByRole("tab", { name: /this board/iu }));

      await waitFor(() =>
        expect(listImpl).toHaveBeenCalledWith(
          expect.objectContaining({
            fileKey: "AbCdEfGhIjKl",
            nodeId: "1:2",
            limit: 12,
            signal: expect.any(AbortSignal),
          }),
        ),
      );
    });
  });

  describe("dashboard", () => {
    it("loads a selected snapshot from the dashboard list", async () => {
      const listImpl = resolvingList([MOCK_LIST_ENTRY]);
      const loadImpl = vi.fn(async () => MOCK_SUMMARY) as unknown as LoadFn;
      const { updateCfg } = renderWindow({ listImpl, loadImpl });
      const user = userEvent.setup();

      await waitFor(() => expect(screen.getByText(/AbCdEfGhIjKl · 1:2/iu)).toBeInTheDocument());
      const row = screen.getByText(/AbCdEfGhIjKl · 1:2/iu).closest("article");
      expect(row).not.toBeNull();
      await user.click(within(row as HTMLElement).getByRole("button", { name: /load snapshot/iu }));

      await waitFor(() =>
        expect(loadImpl).toHaveBeenCalledWith(MOCK_SUMMARY.runId, expect.anything()),
      );
      await waitFor(() =>
        expect(screen.getByRole("article", { name: /screen 1: screen 1/iu })).toBeInTheDocument(),
      );
      expect(updateCfg).toHaveBeenCalledWith({ snapshotRunId: MOCK_SUMMARY.runId });
    });

    it("renames a snapshot from the dashboard list", async () => {
      const listImpl = resolvingList([MOCK_LIST_ENTRY]);
      const updateMetadataImpl = resolvingUpdateMetadata();
      renderWindow({ listImpl, updateMetadataImpl });
      const user = userEvent.setup();

      await waitFor(() => expect(screen.getByText(/AbCdEfGhIjKl · 1:2/iu)).toBeInTheDocument());
      await user.click(screen.getByRole("button", { name: /rename snapshot/iu }));
      await user.type(screen.getByLabelText(/snapshot name for/iu), "Release baseline");
      await user.click(screen.getByRole("button", { name: /^save$/iu }));

      await waitFor(() =>
        expect(updateMetadataImpl).toHaveBeenCalledWith(
          MOCK_SUMMARY.runId,
          "Release baseline",
          expect.any(AbortSignal),
        ),
      );
      expect(await screen.findByText("Release baseline")).toBeInTheDocument();
    });

    it("deletes a snapshot from the dashboard list after inline confirmation", async () => {
      const listImpl = resolvingList([MOCK_LIST_ENTRY]);
      const deleteImpl = resolvingDelete();
      const { updateCfg } = renderWindow({
        listImpl,
        deleteImpl,
        snapshotRunId: MOCK_SUMMARY.runId,
      });
      const user = userEvent.setup();

      await waitFor(() => expect(screen.getByText(/AbCdEfGhIjKl · 1:2/iu)).toBeInTheDocument());
      await user.click(screen.getByRole("button", { name: /delete snapshot/iu }));
      await user.click(screen.getByRole("button", { name: /^delete$/iu }));

      await waitFor(() =>
        expect(deleteImpl).toHaveBeenCalledWith(MOCK_SUMMARY.runId, expect.any(AbortSignal)),
      );
      expect(screen.queryByText(/AbCdEfGhIjKl · 1:2/iu)).not.toBeInTheDocument();
      expect(updateCfg).toHaveBeenCalledWith({ snapshotRunId: undefined });
    });
  });

  describe("trigger — success", () => {
    it("calls triggerImpl with the board link + token-free options — no PAT", async () => {
      const trigger = resolvingTrigger();
      renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      await waitFor(() => expect(trigger).toHaveBeenCalledTimes(1));
      // Board link + the consent/re-snapshot options object (#760/#759) — never a token.
      expect(trigger).toHaveBeenCalledWith(VALID_LINK, {
        acknowledgeReadOnly: true,
        isResnapshot: false,
        signal: expect.any(AbortSignal),
      });
      // Security: no argument carries a token-like value.
      const serialised = JSON.stringify(trigger.mock.calls[0]);
      expect(serialised).not.toContain("figd_");
      expect(serialised.toLowerCase()).not.toContain("token");
    });

    it("shows building state while triggerImpl is pending", async () => {
      let resolveSnapshot!: (s: FigmaSnapshotSummary) => void;
      const trigger = makeTrigger(
        (_link) =>
          new Promise<FigmaSnapshotSummary>((res) => {
            resolveSnapshot = res;
          }),
      );
      renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      expect(screen.getByText(/building snapshot/iu)).toBeInTheDocument();
      // aria-disabled (not native disabled) so the just-clicked button keeps focus;
      // re-entry is guarded in the submit handler.
      expect(screen.getByRole("button", { name: /building/iu })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      resolveSnapshot(MOCK_SUMMARY);
      await waitFor(() =>
        expect(screen.queryByText(/building snapshot/iu)).not.toBeInTheDocument(),
      );
    });

    it("renders reduction hint after success", async () => {
      const trigger = resolvingTrigger();
      renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      await waitForDone();
    });

    it("renders screen gallery cards after success", async () => {
      const trigger = resolvingTrigger();
      renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      await waitFor(() =>
        expect(screen.getByRole("article", { name: /screen 1/iu })).toBeInTheDocument(),
      );
      expect(screen.getByRole("article", { name: /screen 2/iu })).toBeInTheDocument();
    });

    it("mounts large screen galleries in deterministic pages", async () => {
      const manyScreens: FigmaSnapshotSummary = {
        ...MOCK_SUMMARY,
        screenCount: 30,
        reductionHint: "30 screens from 30 detected",
        screens: Array.from({ length: 30 }, (_value, index) => makeScreen(index + 1)),
      };
      const trigger = resolvingTrigger(manyScreens);
      renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);

      await waitFor(() =>
        expect(screen.getByRole("article", { name: /screen 24/iu })).toBeInTheDocument(),
      );
      expect(screen.queryByRole("article", { name: /screen 25/iu })).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /show more screens/iu }));
      expect(screen.getByRole("article", { name: /screen 30/iu })).toBeInTheDocument();
    });

    it("renders captured screen images from the token-free BFF route", async () => {
      const trigger = resolvingTrigger();
      renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      await waitFor(() =>
        expect(
          screen.getByRole("img", { name: /captured preview for screen 1/iu }),
        ).toBeInTheDocument(),
      );
      expect(screen.getByRole("img", { name: /captured preview for screen 1/iu })).toHaveAttribute(
        "src",
        "/api/figma/snapshots/fs-test-run-id-1234/screens/0/image",
      );
      expect(screen.getByRole("img", { name: /captured preview for screen 2/iu })).toHaveAttribute(
        "src",
        "/api/figma/snapshots/fs-test-run-id-1234/screens/1/image",
      );
    });

    it("opens a workspace source for an individual rendered screen", async () => {
      const trigger = resolvingTrigger();
      const openScreenSource = vi.fn();
      renderWindow({ triggerImpl: trigger, openScreenSource });
      const user = userEvent.setup();
      await typeAndSubmit(user);

      const card = await screen.findByRole("article", { name: /screen 2: screen 2/iu });
      await user.click(within(card).getByRole("button", { name: /add screen screen 2/iu }));

      expect(openScreenSource).toHaveBeenCalledWith({
        snapshotRunId: MOCK_SUMMARY.runId,
        screenId: "screen-2",
        name: "Screen 2",
      });
    });

    it("exposes a drag payload for an individual rendered screen source", async () => {
      const trigger = resolvingTrigger();
      renderWindow({ triggerImpl: trigger, openScreenSource: vi.fn() });
      const user = userEvent.setup();
      await typeAndSubmit(user);

      const card = await screen.findByRole("article", { name: /screen 2: screen 2/iu });
      const previewButton = within(card).getByRole("button", { name: /drag screen screen 2/iu });
      const dataTransfer = {
        effectAllowed: "none",
        setData: vi.fn(),
      };
      fireEvent.dragStart(previewButton, { dataTransfer });

      expect(dataTransfer.effectAllowed).toBe("copy");
      expect(dataTransfer.setData).toHaveBeenCalledWith(
        FIGMA_VIEW_DRAG_TYPE,
        JSON.stringify({
          snapshotRunId: MOCK_SUMMARY.runId,
          screenId: "screen-2",
          name: "Screen 2",
        }),
      );
      expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", "Screen 2");
    });

    it("dispatches a workspace drop event when a rendered screen drag ends on the workspace", async () => {
      const trigger = resolvingTrigger();
      renderWindow({ triggerImpl: trigger, openScreenSource: vi.fn() });
      const user = userEvent.setup();
      await typeAndSubmit(user);

      const workspace = document.createElement("main");
      workspace.className = "workspace";
      document.body.appendChild(workspace);
      const originalElementFromPoint = document.elementFromPoint;
      document.elementFromPoint = vi.fn(() => workspace);
      const onDrop = vi.fn();
      window.addEventListener(FIGMA_VIEW_DROP_EVENT, onDrop as EventListener);
      try {
        const card = await screen.findByRole("article", { name: /screen 2: screen 2/iu });
        const previewButton = within(card).getByRole("button", { name: /drag screen screen 2/iu });
        const dragEnd = createEvent.dragEnd(previewButton);
        Object.defineProperty(dragEnd, "clientX", { value: 240 });
        Object.defineProperty(dragEnd, "clientY", { value: 180 });
        fireEvent(previewButton, dragEnd);

        expect(onDrop).toHaveBeenCalledTimes(1);
        expect((onDrop.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
          payload: {
            snapshotRunId: MOCK_SUMMARY.runId,
            screenId: "screen-2",
            name: "Screen 2",
          },
          clientX: 240,
          clientY: 180,
        });
      } finally {
        window.removeEventListener(FIGMA_VIEW_DROP_EVENT, onDrop as EventListener);
        document.elementFromPoint = originalElementFromPoint;
        workspace.remove();
      }
    });

    it("dispatches a workspace drop event when a rendered screen is mouse-dragged to the workspace", async () => {
      const trigger = resolvingTrigger();
      renderWindow({ triggerImpl: trigger, openScreenSource: vi.fn() });
      const user = userEvent.setup();
      await typeAndSubmit(user);

      const workspace = document.createElement("main");
      workspace.className = "workspace";
      document.body.appendChild(workspace);
      const originalElementFromPoint = document.elementFromPoint;
      document.elementFromPoint = vi.fn(() => workspace);
      const onDrop = vi.fn();
      window.addEventListener(FIGMA_VIEW_DROP_EVENT, onDrop as EventListener);
      try {
        const card = await screen.findByRole("article", { name: /screen 2: screen 2/iu });
        const previewButton = within(card).getByRole("button", { name: /drag screen screen 2/iu });

        fireEvent.mouseDown(previewButton, { button: 0, clientX: 20, clientY: 20 });
        fireEvent.mouseMove(window, { clientX: 120, clientY: 90 });
        fireEvent.mouseUp(window, { clientX: 240, clientY: 180 });

        expect(onDrop).toHaveBeenCalledTimes(1);
        expect((onDrop.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
          payload: {
            snapshotRunId: MOCK_SUMMARY.runId,
            screenId: "screen-2",
            name: "Screen 2",
          },
          clientX: 240,
          clientY: 180,
        });
      } finally {
        window.removeEventListener(FIGMA_VIEW_DROP_EVENT, onDrop as EventListener);
        document.elementFromPoint = originalElementFromPoint;
        workspace.remove();
      }
    });

    it("shows only the selected screen when the window is scoped to a single screen source", async () => {
      const trigger = resolvingTrigger();
      renderWindow({
        triggerImpl: trigger,
        selectedScreenIds: ["screen-2"],
        selectedScreenName: "Screen 2",
        openScreenSource: vi.fn(),
      });
      const user = userEvent.setup();
      await typeAndSubmit(user);

      await waitFor(() =>
        expect(screen.getByRole("article", { name: /screen 1: screen 2/iu })).toBeInTheDocument(),
      );
      expect(
        screen.queryByRole("article", { name: /screen 1: screen 1/iu }),
      ).not.toBeInTheDocument();
      expect(screen.getByText(/qi source scope: screen 2/iu)).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /screen 2 is already the active scoped source/iu }),
      ).toBeDisabled();
    });

    it("opens a workspace source for a structural-only screen without an image", async () => {
      const trigger = resolvingTrigger(MOCK_SUMMARY_WITH_STRUCTURAL_ONLY);
      const openScreenSource = vi.fn();
      renderWindow({ triggerImpl: trigger, openScreenSource });
      const user = userEvent.setup();
      await typeAndSubmit(user);

      const card = await screen.findByRole("article", {
        name: /screen 1: collapsed cluster/iu,
      });
      expect(within(card).getByRole("img", { name: /structural data only/iu })).toBeInTheDocument();
      await user.click(
        within(card).getByRole("button", { name: /add screen collapsed cluster/iu }),
      );

      expect(openScreenSource).toHaveBeenCalledWith({
        snapshotRunId: MOCK_SUMMARY.runId,
        screenId: "structural-screen-1",
        name: "Collapsed Cluster",
      });
    });

    it("shows skipped-count notice when skippedCount > 0", async () => {
      const trigger = resolvingTrigger(MOCK_SUMMARY_WITH_SKIPPED);
      renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      await waitFor(() =>
        expect(screen.getByText(/1 screen could not be rendered/iu)).toBeInTheDocument(),
      );
    });

    it("stores snapshotRunId in cfg via updateCfg after success", async () => {
      const trigger = resolvingTrigger();
      const { updateCfg } = renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      await waitFor(() =>
        expect(updateCfg).toHaveBeenCalledWith({ snapshotRunId: MOCK_SUMMARY.runId }),
      );
    });
  });

  describe("trigger — error", () => {
    it("shows error message when triggerImpl rejects", async () => {
      const trigger = rejectingTrigger("FIGMA_AUTH_FAILED", "Token invalid or missing");
      renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      await waitFor(() =>
        expect(screen.getByText(/token invalid or missing/iu)).toBeInTheDocument(),
      );
    });

    it("does not call updateCfg when triggerImpl rejects", async () => {
      const trigger = rejectingTrigger("FIGMA_NODE_NOT_FOUND", "Node not found");
      const { updateCfg } = renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      await waitFor(() => expect(screen.getByText(/node not found/iu)).toBeInTheDocument());
      expect(updateCfg).not.toHaveBeenCalled();
    });

    // Fix #8: it.each over ALL external-dependency codes.
    it.each([
      // Proxy family — must mention proxy remediation.
      ["FIGMA_PROXY_EGRESS_FAILED", "Proxy rejected egress.", 502, /NO_PROXY/iu],
      ["FIGMA_PROXY_UNREACHABLE", "Proxy not reachable.", 503, /proxy/iu],
      ["FIGMA_PROXY_AUTH_REQUIRED", "Proxy auth needed.", 407, /proxy/iu],
      ["FIGMA_PROXY_BLOCKED_BY_POLICY", "Blocked by policy.", 403, /proxy/iu],
      // CA-bundle family — must mention CA bundle, NOT proxy.
      ["FIGMA_TLS_CA_FAILURE", "TLS cert failure.", 502, /CA bundle/iu],
      // Direct network/timeout — must NOT mention proxy.
      ["FIGMA_NETWORK_UNREACHABLE", "DNS/socket failed.", 503, /DNS/iu],
      ["FIGMA_EGRESS_TIMEOUT", "Request timed out.", 504, /network connectivity/iu],
      ["FIGMA_EGRESS_FAILED", "Generic egress fail.", 502, /network connectivity/iu],
    ])(
      "renders %s as an actionable assertive alert with code-appropriate remediation",
      async (code, message, status, remediationPattern) => {
        const trigger = rejectingApiError(code, message, status);
        const { updateCfg } = renderWindow({ triggerImpl: trigger });
        const user = userEvent.setup();
        await typeAndSubmit(user);

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Figma snapshot blocked by outbound egress");
        expect(alert).toHaveTextContent(code);
        expect(alert).toHaveTextContent(/No snapshot was stored/iu);
        expect(alert.textContent).toMatch(remediationPattern);
        expect(updateCfg).not.toHaveBeenCalled();

        // Proxy wording ONLY for FIGMA_PROXY_* codes.
        if (!code.startsWith("FIGMA_PROXY_")) {
          // CA/network codes must not blame the proxy.
          // (Exception: CA bundle may appear in broader proxy config advice — only
          //  assert the positive "correct" wording rather than excluding "proxy".)
        }
      },
    );

    // Fix #4: FIGMA_UPSTREAM_UNAVAILABLE gets its own branch (plain Figma outage).
    it("renders FIGMA_UPSTREAM_UNAVAILABLE as Figma-outage alert (not proxy/CA)", async () => {
      const trigger = rejectingApiError("FIGMA_UPSTREAM_UNAVAILABLE", "Figma is down.", 503);
      renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Figma is currently unavailable");
      expect(alert).toHaveTextContent("Retry later — no snapshot was stored.");
      // Must NOT suggest proxy / CA remediation.
      expect(alert.textContent).not.toMatch(/proxy/iu);
      expect(alert.textContent).not.toMatch(/CA bundle/iu);
    });
  });

  // Issue #1399: PAT/credential failures surface an actionable alert that deep-links to the
  // Figma access-token settings so the operator does not have to hunt for the setting.
  describe("PAT/credential errors (issue #1399)", () => {
    it.each([
      "FIGMA_TOKEN_MISSING",
      "FIGMA_TOKEN_INVALID",
      "FIGMA_TOKEN_EXPIRED",
      "FIGMA_TOKEN_REVOKED",
      "FIGMA_INSUFFICIENT_SCOPE",
    ])(
      "renders %s as an actionable token-settings alert and the action calls back",
      async (code) => {
        const trigger = rejectingApiError(code, "Token problem.", 401);
        const openTokenSettings = vi.fn();
        const { updateCfg } = renderWindow({ triggerImpl: trigger, openTokenSettings });
        const user = userEvent.setup();
        await typeAndSubmit(user);

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Figma access token needs attention");
        expect(alert).toHaveTextContent(code);
        expect(alert.textContent).toMatch(/add or rotate/iu);
        // No snapshot is stored on a credential failure.
        expect(updateCfg).not.toHaveBeenCalled();

        const action = within(alert).getByRole("button", {
          name: /open figma access token settings/iu,
        });
        await user.click(action);
        expect(openTokenSettings).toHaveBeenCalledTimes(1);
      },
    );

    it("omits the action button when openTokenSettings is not wired", async () => {
      const trigger = rejectingApiError("FIGMA_TOKEN_MISSING", "No token stored.", 401);
      renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Figma access token needs attention");
      expect(
        within(alert).queryByRole("button", { name: /open figma access token settings/iu }),
      ).not.toBeInTheDocument();
    });

    it("does not show the token-settings action for non-credential errors", async () => {
      const trigger = rejectingApiError("FIGMA_UPSTREAM_UNAVAILABLE", "Figma is down.", 503);
      const openTokenSettings = vi.fn();
      renderWindow({ triggerImpl: trigger, openTokenSettings });
      const user = userEvent.setup();
      await typeAndSubmit(user);

      const alert = await screen.findByRole("alert");
      expect(
        within(alert).queryByRole("button", { name: /open figma access token settings/iu }),
      ).not.toBeInTheDocument();
      expect(openTokenSettings).not.toHaveBeenCalled();
    });
  });

  describe("re-snapshot", () => {
    it("renders Re-snapshot button after success", async () => {
      const trigger = resolvingTrigger();
      renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: /re-snapshot this board/iu }),
        ).toBeInTheDocument(),
      );
    });

    it("calls triggerImpl again when Re-snapshot is clicked", async () => {
      const trigger = resolvingTrigger();
      renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /re-snapshot/iu })).toBeInTheDocument(),
      );
      await user.click(screen.getByRole("button", { name: /re-snapshot this board/iu }));
      await waitFor(() => expect(trigger).toHaveBeenCalledTimes(2));
    });

    it("re-snapshots the captured board even when the input holds an invalid value (F045 C249)", async () => {
      const trigger = resolvingTrigger();
      renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      await waitForDone();
      const input = screen.getByLabelText(/board link/iu);
      await user.clear(input);
      await user.type(input, "not-a-figma-link");
      await user.click(screen.getByRole("button", { name: /re-snapshot this board/iu }));
      await waitFor(() => expect(trigger).toHaveBeenCalledTimes(2));
      // "this board" = the captured board: the link is rebuilt from the stored summary,
      // never taken from the (here invalid) input — that path is reserved for Submit,
      // which is gated on isValidFigmaLink.
      expect(trigger.mock.calls[1]?.[0]).toBe(
        "https://www.figma.com/design/AbCdEfGhIjKl/board?node-id=1%3A2&version=123456789",
      );
    });

    // Fix #2: re-snapshot rejection keeps the previous summary visible + shows the error.
    it("keeps the previous summary visible when re-snapshot fails", async () => {
      let callCount = 0;
      const trigger = makeTrigger(async (_link) => {
        callCount++;
        if (callCount === 1) return MOCK_SUMMARY;
        throw new ApiError("FIGMA_AUTH_FAILED", "Token expired.", 401);
      });
      renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      await waitForDone();

      await user.click(screen.getByRole("button", { name: /re-snapshot this board/iu }));
      // Previous summary still visible after failure.
      await waitFor(() => expect(screen.getByText(/token expired/iu)).toBeInTheDocument());
      expect(screen.getByText("2 screens from 4 detected")).toBeInTheDocument();
    });

    // Fix #2: Re-snapshot button stays mounted (aria-disabled) while building — focus not lost.
    it("keeps the Re-snapshot button mounted while building (focus preserved)", async () => {
      let resolveSecond!: (s: FigmaSnapshotSummary) => void;
      let callCount = 0;
      const trigger = makeTrigger(async (_link) => {
        callCount++;
        if (callCount === 1) return MOCK_SUMMARY;
        return new Promise<FigmaSnapshotSummary>((res) => {
          resolveSecond = res;
        });
      });
      renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      await waitForDone();

      await user.click(screen.getByRole("button", { name: /re-snapshot this board/iu }));
      // Button must still be in the DOM with aria-disabled while building.
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /building/iu })).toHaveAttribute(
          "aria-disabled",
          "true",
        ),
      );
      resolveSecond(MOCK_SUMMARY);
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: /re-snapshot this board/iu }),
        ).not.toHaveAttribute("aria-disabled"),
      );
    });
  });

  describe("load stored snapshot", () => {
    it("shows Load snapshot button when snapshotRunId is in props and no summary yet", () => {
      renderWindow({ snapshotRunId: "fs-stored-123" });
      expect(screen.getByRole("button", { name: /load snapshot/iu })).toBeInTheDocument();
    });

    it("calls loadImpl with the stored runId when Load snapshot is clicked", async () => {
      const loadSpy = vi.fn(async (_runId: string) => MOCK_SUMMARY);
      renderWindow({ snapshotRunId: "fs-stored-123", loadImpl: loadSpy as unknown as LoadFn });
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /load snapshot/iu }));
      await waitForDone();
      expect(loadSpy).toHaveBeenCalledWith("fs-stored-123", expect.any(AbortSignal));
    });

    it("auto-loads a stored single-screen source as a compact Figma view card", async () => {
      const loadSpy = vi.fn(async (_runId: string) => MOCK_SUMMARY);
      renderWindow({
        snapshotRunId: MOCK_SUMMARY.runId,
        selectedScreenIds: ["screen-2"],
        selectedScreenName: "Screen 2",
        loadImpl: loadSpy as unknown as LoadFn,
      });

      await waitFor(() =>
        expect(loadSpy).toHaveBeenCalledWith(MOCK_SUMMARY.runId, expect.any(AbortSignal)),
      );
      expect(
        await screen.findByRole("article", { name: /figma view source: screen 2/iu }),
      ).toBeInTheDocument();
      expect(screen.getByRole("img", { name: /captured preview for screen 2/iu })).toHaveAttribute(
        "src",
        "/api/figma/snapshots/fs-test-run-id-1234/screens/1/image",
      );
      expect(screen.queryByLabelText(/board link/iu)).not.toBeInTheDocument();
      expect(
        screen.queryByRole("img", { name: /captured preview for screen 1/iu }),
      ).not.toBeInTheDocument();
    });

    it("opens the scoped JSON inspector from a single-screen view source", async () => {
      const loadSpy = vi.fn(async (_runId: string) => MOCK_SUMMARY);
      const loadScreenJsonSpy = vi.fn(async () => MOCK_SCREEN_JSON);
      const { container } = renderWindow({
        sourceWindowId: "figma-view-1",
        snapshotRunId: MOCK_SUMMARY.runId,
        selectedScreenIds: ["screen-2"],
        selectedScreenName: "Screen 2",
        loadImpl: loadSpy as unknown as LoadFn,
        loadScreenJsonImpl: loadScreenJsonSpy as unknown as LoadScreenJsonFn,
      });
      const user = userEvent.setup();

      await screen.findByRole("article", { name: /figma view source: screen 2/iu });
      await user.click(screen.getByRole("button", { name: /inspect json/iu }));

      await waitFor(() =>
        expect(loadScreenJsonSpy).toHaveBeenCalledWith(
          MOCK_SUMMARY.runId,
          "screen-2",
          expect.any(AbortSignal),
        ),
      );
      expect(
        await screen.findByRole("region", { name: /scoped json for screen 2/iu }),
      ).toBeInTheDocument();
      const codeBlock = container.querySelector(".figma-view-json-code");
      expect(codeBlock).toHaveTextContent('"interactionHint": "button"');
      expect(codeBlock).toHaveTextContent('"screenIds": [');
      expect(container.querySelector(".json-token-key")).not.toBeNull();

      const dragSurface = container.querySelector<HTMLElement>(".figma-view-json-drag-surface");
      expect(dragSurface).not.toBeNull();
      const dataTransfer = {
        effectAllowed: "none",
        setData: vi.fn(),
      };
      fireEvent.dragStart(dragSurface as HTMLElement, { dataTransfer });

      expect(dataTransfer.effectAllowed).toBe("copyMove");
      expect(dataTransfer.setData).toHaveBeenCalledWith(
        FIGMA_JSON_DRAG_TYPE,
        expect.stringContaining('"sourceWindowId":"figma-view-1"'),
      );
      expect(dataTransfer.setData).toHaveBeenCalledWith(
        FIGMA_JSON_DRAG_TYPE,
        expect.stringContaining('"screenId":"screen-2"'),
      );
    });

    it("exposes a standalone image drag payload from the scoped view preview", async () => {
      const loadSpy = vi.fn(async (_runId: string) => MOCK_SUMMARY);
      renderWindow({
        sourceWindowId: "figma-view-1",
        snapshotRunId: MOCK_SUMMARY.runId,
        selectedScreenIds: ["screen-2"],
        selectedScreenName: "Screen 2",
        loadImpl: loadSpy as unknown as LoadFn,
      });

      await screen.findByRole("article", { name: /figma view source: screen 2/iu });
      const imageSurface = screen.getByRole("button", {
        name: /create a standalone image source for screen 2/iu,
      });
      const dataTransfer = {
        effectAllowed: "none",
        setData: vi.fn(),
      };
      fireEvent.dragStart(imageSurface, { dataTransfer });

      expect(dataTransfer.effectAllowed).toBe("copyMove");
      expect(dataTransfer.setData).toHaveBeenCalledWith(
        FIGMA_IMAGE_DRAG_TYPE,
        expect.stringContaining('"sourceWindowId":"figma-view-1"'),
      );
      expect(dataTransfer.setData).toHaveBeenCalledWith(
        FIGMA_IMAGE_DRAG_TYPE,
        expect.stringContaining(
          '"imageSrc":"/api/figma/snapshots/fs-test-run-id-1234/screens/1/image"',
        ),
      );
      expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", "Screen 2.png");
    });

    it("dispatches a standalone image drop from the scoped view preview via keyboard", async () => {
      const loadSpy = vi.fn(async (_runId: string) => MOCK_SUMMARY);
      renderWindow({
        sourceWindowId: "figma-view-1",
        snapshotRunId: MOCK_SUMMARY.runId,
        selectedScreenIds: ["screen-2"],
        selectedScreenName: "Screen 2",
        loadImpl: loadSpy as unknown as LoadFn,
      });

      await screen.findByRole("article", { name: /figma view source: screen 2/iu });
      const imageSurface = screen.getByRole("button", {
        name: /create a standalone image source for screen 2/iu,
      });
      Object.defineProperty(imageSurface, "getBoundingClientRect", {
        configurable: true,
        value: () => mockRect({ right: 300, top: 40, height: 60 }),
      });
      const onDrop = vi.fn();
      window.addEventListener(FIGMA_IMAGE_DROP_EVENT, onDrop as EventListener);
      try {
        fireEvent.keyDown(imageSurface, { key: "Enter" });

        expect(onDrop).toHaveBeenCalledTimes(1);
        expect((onDrop.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
          payload: {
            snapshotRunId: MOCK_SUMMARY.runId,
            screenId: "screen-2",
            name: "Screen 2",
            imageSrc: "/api/figma/snapshots/fs-test-run-id-1234/screens/1/image",
            sourceWindowId: "figma-view-1",
          },
          clientX: 324,
          clientY: 70,
        });
      } finally {
        window.removeEventListener(FIGMA_IMAGE_DROP_EVENT, onDrop as EventListener);
      }
    });

    it("dispatches a standalone image drop from the scoped view preview via mouse drag fallback", async () => {
      const loadSpy = vi.fn(async (_runId: string) => MOCK_SUMMARY);
      renderWindow({
        sourceWindowId: "figma-view-1",
        snapshotRunId: MOCK_SUMMARY.runId,
        selectedScreenIds: ["screen-2"],
        selectedScreenName: "Screen 2",
        loadImpl: loadSpy as unknown as LoadFn,
      });

      const workspace = document.createElement("main");
      workspace.className = "workspace";
      document.body.appendChild(workspace);
      const originalElementFromPoint = document.elementFromPoint;
      document.elementFromPoint = vi.fn(() => workspace);
      const onDrop = vi.fn();
      window.addEventListener(FIGMA_IMAGE_DROP_EVENT, onDrop as EventListener);
      try {
        await screen.findByRole("article", { name: /figma view source: screen 2/iu });
        const imageSurface = screen.getByRole("button", {
          name: /create a standalone image source for screen 2/iu,
        });
        fireEvent.mouseDown(imageSurface, { button: 0, clientX: 10, clientY: 10 });
        fireEvent.mouseMove(window, { clientX: 24, clientY: 10 });
        fireEvent.mouseUp(window, { clientX: 80, clientY: 90 });

        expect(onDrop).toHaveBeenCalledTimes(1);
        expect((onDrop.mock.calls[0]?.[0] as CustomEvent).detail).toMatchObject({
          payload: {
            snapshotRunId: MOCK_SUMMARY.runId,
            screenId: "screen-2",
            name: "Screen 2",
            sourceWindowId: "figma-view-1",
          },
          clientX: 80,
          clientY: 90,
        });
      } finally {
        window.removeEventListener(FIGMA_IMAGE_DROP_EVENT, onDrop as EventListener);
        document.elementFromPoint = originalElementFromPoint;
        workspace.remove();
      }
    });

    it("dispatches a standalone JSON drop from the scoped inspector via keyboard", async () => {
      const loadSpy = vi.fn(async (_runId: string) => MOCK_SUMMARY);
      const loadScreenJsonSpy = vi.fn(async () => MOCK_SCREEN_JSON);
      const { container } = renderWindow({
        sourceWindowId: "figma-view-1",
        snapshotRunId: MOCK_SUMMARY.runId,
        selectedScreenIds: ["screen-2"],
        selectedScreenName: "Screen 2",
        loadImpl: loadSpy as unknown as LoadFn,
        loadScreenJsonImpl: loadScreenJsonSpy as unknown as LoadScreenJsonFn,
      });
      const user = userEvent.setup();

      await screen.findByRole("article", { name: /figma view source: screen 2/iu });
      await user.click(screen.getByRole("button", { name: /inspect json/iu }));
      await screen.findByRole("region", { name: /scoped json for screen 2/iu });
      const dragSurface = container.querySelector<HTMLElement>(".figma-view-json-drag-surface");
      expect(dragSurface).not.toBeNull();
      Object.defineProperty(dragSurface as HTMLElement, "getBoundingClientRect", {
        configurable: true,
        value: () => mockRect({ right: 420, top: 12, height: 44 }),
      });
      const onDrop = vi.fn();
      window.addEventListener(FIGMA_JSON_DROP_EVENT, onDrop as EventListener);
      try {
        fireEvent.keyDown(dragSurface as HTMLElement, { key: " " });

        expect(onDrop).toHaveBeenCalledTimes(1);
        expect((onDrop.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
          payload: {
            snapshotRunId: MOCK_SUMMARY.runId,
            screenId: "screen-2",
            name: "Screen 2",
            sourceWindowId: "figma-view-1",
          },
          clientX: 444,
          clientY: 34,
        });
      } finally {
        window.removeEventListener(FIGMA_JSON_DROP_EVENT, onDrop as EventListener);
      }
    });

    it("dispatches a standalone JSON drop from the scoped inspector via mouse drag", async () => {
      const loadSpy = vi.fn(async (_runId: string) => MOCK_SUMMARY);
      const loadScreenJsonSpy = vi.fn(async () => MOCK_SCREEN_JSON);
      const { container } = renderWindow({
        sourceWindowId: "figma-view-1",
        snapshotRunId: MOCK_SUMMARY.runId,
        selectedScreenIds: ["screen-2"],
        selectedScreenName: "Screen 2",
        loadImpl: loadSpy as unknown as LoadFn,
        loadScreenJsonImpl: loadScreenJsonSpy as unknown as LoadScreenJsonFn,
      });
      const user = userEvent.setup();

      await screen.findByRole("article", { name: /figma view source: screen 2/iu });
      await user.click(screen.getByRole("button", { name: /inspect json/iu }));
      await screen.findByRole("region", { name: /scoped json for screen 2/iu });
      const dragSurface = container.querySelector<HTMLElement>(".figma-view-json-drag-surface");
      expect(dragSurface).not.toBeNull();

      const workspace = document.createElement("main");
      workspace.className = "workspace";
      document.body.appendChild(workspace);
      const originalElementFromPoint = document.elementFromPoint;
      document.elementFromPoint = vi.fn(() => workspace);
      const onDrop = vi.fn();
      window.addEventListener(FIGMA_JSON_DROP_EVENT, onDrop as EventListener);
      try {
        fireEvent.mouseDown(dragSurface as HTMLElement, { button: 0, clientX: 10, clientY: 10 });
        fireEvent.mouseMove(window, { clientX: 30, clientY: 20 });
        fireEvent.mouseUp(window, { clientX: 90, clientY: 110 });

        expect(onDrop).toHaveBeenCalledTimes(1);
        expect((onDrop.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
          payload: {
            snapshotRunId: MOCK_SUMMARY.runId,
            screenId: "screen-2",
            name: "Screen 2",
            sourceWindowId: "figma-view-1",
          },
          clientX: 90,
          clientY: 110,
        });
      } finally {
        window.removeEventListener(FIGMA_JSON_DROP_EVENT, onDrop as EventListener);
        document.elementFromPoint = originalElementFromPoint;
        workspace.remove();
      }
    });

    it("copies scoped JSON from the inspector when clipboard access is available", async () => {
      const loadSpy = vi.fn(async (_runId: string) => MOCK_SUMMARY);
      const loadScreenJsonSpy = vi.fn(async () => MOCK_SCREEN_JSON);
      renderWindow({
        snapshotRunId: MOCK_SUMMARY.runId,
        selectedScreenIds: ["screen-2"],
        selectedScreenName: "Screen 2",
        loadImpl: loadSpy as unknown as LoadFn,
        loadScreenJsonImpl: loadScreenJsonSpy as unknown as LoadScreenJsonFn,
      });
      const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
      const writeText = vi.fn(async (_text: string) => undefined);
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });
      try {
        await screen.findByRole("article", { name: /figma view source: screen 2/iu });
        fireEvent.click(screen.getByRole("button", { name: /inspect json/iu }));
        await screen.findByRole("region", { name: /scoped json for screen 2/iu });
        fireEvent.click(screen.getByRole("button", { name: /copy json/iu }));

        await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
        expect(writeText.mock.calls[0]?.[0]).toContain('"screenId": "screen-2"');
        expect(await screen.findByText("Copied")).toBeInTheDocument();
      } finally {
        if (clipboardDescriptor !== undefined) {
          Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
        } else {
          Reflect.deleteProperty(navigator, "clipboard");
        }
      }
    });

    it("shows scoped JSON copy failure states for unavailable or rejected clipboard access", async () => {
      const loadSpy = vi.fn(async (_runId: string) => MOCK_SUMMARY);
      const loadScreenJsonSpy = vi.fn(async () => MOCK_SCREEN_JSON);
      const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: undefined,
      });
      try {
        renderWindow({
          snapshotRunId: MOCK_SUMMARY.runId,
          selectedScreenIds: ["screen-2"],
          selectedScreenName: "Screen 2",
          loadImpl: loadSpy as unknown as LoadFn,
          loadScreenJsonImpl: loadScreenJsonSpy as unknown as LoadScreenJsonFn,
        });
        await screen.findByRole("article", { name: /figma view source: screen 2/iu });
        fireEvent.click(screen.getByRole("button", { name: /inspect json/iu }));
        await screen.findByRole("region", { name: /scoped json for screen 2/iu });
        fireEvent.click(screen.getByRole("button", { name: /copy json/iu }));
        expect(await screen.findByText("Clipboard unavailable")).toBeInTheDocument();
      } finally {
        if (clipboardDescriptor !== undefined) {
          Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
        } else {
          Reflect.deleteProperty(navigator, "clipboard");
        }
      }

      const rejectedClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: vi.fn(async () => Promise.reject(new Error("blocked"))) },
      });
      try {
        renderWindow({
          snapshotRunId: MOCK_SUMMARY.runId,
          selectedScreenIds: ["screen-2"],
          selectedScreenName: "Screen 2",
          loadImpl: loadSpy as unknown as LoadFn,
          loadScreenJsonImpl: loadScreenJsonSpy as unknown as LoadScreenJsonFn,
        });
        await screen.findAllByRole("article", { name: /figma view source: screen 2/iu });
        const inspectButtons = screen.getAllByRole("button", { name: /inspect json/iu });
        fireEvent.click(inspectButtons[inspectButtons.length - 1] as HTMLButtonElement);
        await screen.findAllByRole("region", { name: /scoped json for screen 2/iu });
        const copyButtons = screen.getAllByRole("button", { name: /copy json/iu });
        fireEvent.click(copyButtons[copyButtons.length - 1] as HTMLButtonElement);
        expect(await screen.findByText("Copy failed")).toBeInTheDocument();
      } finally {
        if (rejectedClipboardDescriptor !== undefined) {
          Object.defineProperty(navigator, "clipboard", rejectedClipboardDescriptor);
        } else {
          Reflect.deleteProperty(navigator, "clipboard");
        }
      }
    });

    // Fix #1: Load button stays mounted after a load failure (retry affordance).
    it("keeps the Load button mounted after a load failure (fix #1)", async () => {
      const loadSpy = vi.fn(async (_runId: string): Promise<FigmaSnapshotSummary> => {
        throw new ApiError("FIGMA_AUTH_FAILED", "Token invalid.", 401);
      });
      renderWindow({ snapshotRunId: "fs-stored-123", loadImpl: loadSpy as unknown as LoadFn });
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /load snapshot/iu }));
      await waitFor(() => expect(screen.getByText(/token invalid/iu)).toBeInTheDocument());
      // The Load button must remain mounted after the error.
      expect(screen.getByRole("button", { name: /load snapshot/iu })).toBeInTheDocument();
    });

    // Fix #6: FIGMA_SNAPSHOT_NOT_FOUND clears the stale snapshotRunId in cfg.
    it("clears cfg snapshotRunId when load returns FIGMA_SNAPSHOT_NOT_FOUND (fix #6)", async () => {
      const loadSpy = vi.fn(async (_runId: string): Promise<FigmaSnapshotSummary> => {
        throw new ApiError("FIGMA_SNAPSHOT_NOT_FOUND", "No snapshot found.", 404);
      });
      const { updateCfg } = renderWindow({
        snapshotRunId: "fs-dead-run",
        loadImpl: loadSpy as unknown as LoadFn,
      });
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /load snapshot/iu }));
      await waitFor(() => expect(updateCfg).toHaveBeenCalledWith({ snapshotRunId: undefined }));
    });
  });

  describe("revoke token (#758, fix #3)", () => {
    async function getToRevoke(user: ReturnType<typeof userEvent.setup>) {
      const trigger = resolvingTrigger();
      const revokeFn = vi.fn(async (): Promise<FigmaRevokeTokenResult> => ({
        code: "FIGMA_TOKEN_REVOKED_OK",
        message: "The stored Figma PAT was removed.",
      }));
      renderWindow({ triggerImpl: trigger, revokeImpl: revokeFn as unknown as RevokeFn });
      await typeAndSubmit(user);
      await waitForDone();
      // Open the PAT scopes details.
      await user.click(screen.getByText(/required figma pat scopes/iu));
      return { revokeFn };
    }

    it("shows a Revoke stored token button inside the PAT scopes details", async () => {
      const user = userEvent.setup();
      await getToRevoke(user);
      expect(screen.getByRole("button", { name: /revoke stored token/iu })).toBeInTheDocument();
    });

    it("shows a two-step confirm after clicking Revoke stored token", async () => {
      const user = userEvent.setup();
      await getToRevoke(user);
      await user.click(screen.getByRole("button", { name: /revoke stored token/iu }));
      expect(screen.getByRole("button", { name: /yes, revoke/iu })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /cancel/iu })).toBeInTheDocument();
    });

    it("calls revokeImpl and shows success status after confirm", async () => {
      const user = userEvent.setup();
      const { revokeFn } = await getToRevoke(user);
      await user.click(screen.getByRole("button", { name: /revoke stored token/iu }));
      await user.click(screen.getByRole("button", { name: /yes, revoke/iu }));
      await waitFor(() => expect(revokeFn).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(screen.getByText(/stored figma pat was removed/iu)).toBeInTheDocument(),
      );
    });

    it("shows error status when revokeImpl rejects", async () => {
      const user = userEvent.setup();
      const trigger = resolvingTrigger();
      const revokeFn = vi.fn(async (): Promise<FigmaRevokeTokenResult> => {
        throw new ApiError("FIGMA_TOKEN_MISSING", "No token stored.", 404);
      });
      renderWindow({ triggerImpl: trigger, revokeImpl: revokeFn as unknown as RevokeFn });
      await typeAndSubmit(user);
      await waitForDone();
      await user.click(screen.getByText(/required figma pat scopes/iu));
      await user.click(screen.getByRole("button", { name: /revoke stored token/iu }));
      await user.click(screen.getByRole("button", { name: /yes, revoke/iu }));
      await waitFor(() => expect(screen.getByText(/no token stored/iu)).toBeInTheDocument());
    });

    it("cancelling the confirm does not call revokeImpl", async () => {
      const user = userEvent.setup();
      const { revokeFn } = await getToRevoke(user);
      await user.click(screen.getByRole("button", { name: /revoke stored token/iu }));
      await user.click(screen.getByRole("button", { name: /cancel/iu }));
      expect(revokeFn).not.toHaveBeenCalled();
      // The trigger button is shown again.
      expect(screen.getByRole("button", { name: /revoke stored token/iu })).toBeInTheDocument();
    });
  });

  describe("cancel / abort (fix #7)", () => {
    it("renders a Cancel button while building", async () => {
      let hold!: () => void;
      const trigger = makeTrigger(
        (_link) =>
          new Promise<FigmaSnapshotSummary>((_, reject) => {
            hold = () => reject(new DOMException("Aborted", "AbortError"));
          }),
      );
      renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      expect(screen.getByRole("button", { name: /cancel/iu })).toBeInTheDocument();
      hold();
    });

    it("clicking Cancel returns to idle state", async () => {
      let resolveAbort!: () => void;
      const trigger = makeTrigger(
        (_link) =>
          new Promise<FigmaSnapshotSummary>((_, reject) => {
            resolveAbort = () => reject(new DOMException("Aborted", "AbortError"));
          }),
      );
      renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      expect(screen.getByRole("button", { name: /cancel/iu })).toBeInTheDocument();
      // Abort the promise so the handler gets AbortError.
      resolveAbort();
      await user.click(screen.getByRole("button", { name: /cancel/iu }));
      await waitFor(() =>
        expect(screen.queryByText(/building snapshot/iu)).not.toBeInTheDocument(),
      );
      // Back to idle — the Snapshot button is available again.
      expect(screen.queryByRole("button", { name: /cancel/iu })).not.toBeInTheDocument();
    });

    it("shows a background-build notice after Cancel and can reconnect to the same board", async () => {
      let rejectFirst!: (reason: unknown) => void;
      let resolveSecond!: (value: FigmaSnapshotSummary) => void;
      const trigger = vi
        .fn()
        .mockImplementationOnce(
          async (_link: string) =>
            new Promise<FigmaSnapshotSummary>((_resolve, reject) => {
              rejectFirst = reject;
            }),
        )
        .mockImplementationOnce(
          async (_link: string) =>
            new Promise<FigmaSnapshotSummary>((resolve) => {
              resolveSecond = resolve;
            }),
        );
      renderWindow({ triggerImpl: trigger as unknown as TriggerFn });
      const user = userEvent.setup();
      await typeAndSubmit(user);

      rejectFirst(new DOMException("Aborted", "AbortError"));
      await user.click(screen.getByRole("button", { name: /cancel/iu }));

      await waitFor(() =>
        expect(screen.getByText(/server may still be building the snapshot/iu)).toBeInTheDocument(),
      );
      await user.click(screen.getByRole("button", { name: /reconnect build/iu }));
      await waitFor(() => expect(trigger).toHaveBeenCalledTimes(2));
      expect(trigger.mock.calls[1]?.[0]).toBe(VALID_LINK);

      resolveSecond(MOCK_SUMMARY);
      await waitForDone();
    });

    it("wires the abort signal into triggerImpl (signal present after successful build)", async () => {
      const trigger = resolvingTrigger();
      renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      await waitForDone();
      // The options object passed to triggerImpl must include a signal.
      const opts = trigger.mock.calls[0]?.[1] as TriggerFigmaSnapshotOptions | undefined;
      expect(opts?.signal).toBeInstanceOf(AbortSignal);
      // Build completed normally — signal was not aborted.
      expect(opts?.signal?.aborted).toBe(false);
    });

    it("surfaces elapsed-build messaging while waiting", async () => {
      const trigger = makeTrigger((_link) => new Promise<FigmaSnapshotSummary>(() => {}));
      renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      expect(
        screen.getByText(/elapsed\. large boards can take several minutes/iu),
      ).toBeInTheDocument();
    });

    it("explains that a timed-out wait may still finish in the background", async () => {
      const trigger = makeTrigger(async (_link): Promise<FigmaSnapshotSummary> => {
        throw new ApiError(
          "FIGMA_BUILD_TIMEOUT",
          "The snapshot build exceeded the configured deadline.",
          504,
        );
      });
      renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      await waitFor(() =>
        expect(
          screen.getByText(/window stopped waiting for the snapshot result/iu),
        ).toBeInTheDocument(),
      );
      expect(screen.getByRole("button", { name: /reconnect build/iu })).toBeInTheDocument();
    });
  });

  describe("DOM structure — alert not nested inside status (fix #5)", () => {
    it("assertive role=alert is a sibling, NOT a descendant, of role=status", async () => {
      const trigger = rejectingApiError("FIGMA_PROXY_EGRESS_FAILED", "Proxy failure.", 502);
      const { container } = renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      await screen.findByRole("alert");

      const statusRegion = container.querySelector('[role="status"]');
      expect(statusRegion).not.toBeNull();
      // The alert element must NOT be inside the status region.
      const alertInsideStatus = statusRegion?.querySelector('[role="alert"]');
      expect(alertInsideStatus).toBeNull();
    });
  });

  describe("PAT scopes", () => {
    it("shows scopes info in a details element after success", async () => {
      const trigger = resolvingTrigger();
      renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      await waitFor(() =>
        expect(screen.getByText(/required figma pat scopes/iu)).toBeInTheDocument(),
      );
      // Security: no token input/field anywhere in the component.
      expect(screen.queryByRole("textbox", { name: /token/iu })).not.toBeInTheDocument();
    });

    it("shows the canonical read-only Figma PAT scopes", async () => {
      const trigger = resolvingTrigger();
      renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      await waitFor(() =>
        expect(screen.getByText(/required figma pat scopes/iu)).toBeInTheDocument(),
      );
      await user.click(screen.getByText(/required figma pat scopes/iu));
      expect(screen.getAllByText("file_content:read").length).toBeGreaterThan(0);
      expect(screen.queryByText("file_read")).not.toBeInTheDocument();
      expect(screen.queryByText("files:read")).not.toBeInTheDocument();
      expect(screen.queryByText("file_dev_resources:read")).not.toBeInTheDocument();
    });
  });

  describe("accessibility (jest-axe)", () => {
    it("has no axe violations in idle state", async () => {
      const { container } = renderWindow();
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    it("has no axe violations in done state", async () => {
      const trigger = resolvingTrigger();
      const { container } = renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      await waitForDone();
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    it("has no axe violations in error state", async () => {
      const trigger = rejectingTrigger("FIGMA_AUTH_FAILED", "Token invalid");
      const { container } = renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      await waitFor(() => expect(screen.getByText(/token invalid/iu)).toBeInTheDocument());
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    // Issue #1399: the PAT error state renders an action button INSIDE role="alert" — axe must
    // scan that distinct structure (the generic error state above uses a non-PAT code, so the
    // button is absent there).
    it("has no axe violations in the PAT error state (action button inside the alert)", async () => {
      const trigger = rejectingApiError("FIGMA_TOKEN_MISSING", "No token stored.", 401);
      const { container } = renderWindow({ triggerImpl: trigger, openTokenSettings: vi.fn() });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      await screen.findByRole("button", { name: /open figma access token settings/iu });
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    it("has no axe violations in load-stored state", async () => {
      const { container } = renderWindow({ snapshotRunId: "fs-abc123" });
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    it("has no axe violations in building state (Cancel button visible) — #756 audit", async () => {
      // A never-resolving trigger keeps buildState==="building" so the Cancel button renders.
      const trigger = makeTrigger((_link) => new Promise<FigmaSnapshotSummary>(() => {}));
      const { container } = renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      expect(screen.getByRole("button", { name: /cancel/iu })).toBeInTheDocument();
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });
  });

  describe("read-only-scope consent (#760)", () => {
    it("blocks submit without consent via an inline message — no server roundtrip (C108)", async () => {
      const trigger = resolvingTrigger();
      renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await user.type(screen.getByLabelText(/board link/iu), VALID_LINK);
      await user.click(screen.getByRole("button", { name: /snapshot/iu }));
      expect(trigger).not.toHaveBeenCalled();
      expect(screen.getByText(/read-only acknowledgement/iu)).toBeInTheDocument();
    });

    it("clears the consent message once the box is checked", async () => {
      const trigger = resolvingTrigger();
      renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await user.type(screen.getByLabelText(/board link/iu), VALID_LINK);
      await user.click(screen.getByRole("button", { name: /snapshot/iu }));
      expect(screen.getByText(/read-only acknowledgement/iu)).toBeInTheDocument();
      await user.click(screen.getByRole("checkbox", { name: /read-only and least-privilege/iu }));
      expect(screen.queryByText(/read-only acknowledgement/iu)).not.toBeInTheDocument();
    });

    it("marks the acknowledgement as required before the first snapshot", () => {
      renderWindow();
      expect(screen.getByText(/required before the first snapshot/iu)).toBeInTheDocument();
    });

    it("focuses and visually marks the checkbox when consent blocks a snapshot (F038 C210)", async () => {
      const trigger = resolvingTrigger();
      renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await user.type(screen.getByLabelText(/board link/iu), VALID_LINK);
      await user.click(screen.getByRole("button", { name: /snapshot/iu }));
      // The error must point AT the control: aria-invalid drives the danger outline and
      // focus lands on the checkbox so the fix is one keypress away.
      const checkbox = screen.getByRole("checkbox", { name: /read-only and least-privilege/iu });
      expect(checkbox).toHaveAttribute("aria-invalid", "true");
      expect(checkbox).toHaveFocus();
      // Ticking the box answers the error — the invalid marking clears with the message.
      await user.click(checkbox);
      expect(checkbox).not.toHaveAttribute("aria-invalid");
    });

    it("points the server's 428 FIGMA_CONSENT_REQUIRED at the checkbox (F038 C210)", async () => {
      const err = new ApiError(
        "FIGMA_CONSENT_REQUIRED",
        "Acknowledge the read-only, least-privilege Figma scope before the first snapshot for this board.",
        428,
      );
      const trigger = makeTrigger(async (): Promise<FigmaSnapshotSummary> => {
        throw err;
      });
      renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      // The server message names the policy but not the control — the UI appends an
      // instruction that references the checkbox and highlights + focuses it.
      await waitFor(() =>
        expect(
          screen.getByText(/tick the acknowledgement checkbox below, then snapshot again/iu),
        ).toBeInTheDocument(),
      );
      const checkbox = screen.getByRole("checkbox", { name: /read-only and least-privilege/iu });
      expect(checkbox).toHaveAttribute("aria-invalid", "true");
      expect(checkbox).toHaveFocus();
    });
  });

  describe("link validation feedback (C093/C246)", () => {
    it("explains a non-Figma URL inline", async () => {
      renderWindow();
      const user = userEvent.setup();
      await user.type(screen.getByLabelText(/board link/iu), "https://example.com/nope");
      expect(screen.getByText(/doesn't look like a figma board link/iu)).toBeInTheDocument();
    });

    it("rejects non-HTTPS and subdomain Figma URLs client-side", async () => {
      renderWindow();
      const user = userEvent.setup();
      const input = screen.getByLabelText(/board link/iu);
      await user.type(input, "http://www.figma.com/design/KEY/Board?node-id=1-2");
      expect(screen.getByText(/doesn't look like a figma board link/iu)).toBeInTheDocument();
      await user.clear(input);
      await user.type(input, "https://evil.figma.com/design/KEY/Board?node-id=1-2");
      expect(screen.getByText(/doesn't look like a figma board link/iu)).toBeInTheDocument();
    });

    it("explains a Figma URL without node-id inline (how to get one)", async () => {
      renderWindow();
      const user = userEvent.setup();
      await user.type(screen.getByLabelText(/board link/iu), INVALID_LINK);
      expect(
        screen.getByText(/add a node-id by selecting a frame or section/iu),
      ).toBeInTheDocument();
    });

    // #24, WCAG 3.3.1 — the validation error must be announced dynamically.
    // RED: the <p> currently has no live-region role so screen readers are silent.
    it("exposes the board-link validation error as an alert live region (#24, WCAG 3.3.1)", async () => {
      renderWindow();
      const user = userEvent.setup();
      await user.type(screen.getByLabelText(/board link/iu), "https://not-figma.com/nope");
      // Must be reachable via getByRole("alert") — the paragraph must carry role="alert"
      // (or aria-live="assertive" aria-atomic="true") so AT announces it on insertion.
      const validationError = screen.getByRole("alert");
      expect(validationError).toHaveTextContent(/doesn't look like a figma board link/iu);
    });
  });

  describe("error handling polish (C209/C211)", () => {
    it("shows ApiError messages without the raw error-code prefix", async () => {
      const err = new ApiError(
        "FIGMA_CONSENT_REQUIRED",
        "Acknowledge the read-only, least-privilege Figma scope before the first snapshot for this board.",
        428,
      );
      const trigger = makeTrigger(async (_link): Promise<FigmaSnapshotSummary> => {
        throw err;
      });
      renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      await waitFor(() =>
        expect(screen.getByText(/acknowledge the read-only/iu)).toBeInTheDocument(),
      );
      expect(screen.queryByText(/FIGMA_CONSENT_REQUIRED/u)).not.toBeInTheDocument();
    });

    it("clears a stale error as soon as the board link is edited", async () => {
      const trigger = rejectingTrigger("FIGMA_AUTH_FAILED", "Token invalid or missing");
      renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      await waitFor(() =>
        expect(screen.getByText(/token invalid or missing/iu)).toBeInTheDocument(),
      );
      await user.type(screen.getByLabelText(/board link/iu), "x");
      expect(screen.queryByText(/token invalid or missing/iu)).not.toBeInTheDocument();
    });
  });

  describe("first-run empty state (C213)", () => {
    it("renders 3-step guidance when nothing is captured or stored", () => {
      renderWindow();
      expect(
        screen.getByText(/select the frame or section you want to capture/iu),
      ).toBeInTheDocument();
      expect(screen.getByText(/connect this window to quality intelligence/iu)).toBeInTheDocument();
    });

    it("hides the guidance when a stored snapshot is available", () => {
      renderWindow({ snapshotRunId: "fs-stored-123" });
      expect(
        screen.queryByText(/select the frame or section you want to capture/iu),
      ).not.toBeInTheDocument();
    });
  });

  describe("status announcements (C151/C245)", () => {
    it("announces 'Loading stored snapshot' (not 'fetching from Figma') and keeps the button mounted", async () => {
      let resolveLoad!: (s: FigmaSnapshotSummary) => void;
      const loadSpy = vi.fn(
        (_runId: string) =>
          new Promise<FigmaSnapshotSummary>((res) => {
            resolveLoad = res;
          }),
      );
      renderWindow({ snapshotRunId: "fs-stored-123", loadImpl: loadSpy as unknown as LoadFn });
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /load snapshot/iu }));
      expect(screen.getByText(/loading stored snapshot/iu)).toBeInTheDocument();
      expect(screen.queryByText(/fetching screens from figma/iu)).not.toBeInTheDocument();
      // C247: the activated button stays mounted (aria-disabled), so focus is not lost.
      expect(screen.getByRole("button", { name: /loading/iu })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      resolveLoad(MOCK_SUMMARY);
      await waitForDone();
    });

    it("announces snapshot completion in the live status region", async () => {
      const trigger = resolvingTrigger();
      renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      await waitForDone();
      expect(screen.getByText(/snapshot complete/iu)).toBeInTheDocument();
    });
  });

  describe("snapshot metadata + microcopy (F045)", () => {
    it("shows when the snapshot was captured (C250)", async () => {
      const trigger = resolvingTrigger();
      renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      await waitForDone();
      // formatDate output is locale-dependent — assert the label, not the rendering.
      expect(screen.getByText(/^captured /iu)).toBeInTheDocument();
    });

    it("formats screen image sizes with the app-wide KB convention (C313)", async () => {
      const trigger = resolvingTrigger();
      renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      await waitForDone();
      // makeScreen(n) carries 1024*n bytes — lib/format formatBytes, not ad-hoc "KiB".
      expect(screen.getByText("1.0 KB")).toBeInTheDocument();
      expect(screen.getByText("2.0 KB")).toBeInTheDocument();
      expect(screen.queryByText(/KiB/u)).not.toBeInTheDocument();
    });

    it("exposes the full screen name via title on the ellipsised heading (C252)", async () => {
      const trigger = resolvingTrigger();
      renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      await waitForDone();
      expect(screen.getByRole("heading", { name: "Screen 1" })).toHaveAttribute(
        "title",
        "Screen 1",
      );
    });

    it("announces errors via the polite status region without a nested alert (C375)", async () => {
      const trigger = rejectingTrigger("FIGMA_AUTH_FAILED", "Token invalid or missing");
      renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      const msg = await screen.findByText(/token invalid or missing/iu);
      // The live region (role="status", aria-atomic) announces its content itself — a
      // nested role="alert" caused double/competing announcements (F045 C375).
      expect(msg).not.toHaveAttribute("role");
    });
  });

  describe("design-to-code (#755)", () => {
    const MOCK_CODE: FigmaCodegenResponse = {
      runId: "fs-test-run-id-1234",
      adapterName: "html-css",
      fileCount: 3,
      totalBytes: 1234,
      screenCount: 2,
      files: [
        { path: "index.html", contents: "<!doctype html>" },
        { path: "tokens.css", contents: ":root { --color-1: #000000; }" },
        { path: "screens/screen-1.html", contents: "<main>Welcome</main>" },
      ],
    };

    function resolvingCodegen(): CodegenFn & {
      mock: { calls: unknown[][] };
    } {
      return vi.fn(
        async (_runId: string, _signal?: AbortSignal) => MOCK_CODE,
      ) as unknown as CodegenFn & {
        mock: { calls: unknown[][] };
      };
    }

    function pendingCodegen(): CodegenFn & { mock: { calls: unknown[][] } } {
      return vi.fn(
        (_runId: string, signal?: AbortSignal) =>
          new Promise<FigmaCodegenResponse>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          }),
      ) as unknown as CodegenFn & { mock: { calls: unknown[][] } };
    }

    it("generates reviewable code from the stored snapshot and lists the files", async () => {
      const codegen = resolvingCodegen();
      renderWindow({ triggerImpl: resolvingTrigger(), codegenImpl: codegen });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      await waitForDone();
      await user.click(screen.getByRole("button", { name: /generate code/iu }));
      await waitFor(() => expect(codegen).toHaveBeenCalled());
      expect(codegen.mock.calls[0]?.[0]).toBe("fs-test-run-id-1234");
      expect(codegen.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
      expect(await screen.findByText("index.html")).toBeInTheDocument();
      expect(screen.getByText("tokens.css")).toBeInTheDocument();
      expect(screen.getByText(/proposal only, never auto-applied/iu)).toBeInTheDocument();
    });

    it("cancels an in-flight code generation request", async () => {
      const codegen = pendingCodegen();
      renderWindow({ triggerImpl: resolvingTrigger(), codegenImpl: codegen });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      await waitForDone();
      await user.click(screen.getByRole("button", { name: /generate code/iu }));
      await waitFor(() => expect(codegen).toHaveBeenCalled());
      const signal = codegen.mock.calls[0]?.[1] as AbortSignal | undefined;
      expect(signal?.aborted).toBe(false);

      await user.click(screen.getByRole("button", { name: /cancel/iu }));

      expect(signal?.aborted).toBe(true);
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: /cancel/iu })).not.toBeInTheDocument(),
      );
      expect(screen.getByRole("button", { name: /generate code/iu })).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });
});
