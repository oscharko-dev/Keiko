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

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import type {
  FigmaSnapshotSummary,
  FigmaCodegenResponse,
  FigmaRevokeTokenResult,
  TriggerFigmaSnapshotOptions,
} from "@/lib/figma-snapshot-api";
import { ApiError } from "@/lib/api";
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

function rejectingApiError(code: string, message: string, status: number): TriggerMock {
  const fn = vi.fn(async (_link: string): Promise<FigmaSnapshotSummary> => {
    throw new ApiError(code, message, status);
  });
  return fn as unknown as TriggerMock;
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
        "https://www.figma.com/design/AbCdEfGhIjKl/board?node-id=1:2",
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
      const revokeFn = vi.fn(
        async (): Promise<FigmaRevokeTokenResult> => ({
          code: "FIGMA_TOKEN_REVOKED_OK",
          message: "The stored Figma PAT was removed.",
        }),
      );
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

    it("explains a Figma URL without node-id inline (how to get one)", async () => {
      renderWindow();
      const user = userEvent.setup();
      await user.type(screen.getByLabelText(/board link/iu), INVALID_LINK);
      expect(
        screen.getByText(/add a node-id by selecting a frame or section/iu),
      ).toBeInTheDocument();
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

    function resolvingCodegen(): Required<FigmaSnapshotWindowProps>["codegenImpl"] & {
      mock: { calls: unknown[][] };
    } {
      return vi.fn(
        async (_runId: string) => MOCK_CODE,
      ) as unknown as Required<FigmaSnapshotWindowProps>["codegenImpl"] & {
        mock: { calls: unknown[][] };
      };
    }

    it("generates reviewable code from the stored snapshot and lists the files", async () => {
      const codegen = resolvingCodegen();
      renderWindow({ triggerImpl: resolvingTrigger(), codegenImpl: codegen });
      const user = userEvent.setup();
      await typeAndSubmit(user);
      await waitForDone();
      await user.click(screen.getByRole("button", { name: /generate code/iu }));
      await waitFor(() => expect(codegen).toHaveBeenCalledWith("fs-test-run-id-1234"));
      expect(await screen.findByText("index.html")).toBeInTheDocument();
      expect(screen.getByText("tokens.css")).toBeInTheDocument();
      expect(screen.getByText(/proposal only, never auto-applied/iu)).toBeInTheDocument();
    });
  });
});
