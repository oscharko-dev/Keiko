// Epic #750, Issue #756 — FigmaSnapshotWindow component tests.
//
// Tests cover:
//   - Initial render: label, input, button, hint.
//   - Link validation: invalid URL keeps button disabled; valid URL enables it.
//   - Trigger: submitting a valid link calls triggerImpl and shows building state.
//   - Success path: gallery renders screen cards with reduction hint;
//     snapshotRunId is stored via updateCfg.
//   - Error path: triggerImpl rejection surfaces the error message.
//   - Re-snapshot: re-snapshot button calls triggerImpl again.
//   - Load stored: when snapshotRunId in props and no summary, load button appears
//     and calls loadImpl.
//   - PAT scopes <details>: present and informational only (no token field).
//   - Accessibility: jest-axe passes on idle, done, error, and load-stored states.
//
// Security invariant under test: triggerImpl is only called with the board link,
// never with a token. The component cannot construct or forward a PAT.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import type { FigmaSnapshotSummary } from "@/lib/figma-snapshot-api";
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

// ── Helpers ────────────────────────────────────────────────────────────────────

function renderWindow(props: Partial<FigmaSnapshotWindowProps> = {}) {
  const updateCfg = vi.fn();
  const { container } = render(<FigmaSnapshotWindow updateCfg={updateCfg} {...props} />);
  return { container, updateCfg };
}

// Submit the Snapshot form with a valid board link.
async function typeAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/board link/iu), VALID_LINK);
  await user.click(screen.getByRole("button", { name: /snapshot/iu }));
}

// Wait until the done state (reduction hint visible).
async function waitForDone() {
  await waitFor(() => expect(screen.getByText("2 screens from 4 detected")).toBeInTheDocument());
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
  });

  describe("trigger — success", () => {
    it("calls triggerImpl with the board link only — no PAT", async () => {
      const trigger = resolvingTrigger();
      renderWindow({ triggerImpl: trigger });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      await waitFor(() => expect(trigger).toHaveBeenCalledTimes(1));
      expect(trigger).toHaveBeenCalledWith(VALID_LINK);
      // Security: only one argument (the board link), no token in any position.
      expect(trigger.mock.calls[0]).toHaveLength(1);
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
      expect(screen.getByRole("button", { name: /building/iu })).toBeDisabled();
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
      expect(loadSpy).toHaveBeenCalledWith("fs-stored-123");
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

    it("has no axe violations in load-stored state", async () => {
      const { container } = renderWindow({ snapshotRunId: "fs-abc123" });
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });
  });
});
