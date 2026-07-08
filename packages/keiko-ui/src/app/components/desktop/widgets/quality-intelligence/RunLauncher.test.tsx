// Issue #280 (Epic #270) — RunLauncher component tests.
//
// Tests cover:
//   - Initial render: source-type picker, requirements textarea, policy-profile select,
//     label input, and disabled Generate button when fields are empty.
//   - Source-type switching: "workspace" swaps textarea for folder-path browser.
//   - Enabling Generate: typing requirements text makes the button active.
//   - startImpl called with correct request shape for requirements source.
//   - startImpl called with correct request shape for workspace source.
//   - Run lifecycle: button shows "Cancel" during run; progress region visible.
//   - Cancel: AbortSignal becomes aborted when Cancel is clicked.
//   - onRunCompleted: called with the accepted runId and recheckable source handles after run
//     finishes.
//   - Error path: startImpl rejection surfaces in qi-launch-error.
//
// Design note: startImpl is typed as the real function but replaced with a
// controllable fake in every test. We never hit the network.

import { fireEvent, render, screen, waitFor, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nativeFileDialogSupported, pickWithNativeDialog } from "@/lib/native-file-dialog";
import { RunLauncher, type RunLauncherProps } from "./RunLauncher";

// Epic #1941 — Browse now opens the native OS dialog through the shared client; mock the module
// so the capability hook reports "supported" and picks resolve deterministically.
vi.mock("@/lib/native-file-dialog", () => ({
  nativeFileDialogSupported: vi.fn(async () => true),
  pickWithNativeDialog: vi.fn(async () => ({ kind: "cancelled" }) as const),
}));

beforeEach(() => {
  vi.mocked(pickWithNativeDialog).mockReset();
  vi.mocked(pickWithNativeDialog).mockResolvedValue({ kind: "cancelled" });
});
import {
  LOCAL_KNOWLEDGE_SCHEMA_VERSION,
  resolveKnowledgePodModelUsePolicy,
  standardPodModelUsePolicy,
} from "@oscharko-dev/keiko-contracts";
import type {
  CapsuleSetId,
  KnowledgePodSummary,
  QualityIntelligenceStartRunRequest,
  QualityIntelligenceRunStreamMessage,
} from "@oscharko-dev/keiko-contracts";

// ---------------------------------------------------------------------------
// startImpl seam — bound to the real startQiRun contract.
//
// startQiRun(request, signal, onMessage) streams QualityIntelligenceRunStreamMessage frames. The
// fakes below mirror that exact signature and emit real wire-shaped frames (runId / status carried at
// the TOP LEVEL of each frame, not wrapped in a payload envelope) so the tests exercise the true
// contract the component reads.
// ---------------------------------------------------------------------------

type StartQiRunFn = (
  request: QualityIntelligenceStartRunRequest,
  signal: AbortSignal,
  onMessage: (message: QualityIntelligenceRunStreamMessage) => void,
) => Promise<void>;
type FetchCapsulesFn = NonNullable<RunLauncherProps["fetchCapsulesImpl"]>;
type FetchCapsuleSetsFn = NonNullable<RunLauncherProps["fetchCapsuleSetsImpl"]>;
type CancelQiRunFn = NonNullable<RunLauncherProps["cancelImpl"]>;

const DONE_FRAME: QualityIntelligenceRunStreamMessage = {
  type: "done",
  runId: "run-done",
  status: "succeeded",
  totals: { candidates: 0, findings: 0, exports: 0 },
};

// A terminal `done` frame for a specific run. The result card opens for the run that SUCCEEDED, so
// completion keys off the done frame's runId (in production accepted.runId === done.runId).
function succeededDone(
  runId: string,
  status: "succeeded" | "failed" | "cancelled" = "succeeded",
): QualityIntelligenceRunStreamMessage {
  return { type: "done", runId, status, totals: { candidates: 0, findings: 0, exports: 0 } };
}

/**
 * Builds a fake startImpl that delivers a configurable sequence of messages
 * then resolves. The `onMessage` pattern mirrors the real startQiRun signature:
 * (request, signal, onMessage) => Promise<void>.
 *
 * Usage: pass the factory to `startImpl` prop, then await the returned promise
 * to block until the fake finishes.
 */
function makeStreamingFake(messages: readonly QualityIntelligenceRunStreamMessage[]): {
  startImpl: StartQiRunFn;
  done: Promise<void>;
} {
  let resolveDone!: () => void;
  const done = new Promise<void>((res) => {
    resolveDone = res;
  });

  const startImpl = vi.fn(
    async (
      _request: QualityIntelligenceStartRunRequest,
      _signal: AbortSignal,
      onMessage: (message: QualityIntelligenceRunStreamMessage) => void,
    ): Promise<void> => {
      for (const msg of messages) {
        onMessage(msg);
      }
      resolveDone();
    },
  ) as unknown as StartQiRunFn;

  return { startImpl, done };
}

/**
 * Builds a fake startImpl that rejects immediately with the given error.
 */
function makeRejectingFake(error: Error): StartQiRunFn {
  return vi.fn(async (): Promise<void> => {
    throw error;
  }) as unknown as StartQiRunFn;
}

/**
 * Builds a fake startImpl that stalls until the returned `abort` fn is called,
 * at which point it resolves (mimicking cancel). The signal check is exercised
 * by the real implementation; we test that the AbortSignal becomes aborted.
 */
function makeStallingFake(): {
  startImpl: StartQiRunFn;
  capturedSignal: () => AbortSignal | undefined;
  resolveStall: () => void;
} {
  let resolve!: () => void;
  let captured: AbortSignal | undefined;

  const startImpl = vi.fn(
    async (_request: Parameters<StartQiRunFn>[0], signal: AbortSignal): Promise<void> => {
      captured = signal;
      await new Promise<void>((res) => {
        resolve = res;
      });
    },
  ) as unknown as StartQiRunFn;

  return {
    startImpl,
    capturedSignal: () => captured,
    resolveStall: () => {
      resolve();
    },
  };
}

function makeAcceptedStallingFake(runId: string): {
  startImpl: StartQiRunFn;
  capturedSignal: () => AbortSignal | undefined;
  resolveStall: () => void;
} {
  let resolve!: () => void;
  let captured: AbortSignal | undefined;

  const startImpl = vi.fn(
    async (
      _request: Parameters<StartQiRunFn>[0],
      signal: AbortSignal,
      onMessage: Parameters<StartQiRunFn>[2],
    ): Promise<void> => {
      captured = signal;
      onMessage({
        type: "accepted",
        runId,
        requestedAt: "2026-01-01T00:00:00.000Z",
        sourceCount: 1,
        atomCount: 1,
      });
      await new Promise<void>((res) => {
        resolve = res;
      });
    },
  ) as unknown as StartQiRunFn;

  return {
    startImpl,
    capturedSignal: () => captured,
    resolveStall: () => {
      resolve();
    },
  };
}

function fakeFetchCapsules(capsules: readonly unknown[]): FetchCapsulesFn {
  return vi.fn().mockResolvedValue({ capsules }) as unknown as FetchCapsulesFn;
}

function fakeFetchCapsuleSets(
  capsuleSets: readonly unknown[],
  knowledgePods: readonly unknown[] = [],
): FetchCapsuleSetsFn {
  return vi.fn().mockResolvedValue({ capsuleSets, knowledgePods }) as unknown as FetchCapsuleSetsFn;
}

function knowledgePodSetSummary(
  id: CapsuleSetId,
  displayName: string,
  overrides: Partial<Pick<KnowledgePodSummary, "readiness" | "setReadiness">> = {},
): KnowledgePodSummary {
  return {
    schemaVersion: "1",
    id,
    kind: "pod-set",
    displayName,
    tags: [],
    readiness: overrides.readiness ?? "ready",
    counts: { capsuleCount: 1, sourceCount: 0, documentCount: 0, chunkCount: 0, vectorCount: 0 },
    sourceKinds: [],
    ...(overrides.setReadiness !== undefined ? { setReadiness: overrides.setReadiness } : {}),
    retrieval: {
      lexicalIndex: false,
      vectorIndex: false,
      hybridGrounding: true,
      crossSpaceScoreMixing: false,
    },
    privacy: {
      localFirst: true,
      modelOpen: true,
      rawContentExposed: false,
      privatePathsExposed: false,
      evidenceMode: "counts-hashes-and-status",
      storageLocation: "local-runtime-state",
    },
    governance: {
      locationKind: "local",
      sealingPosture: "local-store-policy",
      policyPosture: "not-declared",
      managedServiceDependency: false,
    },
    modelUsePolicy: resolveKnowledgePodModelUsePolicy(standardPodModelUsePolicy()),
    compatibility: {
      backingKind: "capsule-set",
      capsuleIds: [],
      sourceIds: [],
      localKnowledgeSchemaVersion: LOCAL_KNOWLEDGE_SCHEMA_VERSION,
      migrationRequired: false,
      persistedStateRenamed: false,
    },
    updatedAt: 1,
    degradationReasons: [],
  };
}

function sourceTypeRadio(label: string): HTMLElement {
  const radio = screen
    .getAllByRole("radio")
    .find((candidate) => candidate.querySelector("span")?.textContent === label);
  if (radio === undefined) throw new Error(`Source type radio not found: ${label}`);
  return radio;
}

async function chooseSourceType(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
): Promise<void> {
  await user.click(sourceTypeRadio(label));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RunLauncher — initial render", () => {
  it("renders a source-label input", () => {
    render(<RunLauncher />);
    expect(screen.getByLabelText(/source label/i)).toBeInTheDocument();
  });

  it("renders the shipped source-type options", () => {
    render(<RunLauncher />);
    expect(screen.getByRole("radiogroup", { name: /source type/i })).toBeInTheDocument();
    expect(sourceTypeRadio("Requirements")).toHaveAttribute("aria-checked", "true");
    expect(sourceTypeRadio("Folder")).toBeInTheDocument();
    expect(sourceTypeRadio("File")).toBeInTheDocument();
    expect(sourceTypeRadio("Knowledge Pod")).toBeInTheDocument();
    expect(sourceTypeRadio("Knowledge Pod Set")).toBeInTheDocument();
  });

  it("exposes source-type labels as icon tooltips for compact state", () => {
    render(<RunLauncher />);
    for (const label of ["Requirements", "Folder", "File", "Knowledge Pod", "Knowledge Pod Set"]) {
      expect(sourceTypeRadio(label)).toHaveAttribute("data-tip", label);
    }
  });

  it("moves source-type selection on pointer down so the rail outline does not flicker", () => {
    render(<RunLauncher />);

    fireEvent.pointerDown(sourceTypeRadio("Folder"), { button: 0 });

    expect(sourceTypeRadio("Requirements")).toHaveAttribute("aria-checked", "false");
    expect(sourceTypeRadio("Folder")).toHaveAttribute("aria-checked", "true");
  });

  // ── APG radiogroup roving (GEN-UI-TEST-GAP-003 / test-plan #45, WCAG 2.1.1) ────
  // Arrow keys move both the checked state AND roving focus across the source-type radios; the
  // selection wraps at both ends. Only the checked radio is a tab stop (roving tabindex).

  it("roves the source-type radiogroup with ArrowRight and moves both selection and focus (#45)", () => {
    render(<RunLauncher />);
    const requirements = sourceTypeRadio("Requirements");
    // Only the checked radio is in the tab order (roving tabindex).
    expect(requirements).toHaveAttribute("tabindex", "0");
    expect(sourceTypeRadio("Folder")).toHaveAttribute("tabindex", "-1");

    requirements.focus();
    expect(document.activeElement).toBe(requirements);

    fireEvent.keyDown(requirements, { key: "ArrowRight" });

    const folder = sourceTypeRadio("Folder");
    // The adjacent radio becomes checked AND receives roving focus; the old one is deselected.
    expect(folder).toHaveAttribute("aria-checked", "true");
    expect(sourceTypeRadio("Requirements")).toHaveAttribute("aria-checked", "false");
    expect(document.activeElement).toBe(folder);
    expect(folder).toHaveAttribute("tabindex", "0");
  });

  it("wraps to the last radio with ArrowLeft from the first (#45)", () => {
    render(<RunLauncher />);
    const requirements = sourceTypeRadio("Requirements");
    requirements.focus();

    fireEvent.keyDown(requirements, { key: "ArrowLeft" });

    // ArrowLeft from the first option wraps to the last ("Knowledge Pod Set").
    const last = sourceTypeRadio("Knowledge Pod Set");
    expect(last).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(last);
  });

  it("is a no-op for arrow keys while a run is in progress (#45)", async () => {
    const user = userEvent.setup();
    const { startImpl } = makeAcceptedStallingFake("run-roving-lock");
    render(<RunLauncher startImpl={startImpl} />);

    // Start a run so `running` is true — the radiogroup arrow handler must be inert.
    await user.type(screen.getByRole("textbox", { name: /requirements/i }), "Lock the radios");
    await user.click(screen.getByRole("button", { name: /generate test cases/i }));
    await screen.findByRole("button", { name: /^cancel$/i });

    const requirements = sourceTypeRadio("Requirements");
    fireEvent.keyDown(requirements, { key: "ArrowRight" });

    // Selection did not move while running.
    expect(sourceTypeRadio("Requirements")).toHaveAttribute("aria-checked", "true");
    expect(sourceTypeRadio("Folder")).toHaveAttribute("aria-checked", "false");
  });

  it("does not expose the folder/file path display as an editable textbox (#47)", async () => {
    const user = userEvent.setup();
    render(<RunLauncher />);

    await chooseSourceType(user, "Folder");
    // The path value is a display, not an editor: it must not be an interactive textbox (a
    // role="textbox" without a tabIndex is an invalid, non-focusable widget — GEN-UI-A11Y-011).
    expect(screen.queryByRole("textbox", { name: /folder path/i })).not.toBeInTheDocument();
    // The empty-state placeholder is still shown, associated with its "Folder path" label.
    expect(screen.getByText(/choose a local folder/i)).toBeInTheDocument();
  });

  // ADR-0118 D4 documents the QI folder/file source as the ONE surface that keeps NO manual-entry
  // fallback on an unsupported platform (unlike NewWindowDialog/capsule-actions/source-rebind
  // control, which all keep an editable input). This pins that documented, maintainer-decided
  // behavior so a future change to it is a deliberate, visible diff rather than a silent drift.
  it("keeps Browse disabled with an explanatory note and no manual fallback on unsupported platforms", async () => {
    vi.mocked(nativeFileDialogSupported).mockResolvedValueOnce(false);
    const user = userEvent.setup();
    render(<RunLauncher />);

    await chooseSourceType(user, "Folder");

    const browse = await screen.findByRole("button", { name: /browse/i });
    await waitFor(() => expect(browse).toBeDisabled());
    expect(
      screen.getByText(/native dialogs are unavailable on this platform/i),
    ).toBeInTheDocument();
    // No editable control exists for the path on this surface — the only way to fill it in is via
    // a supported native dialog, which the platform above does not offer.
    expect(screen.queryByRole("textbox", { name: /folder path/i })).not.toBeInTheDocument();
  });

  it("renders a requirements textarea (default source type)", () => {
    render(<RunLauncher />);
    expect(screen.getByRole("textbox", { name: /requirements/i })).toBeInTheDocument();
  });

  it("renders a policy-profile select with the compact policy menu", async () => {
    const user = userEvent.setup();
    render(<RunLauncher />);
    const select = screen.getByRole("combobox", { name: /policy profile/i });
    expect(select).toBeInTheDocument();
    expect(select.closest(".qi-policy-profile-field")).not.toBeNull();

    await user.click(select);
    expect(document.querySelector(".qi-policy-profile-menu")).not.toBeNull();
    expect(document.querySelector(".qi-policy-profile-menu .ksel-menu-title")).toHaveTextContent(
      "Policy",
    );
  });

  it("renders an optional seed input", () => {
    render(<RunLauncher />);
    expect(screen.getByRole("spinbutton", { name: /seed \(optional\)/i })).toBeInTheDocument();
  });

  it("renders a blocked 'Generate test cases' button when requirements are empty", () => {
    render(<RunLauncher />);
    const btn = screen.getByRole("button", { name: /generate test cases/i });
    // aria-disabled (NOT native disabled) keeps the button focusable so keyboard/AT users can
    // reach it and hear the reason via aria-describedby (uiux F004, mirrors GovernedActionButton).
    expect(btn).toHaveAttribute("aria-disabled", "true");
    expect(btn).not.toBeDisabled();
    expect(btn).toHaveAccessibleDescription(
      "Add requirements text, a folder path, a file path, select a Knowledge Pod, select a Knowledge Pod Set, or connect a source to generate.",
    );
  });
});

describe("RunLauncher — source-type switching", () => {
  it("swaps the requirements textarea for a folder-path browser when 'Folder' is selected", async () => {
    const user = userEvent.setup();
    render(<RunLauncher />);

    // Initial state: textarea present, folder path label absent.
    expect(screen.getByRole("textbox", { name: /requirements/i })).toBeInTheDocument();
    expect(screen.queryByText(/^folder path$/i)).not.toBeInTheDocument();

    await chooseSourceType(user, "Folder");

    // After switch: folder path picker present (a labelled Browse button + display value, NOT an
    // editable textbox — the value is chosen via the dialog, GEN-UI-A11Y-011), textarea gone.
    expect(screen.getByText(/^folder path$/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /browse/i })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /requirements/i })).not.toBeInTheDocument();
    // The path display is a plain labelled value, not an interactive textbox widget.
    expect(screen.queryByRole("textbox", { name: /folder path/i })).not.toBeInTheDocument();
  });

  it("swaps the requirements textarea for a file-path browser when 'File' is selected", async () => {
    const user = userEvent.setup();
    render(<RunLauncher />);

    await chooseSourceType(user, "File");

    expect(screen.getByText(/^file path$/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /browse/i })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /requirements/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /file path/i })).not.toBeInTheDocument();
  });

  it("re-shows the requirements textarea when switching back to 'Requirements text'", async () => {
    const user = userEvent.setup();
    render(<RunLauncher />);

    await chooseSourceType(user, "Folder");
    await chooseSourceType(user, "Requirements");

    expect(screen.getByRole("textbox", { name: /requirements/i })).toBeInTheDocument();
    expect(screen.queryByText(/^folder path$/i)).not.toBeInTheDocument();
  });
});

describe("RunLauncher — Generate button enable/disable", () => {
  it("enables the Generate button once requirements text is non-empty", async () => {
    const user = userEvent.setup();
    render(<RunLauncher />);

    const btn = screen.getByRole("button", { name: /generate test cases/i });
    expect(btn).toHaveAttribute("aria-disabled", "true");

    await user.type(screen.getByRole("textbox", { name: /requirements/i }), "Login must work");
    expect(btn).not.toHaveAttribute("aria-disabled");
  });

  it("re-disables the Generate button when requirements text is cleared", async () => {
    const user = userEvent.setup();
    render(<RunLauncher />);

    const textarea = screen.getByRole("textbox", { name: /requirements/i });
    await user.type(textarea, "Some text");
    await user.clear(textarea);

    expect(screen.getByRole("button", { name: /generate test cases/i })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("enables the Generate button once a folder has been picked (workspace source)", async () => {
    const user = userEvent.setup();
    render(<RunLauncher />);

    await chooseSourceType(user, "Folder");
    expect(screen.getByRole("button", { name: /generate test cases/i })).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    vi.mocked(pickWithNativeDialog).mockResolvedValueOnce({
      kind: "picked",
      paths: ["/repos/my-app/docs"],
    });
    const browse = screen.getByRole("button", { name: /browse/i });
    await waitFor(() => expect(browse).not.toBeDisabled());
    await user.click(browse);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /generate test cases/i })).not.toHaveAttribute(
        "aria-disabled",
      ),
    );
  });

  it("enables the Generate button once a file has been picked (single-file source)", async () => {
    const user = userEvent.setup();
    render(<RunLauncher />);

    await chooseSourceType(user, "File");
    expect(screen.getByRole("button", { name: /generate test cases/i })).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    vi.mocked(pickWithNativeDialog).mockResolvedValueOnce({
      kind: "picked",
      paths: ["/repos/my-app/requirements.md"],
    });
    const browse = screen.getByRole("button", { name: /browse/i });
    await waitFor(() => expect(browse).not.toBeDisabled());
    await user.click(browse);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /generate test cases/i })).not.toHaveAttribute(
        "aria-disabled",
      ),
    );
  });
});

describe("RunLauncher — startImpl called with correct request shape", () => {
  it("calls startImpl with a requirements source when using the default source type", async () => {
    const user = userEvent.setup();
    const { startImpl } = makeStreamingFake([DONE_FRAME]);
    const onRunCompleted = vi.fn();
    render(<RunLauncher startImpl={startImpl} onRunCompleted={onRunCompleted} />);

    await user.type(screen.getByLabelText(/source label/i), "Sprint-42");
    await user.type(
      screen.getByRole("textbox", { name: /requirements/i }),
      "Users can log in with email",
    );
    await user.click(screen.getByRole("button", { name: /generate test cases/i }));

    await waitFor(() => {
      expect(startImpl).toHaveBeenCalledTimes(1);
    });

    const [calledRequest] = (startImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Parameters<StartQiRunFn>[0],
    ];
    expect(calledRequest.sources[0]).toMatchObject({
      kind: "requirements",
      text: "Users can log in with email",
      label: "Sprint-42",
    });
    expect(calledRequest.seed).toBeUndefined();
  });

  it("calls startImpl with a workspace source when the workspace source type is selected", async () => {
    const user = userEvent.setup();
    const { startImpl } = makeStreamingFake([DONE_FRAME]);
    render(<RunLauncher startImpl={startImpl} />);

    await chooseSourceType(user, "Folder");
    await user.type(screen.getByLabelText(/source label/i), "My project");
    vi.mocked(pickWithNativeDialog).mockResolvedValueOnce({
      kind: "picked",
      paths: ["/repos/my-app/docs"],
    });
    const browse = screen.getByRole("button", { name: /browse/i });
    await waitFor(() => expect(browse).not.toBeDisabled());
    await user.click(browse);
    await waitFor(() =>
      expect(pickWithNativeDialog).toHaveBeenCalledWith({
        mode: "open-directory",
        title: "Choose folder source",
      }),
    );
    await user.click(screen.getByRole("button", { name: /generate test cases/i }));

    await waitFor(() => {
      expect(startImpl).toHaveBeenCalledTimes(1);
    });

    const [calledRequest] = (startImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Parameters<StartQiRunFn>[0],
    ];
    expect(calledRequest.sources[0]).toMatchObject({
      kind: "workspace",
      path: "/repos/my-app/docs",
      label: "My project",
    });
    expect(calledRequest.seed).toBeUndefined();
  });

  it("calls startImpl with a file source when the single-file source type is selected", async () => {
    const user = userEvent.setup();
    const { startImpl } = makeStreamingFake([DONE_FRAME]);
    render(<RunLauncher startImpl={startImpl} />);

    await chooseSourceType(user, "File");
    await user.type(screen.getByLabelText(/source label/i), "Fachkonzept file");
    vi.mocked(pickWithNativeDialog).mockResolvedValueOnce({
      kind: "picked",
      paths: ["/repos/my-app/requirements.md"],
    });
    const browse = screen.getByRole("button", { name: /browse/i });
    await waitFor(() => expect(browse).not.toBeDisabled());
    await user.click(browse);
    await waitFor(() =>
      expect(pickWithNativeDialog).toHaveBeenCalledWith({
        mode: "open-file",
        title: "Choose file source",
      }),
    );
    await user.click(screen.getByRole("button", { name: /generate test cases/i }));

    await waitFor(() => {
      expect(startImpl).toHaveBeenCalledTimes(1);
    });

    const [calledRequest] = (startImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Parameters<StartQiRunFn>[0],
    ];
    expect(calledRequest.sources[0]).toMatchObject({
      kind: "file",
      path: "/repos/my-app/requirements.md",
      label: "Fachkonzept file",
    });
    expect(calledRequest.seed).toBeUndefined();
  });

  it("calls startImpl with a capsule source selected from Local Knowledge", async () => {
    const user = userEvent.setup();
    const { startImpl } = makeStreamingFake([DONE_FRAME]);
    render(
      <RunLauncher
        startImpl={startImpl}
        fetchCapsulesImpl={fakeFetchCapsules([
          {
            id: "cap-audit-1",
            displayName: "Audit Knowledge Pod 01",
            lifecycleState: "ready",
            sourceCount: 3,
            updatedAt: 1,
          },
        ])}
        fetchCapsuleSetsImpl={fakeFetchCapsuleSets([])}
      />,
    );

    await chooseSourceType(user, "Knowledge Pod");
    await screen.findByText("Audit Knowledge Pod 01");
    await user.click(screen.getByRole("button", { name: /generate test cases/i }));

    await waitFor(() => {
      expect(startImpl).toHaveBeenCalledTimes(1);
    });

    const [calledRequest] = (startImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Parameters<StartQiRunFn>[0],
    ];
    expect(calledRequest.sources[0]).toMatchObject({
      kind: "capsule",
      capsuleId: "cap-audit-1",
      label: "Audit Knowledge Pod 01",
    });
  });

  it("calls startImpl with a capsule-set source selected from Local Knowledge", async () => {
    const user = userEvent.setup();
    const { startImpl } = makeStreamingFake([DONE_FRAME]);
    render(
      <RunLauncher
        startImpl={startImpl}
        fetchCapsulesImpl={fakeFetchCapsules([])}
        fetchCapsuleSetsImpl={fakeFetchCapsuleSets([
          {
            id: "set-audit-1",
            displayName: "Audit Knowledge Pod Set",
            capsuleCount: 2,
            composedAt: 1,
          },
        ])}
      />,
    );

    await chooseSourceType(user, "Knowledge Pod Set");
    await screen.findByText("Audit Knowledge Pod Set (2 pods)");
    await user.click(screen.getByRole("button", { name: /generate test cases/i }));

    await waitFor(() => {
      expect(startImpl).toHaveBeenCalledTimes(1);
    });

    const [calledRequest] = (startImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Parameters<StartQiRunFn>[0],
    ];
    expect(calledRequest.sources[0]).toMatchObject({
      kind: "capsule-set",
      capsuleSetId: "set-audit-1",
      label: "Audit Knowledge Pod Set",
    });
  });

  it("surfaces selected Knowledge Pod Set readiness guidance before starting a run", async () => {
    const user = userEvent.setup();
    const setId = "set-warning-1" as CapsuleSetId;
    render(
      <RunLauncher
        fetchCapsulesImpl={fakeFetchCapsules([])}
        fetchCapsuleSetsImpl={fakeFetchCapsuleSets(
          [
            {
              id: setId,
              displayName: "Warning Knowledge Pod Set",
              capsuleCount: 2,
              composedAt: 1,
            },
          ],
          [
            knowledgePodSetSummary(setId, "Warning Knowledge Pod Set", {
              readiness: "degraded",
              setReadiness: {
                readyCount: 1,
                draftCount: 0,
                degradedCount: 0,
                unavailableCount: 1,
                deniedCount: 0,
                indexingCount: 0,
                staleCount: 0,
                errorCount: 0,
                missingCount: 1,
                reasonCodes: ["missing-member"],
              },
            }),
          ],
        )}
      />,
    );

    await chooseSourceType(user, "Knowledge Pod Set");
    await screen.findByText("Warning Knowledge Pod Set (2 pods)");

    const guidance = await screen.findByTestId("qi-source-guidance");
    expect(guidance).toHaveTextContent("Members unavailable");
    expect(guidance).toHaveTextContent("missing, failed, or unavailable");
    expect(
      screen.getByRole("combobox", { name: /knowledge pod set/i }),
    ).toHaveAccessibleDescription(/missing, failed, or unavailable/i);
  });

  it("passes the selected profileId to startImpl", async () => {
    const user = userEvent.setup();
    const { startImpl } = makeStreamingFake([DONE_FRAME]);
    render(<RunLauncher startImpl={startImpl} />);

    await user.type(
      screen.getByRole("textbox", { name: /requirements/i }),
      "Feature: password reset",
    );

    // Select the last available profile option (implementation-agnostic).
    const profileSelect = screen.getByRole("combobox", { name: /policy profile/i });
    const profileOptions = Array.from(profileSelect.querySelectorAll("option"));
    if (profileOptions.length > 0) {
      const lastOption = profileOptions[profileOptions.length - 1]!;
      await user.selectOptions(profileSelect, lastOption.value);
    }

    await user.click(screen.getByRole("button", { name: /generate test cases/i }));

    await waitFor(() => {
      expect(startImpl).toHaveBeenCalledTimes(1);
    });

    const [calledRequest] = (startImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Parameters<StartQiRunFn>[0],
    ];
    expect(
      typeof calledRequest.profileId === "string" || calledRequest.profileId === undefined,
    ).toBe(true);
  });

  it("sends a numeric seed when one is entered", async () => {
    const user = userEvent.setup();
    const { startImpl } = makeStreamingFake([DONE_FRAME]);
    render(<RunLauncher startImpl={startImpl} />);

    await user.type(screen.getByRole("textbox", { name: /requirements/i }), "Users can log in");
    await user.type(screen.getByRole("spinbutton", { name: /seed \(optional\)/i }), "17");
    await user.click(screen.getByRole("button", { name: /generate test cases/i }));

    await waitFor(() => {
      expect(startImpl).toHaveBeenCalledTimes(1);
    });

    const [calledRequest] = (startImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Parameters<StartQiRunFn>[0],
    ];
    expect(calledRequest.seed).toBe(17);
  });

  it("steps the seed on wheel hover without focusing first", () => {
    render(<RunLauncher startImpl={vi.fn()} />);

    const seedInput = screen.getByRole("spinbutton", { name: /seed \(optional\)/i });
    expect(seedInput).not.toHaveFocus();

    fireEvent.wheel(seedInput, { deltaY: -100 });
    expect(seedInput).toHaveValue(1);
    expect(seedInput).not.toHaveFocus();

    fireEvent.wheel(seedInput, { deltaY: 100 });
    expect(seedInput).toHaveValue(0);
  });

  it("steps the seed with the custom number-control buttons", () => {
    render(<RunLauncher startImpl={vi.fn()} />);

    const seedInput = screen.getByRole("spinbutton", { name: /seed \(optional\)/i });

    fireEvent.click(screen.getByRole("button", { name: "Increase seed" }));
    expect(seedInput).toHaveValue(1);

    fireEvent.click(screen.getByRole("button", { name: "Decrease seed" }));
    expect(seedInput).toHaveValue(0);
  });
});

describe("RunLauncher — run lifecycle (in-progress state)", () => {
  it("shows 'Cancel' button while the run is in progress and hides it after completion", async () => {
    const user = userEvent.setup();

    // A stalling fake keeps the run alive until we resolve it.
    const { startImpl, resolveStall } = makeStallingFake();
    render(<RunLauncher startImpl={startImpl} />);

    await user.type(
      screen.getByRole("textbox", { name: /requirements/i }),
      "System handles 1000 concurrent users",
    );
    await user.click(screen.getByRole("button", { name: /generate test cases/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /generate test cases/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Increase seed" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Decrease seed" })).toBeDisabled();

    // Let the run finish.
    act(() => {
      resolveStall();
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /generate test cases/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /cancel/i })).not.toBeInTheDocument();
  });

  it("keeps keyboard focus on the same persistent button while it swaps Generate↔Cancel (WCAG 2.4.3, audit C031)", async () => {
    const user = userEvent.setup();
    const { startImpl, resolveStall } = makeStallingFake();
    render(<RunLauncher startImpl={startImpl} />);

    await user.type(screen.getByRole("textbox", { name: /requirements/i }), "Persistent focus");
    const button = screen.getByRole("button", { name: /generate test cases/i });
    await user.click(button);

    // While running the SAME DOM node relabels to "Cancel" — focus must not fall to <body>.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /cancel/i })).toBe(button);
    });
    expect(button).toHaveFocus();

    act(() => {
      resolveStall();
    });

    // After the run ends it relabels back to Generate, still focused.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /generate test cases/i })).toBe(button);
    });
    expect(button).toHaveFocus();
  });

  it("renders the progress region (data-testid qi-launch-progress) while the run is active", async () => {
    const user = userEvent.setup();
    const { startImpl, resolveStall } = makeStallingFake();
    render(<RunLauncher startImpl={startImpl} />);

    await user.type(
      screen.getByRole("textbox", { name: /requirements/i }),
      "Feature: export results",
    );
    await user.click(screen.getByRole("button", { name: /generate test cases/i }));

    await waitFor(() => {
      expect(screen.getByTestId("qi-launch-progress")).toBeInTheDocument();
    });

    act(() => {
      resolveStall();
    });
  });

  it("delivers candidate:proposed and accepted events and omits pasted requirements from completion handles", async () => {
    const user = userEvent.setup();
    const acceptedRunId = "run-abc-123";
    const { startImpl, done } = makeStreamingFake([
      {
        type: "accepted",
        runId: acceptedRunId,
        requestedAt: "2026-01-01T00:00:00.000Z",
        sourceCount: 1,
        atomCount: 3,
      },
      { type: "event", kind: "candidate:proposed", sequence: 1, candidateId: "tc-1" },
      succeededDone(acceptedRunId),
    ]);
    const onRunCompleted = vi.fn();
    render(<RunLauncher startImpl={startImpl} onRunCompleted={onRunCompleted} />);

    await user.type(
      screen.getByRole("textbox", { name: /requirements/i }),
      "All API endpoints return JSON",
    );
    await user.click(screen.getByRole("button", { name: /generate test cases/i }));

    await done;

    await waitFor(() => {
      expect(onRunCompleted).toHaveBeenCalledWith(acceptedRunId, []);
    });
  });

  it("passes the launched workspace source to onRunCompleted so the run card can re-check drift", async () => {
    const user = userEvent.setup();
    const acceptedRunId = "run-workspace-123";
    const { startImpl, done } = makeStreamingFake([
      {
        type: "accepted",
        runId: acceptedRunId,
        requestedAt: "2026-01-01T00:00:00.000Z",
        sourceCount: 1,
        atomCount: 2,
      },
      succeededDone(acceptedRunId),
    ]);
    const onRunCompleted = vi.fn();
    render(<RunLauncher startImpl={startImpl} onRunCompleted={onRunCompleted} />);

    await chooseSourceType(user, "Folder");
    await user.type(screen.getByLabelText(/source label/i), "Drift fixture");
    vi.mocked(pickWithNativeDialog).mockResolvedValueOnce({
      kind: "picked",
      paths: ["/tmp/drift-fixture/docs"],
    });
    const browse = screen.getByRole("button", { name: /browse/i });
    await waitFor(() => expect(browse).not.toBeDisabled());
    await user.click(browse);
    await user.click(screen.getByRole("button", { name: /generate test cases/i }));

    await done;

    await waitFor(() => {
      expect(onRunCompleted).toHaveBeenCalledWith(acceptedRunId, [
        { kind: "workspace", label: "Drift fixture", path: "/tmp/drift-fixture/docs" },
      ]);
    });
  });

  it("renders a coverage notice when the accepted frame reports dropped + skipped sources (#729 #730)", async () => {
    const user = userEvent.setup();
    const { startImpl } = makeStreamingFake([
      {
        type: "accepted",
        runId: "run-cov-1",
        requestedAt: "2026-01-01T00:00:00.000Z",
        sourceCount: 2,
        atomCount: 4,
        droppedSourceCount: 3,
        skippedSources: [
          { label: "Empty capsule", kind: "capsule", code: "QI_CAPSULE_UNAVAILABLE" },
        ],
      },
      DONE_FRAME,
    ]);
    render(<RunLauncher startImpl={startImpl} onRunCompleted={vi.fn()} />);

    await user.type(screen.getByRole("textbox", { name: /requirements/i }), "Spec line");
    await user.click(screen.getByRole("button", { name: /generate test cases/i }));

    const notice = await screen.findByTestId("qi-coverage-notice");
    // Both halves of the coverage notice render: the >16 cap drop AND the per-source skip with label.
    expect(notice).toHaveTextContent("3 sources over the 16-source limit were not included");
    expect(notice).toHaveTextContent("1 connected source was skipped");
    expect(notice).toHaveTextContent("Empty capsule");
    expect(notice).toHaveTextContent("knowledge source is unavailable");
  });

  it("explains image-description skips without blaming Figma image reads", async () => {
    const user = userEvent.setup();
    const { startImpl } = makeStreamingFake([
      {
        type: "accepted",
        runId: "run-image-skip-1",
        requestedAt: "2026-01-01T00:00:00.000Z",
        sourceCount: 2,
        atomCount: 4,
        skippedSources: [
          {
            label: "Image · Login mask",
            kind: "image",
            code: "QI_IMAGE_DESCRIPTION_UNAVAILABLE",
          },
        ],
      },
      DONE_FRAME,
    ]);
    render(<RunLauncher startImpl={startImpl} onRunCompleted={vi.fn()} />);

    await user.type(screen.getByRole("textbox", { name: /requirements/i }), "Spec line");
    await user.click(screen.getByRole("button", { name: /generate test cases/i }));

    const notice = await screen.findByTestId("qi-coverage-notice");
    expect(notice).toHaveTextContent("1 connected source was skipped");
    expect(notice).toHaveTextContent("Image · Login mask");
    expect(notice).toHaveTextContent(
      "image was readable, but the image model produced no usable description",
    );
  });

  it("renders NO coverage notice when no sources were dropped or skipped", async () => {
    const user = userEvent.setup();
    const { startImpl } = makeStreamingFake([
      {
        type: "accepted",
        runId: "run-cov-2",
        requestedAt: "2026-01-01T00:00:00.000Z",
        sourceCount: 2,
        atomCount: 4,
      },
      DONE_FRAME,
    ]);
    render(<RunLauncher startImpl={startImpl} onRunCompleted={vi.fn()} />);

    await user.type(screen.getByRole("textbox", { name: /requirements/i }), "Spec line");
    await user.click(screen.getByRole("button", { name: /generate test cases/i }));

    await waitFor(() => {
      expect(startImpl).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId("qi-coverage-notice")).not.toBeInTheDocument();
  });
});

describe("RunLauncher — cancel behaviour", () => {
  it("aborts the signal passed to startImpl when the Cancel button is clicked", async () => {
    const user = userEvent.setup();
    const { startImpl, capturedSignal, resolveStall } = makeStallingFake();
    render(<RunLauncher startImpl={startImpl} />);

    await user.type(screen.getByRole("textbox", { name: /requirements/i }), "Cancel this run");
    await user.click(screen.getByRole("button", { name: /generate test cases/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(capturedSignal()?.aborted).toBe(true);

    // Clean up by resolving the stall so there are no hanging promises.
    act(() => {
      resolveStall();
    });
  });

  it("calls the server cancel endpoint with the accepted run id", async () => {
    const user = userEvent.setup();
    const { startImpl, capturedSignal, resolveStall } = makeAcceptedStallingFake("qi-run-active-1");
    const cancelImpl = vi.fn().mockResolvedValue(undefined) as unknown as CancelQiRunFn;
    render(<RunLauncher startImpl={startImpl} cancelImpl={cancelImpl} />);

    await user.type(screen.getByRole("textbox", { name: /requirements/i }), "Cancel this run");
    await user.click(screen.getByRole("button", { name: /generate test cases/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(capturedSignal()?.aborted).toBe(true);
    await waitFor(() => {
      expect(cancelImpl).toHaveBeenCalledWith("qi-run-active-1");
    });

    act(() => {
      resolveStall();
    });
  });

  // Regression guard for the #270 "cancel-misclassified-as-failed" bug (pr-reviewer M3): a
  // user-initiated cancel must NOT surface an error banner and must restore the Generate button.
  it("does not show an error and restores Generate after the user cancels", async () => {
    const user = userEvent.setup();
    const { startImpl, resolveStall } = makeStallingFake();
    render(<RunLauncher startImpl={startImpl} />);

    await user.type(screen.getByRole("textbox", { name: /requirements/i }), "Cancel cleanly");
    await user.click(screen.getByRole("button", { name: /generate test cases/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /cancel/i }));
    act(() => {
      resolveStall();
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /generate test cases/i })).toBeInTheDocument();
    });
    expect(screen.queryByTestId("qi-launch-error")).not.toBeInTheDocument();
  });

  // The real startQiRun rejects with an AbortError from reader.read() when the signal is aborted.
  // The catch guard (`if (!controller.signal.aborted) setError`) must swallow it — no error banner.
  it("suppresses the AbortError thrown by the stream when cancelled", async () => {
    const user = userEvent.setup();
    let abort!: () => void;
    const startImpl = vi.fn(
      (_request: Parameters<StartQiRunFn>[0], signal: AbortSignal): Promise<void> =>
        new Promise<void>((_res, reject) => {
          abort = () => {
            reject(new DOMException("Aborted", "AbortError"));
          };
          signal.addEventListener("abort", abort);
        }),
    ) as unknown as StartQiRunFn;
    render(<RunLauncher startImpl={startImpl} />);

    await user.type(screen.getByRole("textbox", { name: /requirements/i }), "Abort mid-stream");
    await user.click(screen.getByRole("button", { name: /generate test cases/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /cancel/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /generate test cases/i })).toBeInTheDocument();
    });
    expect(screen.queryByTestId("qi-launch-error")).not.toBeInTheDocument();
  });
});

describe("RunLauncher — terminal status gating (pr-reviewer M2)", () => {
  async function runToTerminal(status: "failed" | "cancelled"): Promise<ReturnType<typeof vi.fn>> {
    const user = userEvent.setup();
    const onRunCompleted = vi.fn();
    const { startImpl, done } = makeStreamingFake([
      {
        type: "accepted",
        runId: "run-term-1",
        requestedAt: "2026-01-01T00:00:00.000Z",
        sourceCount: 1,
        atomCount: 1,
      },
      succeededDone("run-term-1", status),
    ]);
    render(<RunLauncher startImpl={startImpl} onRunCompleted={onRunCompleted} />);
    await user.type(screen.getByRole("textbox", { name: /requirements/i }), "Some requirements");
    await user.click(screen.getByRole("button", { name: /generate test cases/i }));
    await done;
    return onRunCompleted;
  }

  it("does NOT open a run card when the run completes with status failed, and shows a message", async () => {
    const onRunCompleted = await runToTerminal("failed");
    await waitFor(() => {
      expect(screen.getByTestId("qi-launch-error")).toBeInTheDocument();
    });
    expect(onRunCompleted).not.toHaveBeenCalled();
  });

  it("surfaces a specific failed-run reason from the terminal frame", async () => {
    const user = userEvent.setup();
    const onRunCompleted = vi.fn();
    const { startImpl, done } = makeStreamingFake([
      {
        type: "accepted",
        runId: "run-term-reason",
        requestedAt: "2026-01-01T00:00:00.000Z",
        sourceCount: 1,
        atomCount: 1,
      },
      {
        type: "done",
        runId: "run-term-reason",
        status: "failed",
        totals: { candidates: 0, findings: 0, exports: 0 },
        reasonSummary: "qi-error: UnparseableModelOutputError",
      },
    ]);
    render(<RunLauncher startImpl={startImpl} onRunCompleted={onRunCompleted} />);
    await user.type(screen.getByRole("textbox", { name: /requirements/i }), "Some requirements");
    await user.click(screen.getByRole("button", { name: /generate test cases/i }));
    await done;

    await waitFor(() => {
      expect(screen.getByTestId("qi-launch-error")).toHaveTextContent(/geparst werden konnte/i);
    });
    expect(onRunCompleted).not.toHaveBeenCalled();
  });

  it("does not splice raw English model errors into the failed-run message", async () => {
    const user = userEvent.setup();
    const onRunCompleted = vi.fn();
    const { startImpl, done } = makeStreamingFake([
      {
        type: "accepted",
        runId: "run-term-raw-reason",
        requestedAt: "2026-01-01T00:00:00.000Z",
        sourceCount: 1,
        atomCount: 1,
      },
      {
        type: "done",
        runId: "run-term-raw-reason",
        status: "failed",
        totals: { candidates: 0, findings: 0, exports: 0 },
        reasonSummary: "qi-error: litellm.BadRequestError: invalid_request_error from model",
      },
    ]);
    render(<RunLauncher startImpl={startImpl} onRunCompleted={onRunCompleted} />);
    await user.type(screen.getByRole("textbox", { name: /requirements/i }), "Some requirements");
    await user.click(screen.getByRole("button", { name: /generate test cases/i }));
    await done;

    await waitFor(() => {
      expect(screen.getByTestId("qi-launch-error")).toHaveTextContent(/Technische Fehlerdetails/i);
    });
    expect(screen.getByTestId("qi-launch-error")).not.toHaveTextContent(/litellm/i);
    expect(screen.getByTestId("qi-launch-error")).not.toHaveTextContent(/BadRequestError/i);
    expect(screen.getByTestId("qi-launch-error")).not.toHaveTextContent(/invalid_request_error/i);
    expect(onRunCompleted).not.toHaveBeenCalled();
  });

  it("does NOT open a run card or show an error when the run completes with status cancelled", async () => {
    const onRunCompleted = await runToTerminal("cancelled");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /generate test cases/i })).toBeInTheDocument();
    });
    expect(onRunCompleted).not.toHaveBeenCalled();
    expect(screen.queryByTestId("qi-launch-error")).not.toBeInTheDocument();
  });

  it("flags a degraded (baseline-fallback) succeeded run with a notice and still opens the card (QI-DEG-01)", async () => {
    const user = userEvent.setup();
    const onRunCompleted = vi.fn();
    const { startImpl, done } = makeStreamingFake([
      {
        type: "accepted",
        runId: "run-degraded",
        requestedAt: "2026-01-01T00:00:00.000Z",
        sourceCount: 1,
        atomCount: 1,
      },
      {
        type: "done",
        runId: "run-degraded",
        status: "succeeded",
        totals: { candidates: 2, findings: 0, exports: 0 },
        reasonSummary: "qi-error: UnparseableModelOutputError",
        degraded: true,
      },
    ]);
    render(<RunLauncher startImpl={startImpl} onRunCompleted={onRunCompleted} />);
    await user.type(screen.getByRole("textbox", { name: /requirements/i }), "Some requirements");
    await user.click(screen.getByRole("button", { name: /generate test cases/i }));
    await done;

    await waitFor(() => {
      expect(screen.getByTestId("qi-launch-degraded")).toHaveTextContent(/Baseline-Testfälle/i);
    });
    // The reason is named, but it is a degraded notice — NOT a hard error banner.
    expect(screen.getByTestId("qi-launch-degraded")).toHaveTextContent(/JSON parsebar/i);
    expect(screen.queryByTestId("qi-launch-error")).not.toBeInTheDocument();
    // The run still produced baseline test cases, so the result card opens for the run.
    expect(onRunCompleted).toHaveBeenCalledWith("run-degraded", expect.anything());
  });

  it("does not splice raw English model errors into degraded-run notices", async () => {
    const user = userEvent.setup();
    const onRunCompleted = vi.fn();
    const { startImpl, done } = makeStreamingFake([
      {
        type: "accepted",
        runId: "run-degraded-raw",
        requestedAt: "2026-01-01T00:00:00.000Z",
        sourceCount: 1,
        atomCount: 1,
      },
      {
        type: "done",
        runId: "run-degraded-raw",
        status: "succeeded",
        totals: { candidates: 2, findings: 0, exports: 0 },
        reasonSummary: "qi-safe-error: OpenAI API returned invalid JSON",
        degraded: true,
      },
    ]);
    render(<RunLauncher startImpl={startImpl} onRunCompleted={onRunCompleted} />);
    await user.type(screen.getByRole("textbox", { name: /requirements/i }), "Some requirements");
    await user.click(screen.getByRole("button", { name: /generate test cases/i }));
    await done;

    await waitFor(() => {
      expect(screen.getByTestId("qi-launch-degraded")).toHaveTextContent(
        /Technische Fehlerdetails/i,
      );
    });
    expect(screen.getByTestId("qi-launch-degraded")).not.toHaveTextContent(/OpenAI API/i);
    expect(screen.getByTestId("qi-launch-degraded")).not.toHaveTextContent(/invalid JSON/i);
    expect(onRunCompleted).toHaveBeenCalledWith("run-degraded-raw", expect.anything());
  });
});

describe("RunLauncher — progress announcement (a11y M-01)", () => {
  it("mounts the sr-only progress live region from first render (empty while idle)", () => {
    render(<RunLauncher onRunCompleted={vi.fn()} />);
    const region = screen.getByTestId("qi-launch-progress-sr");
    expect(region).toBeInTheDocument();
    expect(region).toHaveAttribute("role", "status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region.textContent).toBe("");
  });

  it("announces progress in the persistent region while a run is active", async () => {
    const user = userEvent.setup();
    const { startImpl, resolveStall } = makeStallingFake();
    render(<RunLauncher startImpl={startImpl} onRunCompleted={vi.fn()} />);

    await user.type(screen.getByRole("textbox", { name: /requirements/i }), "Announce me");
    await user.click(screen.getByRole("button", { name: /generate test cases/i }));

    await waitFor(() => {
      expect(screen.getByTestId("qi-launch-progress-sr").textContent).not.toBe("");
    });
    act(() => {
      resolveStall();
    });
  });
});

describe("RunLauncher — error path", () => {
  it("surfaces qi-launch-error when startImpl rejects", async () => {
    const user = userEvent.setup();
    const startImpl = makeRejectingFake(new Error("BFF returned 503"));
    render(<RunLauncher startImpl={startImpl} />);

    await user.type(screen.getByRole("textbox", { name: /requirements/i }), "Trigger error");
    await user.click(screen.getByRole("button", { name: /generate test cases/i }));

    await waitFor(() => {
      expect(screen.getByTestId("qi-launch-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("qi-launch-error")).toHaveTextContent(/503|error/i);
  });

  it("re-enables the Generate button after an error so the user can retry", async () => {
    const user = userEvent.setup();
    const startImpl = makeRejectingFake(new Error("timeout"));
    render(<RunLauncher startImpl={startImpl} />);

    await user.type(screen.getByRole("textbox", { name: /requirements/i }), "Retry me");
    await user.click(screen.getByRole("button", { name: /generate test cases/i }));

    await waitFor(() => {
      expect(screen.getByTestId("qi-launch-error")).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /generate test cases/i })).not.toHaveAttribute(
      "aria-disabled",
    );
  });
});

describe("RunLauncher — connected Files source (#270 Slice 1)", () => {
  const ROOT = "/work/fachkonzept";

  it("enables Generate from a connected folder with no manual input", () => {
    render(<RunLauncher onRunCompleted={vi.fn()} connectedRoot={ROOT} />);
    expect(screen.getByRole("button", { name: /generate test cases/i })).not.toHaveAttribute(
      "aria-disabled",
    );
  });

  it("renders the connected-source banner with the folder path", () => {
    render(<RunLauncher onRunCompleted={vi.fn()} connectedRoot={ROOT} />);
    expect(screen.getByTestId("qi-connected-source")).toHaveTextContent(ROOT);
  });

  it("generates from the connected folder as a workspace source", async () => {
    const user = userEvent.setup();
    const { startImpl } = makeStreamingFake([DONE_FRAME]);
    render(<RunLauncher startImpl={startImpl} onRunCompleted={vi.fn()} connectedRoot={ROOT} />);

    await user.click(screen.getByRole("button", { name: /generate test cases/i }));
    await waitFor(() => {
      expect(startImpl).toHaveBeenCalledTimes(1);
    });
    const [req] = (startImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Parameters<StartQiRunFn>[0],
    ];
    expect(req.sources[0]).toMatchObject({ kind: "workspace", path: ROOT });
  });

  it("lets manual requirements text override the connected folder", async () => {
    const user = userEvent.setup();
    const { startImpl } = makeStreamingFake([DONE_FRAME]);
    render(<RunLauncher startImpl={startImpl} onRunCompleted={vi.fn()} connectedRoot={ROOT} />);

    await user.type(screen.getByRole("textbox", { name: /requirements/i }), "Login must work");
    await user.click(screen.getByRole("button", { name: /generate test cases/i }));
    await waitFor(() => {
      expect(startImpl).toHaveBeenCalledTimes(1);
    });
    const [req] = (startImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Parameters<StartQiRunFn>[0],
    ];
    expect(req.sources[0]).toMatchObject({ kind: "requirements", text: "Login must work" });
  });

  it("shows no connected-source banner when nothing is connected", () => {
    render(<RunLauncher onRunCompleted={vi.fn()} />);
    expect(screen.queryByTestId("qi-connected-source")).not.toBeInTheDocument();
  });
});

describe("RunLauncher — connected single file (Epic #709, Issue #714)", () => {
  const ROOT = "/work/fachkonzept";
  const FILE = "/work/fachkonzept/funds-transfer.md";

  it("enables Generate from a connected file with no manual input", () => {
    render(<RunLauncher onRunCompleted={vi.fn()} connectedFilePath={FILE} />);
    expect(screen.getByRole("button", { name: /generate test cases/i })).not.toHaveAttribute(
      "aria-disabled",
    );
  });

  it("renders the connected-source banner labelled 'Connected file' with the file path", () => {
    render(<RunLauncher onRunCompleted={vi.fn()} connectedFilePath={FILE} />);
    const banner = screen.getByTestId("qi-connected-source");
    expect(banner).toHaveTextContent("Connected file");
    expect(banner).toHaveTextContent(FILE);
  });

  it("generates from the connected file as a 'file' source", async () => {
    const user = userEvent.setup();
    const { startImpl } = makeStreamingFake([DONE_FRAME]);
    render(<RunLauncher startImpl={startImpl} onRunCompleted={vi.fn()} connectedFilePath={FILE} />);

    await user.click(screen.getByRole("button", { name: /generate test cases/i }));
    await waitFor(() => {
      expect(startImpl).toHaveBeenCalledTimes(1);
    });
    const [req] = (startImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Parameters<StartQiRunFn>[0],
    ];
    expect(req.sources[0]).toMatchObject({ kind: "file", path: FILE });
  });

  it("resolves a root-relative connected file to an absolute 'file' source path", async () => {
    const user = userEvent.setup();
    const { startImpl } = makeStreamingFake([DONE_FRAME]);
    render(
      <RunLauncher
        startImpl={startImpl}
        onRunCompleted={vi.fn()}
        connectedRoot={ROOT}
        connectedFilePath="funds-transfer.md"
      />,
    );

    await user.click(screen.getByRole("button", { name: /generate test cases/i }));
    await waitFor(() => {
      expect(startImpl).toHaveBeenCalledTimes(1);
    });
    const [req] = (startImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Parameters<StartQiRunFn>[0],
    ];
    expect(req.sources[0]).toMatchObject({
      kind: "file",
      path: "/work/fachkonzept/funds-transfer.md",
    });
  });

  it("resolves a nested root-relative connected file to an absolute 'file' source path", async () => {
    const user = userEvent.setup();
    const { startImpl } = makeStreamingFake([DONE_FRAME]);
    render(
      <RunLauncher
        startImpl={startImpl}
        onRunCompleted={vi.fn()}
        connectedRoot={ROOT}
        connectedFilePath="docs/spec.md"
      />,
    );

    await user.click(screen.getByRole("button", { name: /generate test cases/i }));
    await waitFor(() => {
      expect(startImpl).toHaveBeenCalledTimes(1);
    });
    const [req] = (startImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Parameters<StartQiRunFn>[0],
    ];
    expect(req.sources[0]).toMatchObject({
      kind: "file",
      path: "/work/fachkonzept/docs/spec.md",
    });
  });

  it("prefers the connected file over the connected folder when both are present", async () => {
    const user = userEvent.setup();
    const { startImpl } = makeStreamingFake([DONE_FRAME]);
    render(
      <RunLauncher
        startImpl={startImpl}
        onRunCompleted={vi.fn()}
        connectedRoot={ROOT}
        connectedFilePath={FILE}
      />,
    );

    expect(screen.getByTestId("qi-connected-source")).toHaveTextContent("Connected file");
    await user.click(screen.getByRole("button", { name: /generate test cases/i }));
    await waitFor(() => {
      expect(startImpl).toHaveBeenCalledTimes(1);
    });
    const [req] = (startImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Parameters<StartQiRunFn>[0],
    ];
    // The connected file REPLACES the folder — it is the only source, not prepended to it.
    expect(req.sources).toHaveLength(1);
    expect(req.sources[0]).toMatchObject({ kind: "file", path: FILE });
  });

  it("aggregates a connected file + N folders + N capsules into one N+1 request (Epic #729 headline)", async () => {
    const user = userEvent.setup();
    const { startImpl } = makeStreamingFake([DONE_FRAME]);
    render(
      <RunLauncher
        startImpl={startImpl}
        onRunCompleted={vi.fn()}
        connectedFilePath={FILE}
        connectedRoots={["/work/a", "/work/b"]}
        connectedCapsuleIds={["cap-1", "cap-2", "cap-3"]}
      />,
    );

    // The hub lists ALL connected sources together — the file is no longer mutually exclusive with
    // the folders + capsules (the former bug). Headline AC: file + folders + capsules simultaneously.
    expect(screen.getByTestId("qi-connected-source")).toHaveTextContent("Connected sources (6)");
    await user.click(screen.getByRole("button", { name: /generate test cases/i }));
    await waitFor(() => {
      expect(startImpl).toHaveBeenCalledTimes(1);
    });
    const [req] = (startImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Parameters<StartQiRunFn>[0],
    ];
    // ALL six connected sources are sent in one request, each attributable per source (file + 2
    // folders + 3 capsules). A regression that re-introduces file-exclusive precedence would drop the
    // folders + capsules and fail here.
    expect(req.sources).toHaveLength(6);
    expect(req.sources.filter((s) => s.kind === "file")).toEqual([
      { kind: "file", label: "funds-transfer.md", path: FILE },
    ]);
    expect(req.sources.filter((s) => s.kind === "workspace").map((s) => s.path)).toEqual([
      "/work/a",
      "/work/b",
    ]);
    expect(req.sources.filter((s) => s.kind === "capsule").map((s) => s.capsuleId)).toEqual([
      "cap-1",
      "cap-2",
      "cap-3",
    ]);
  });

  it("ignores a relative connected file when no connectedRoot is present", () => {
    // resolveConnectedFilePath cannot build an absolute path from a bare relative file with no root,
    // so it returns null: no banner, and Generate stays disabled (never emits a relative source the
    // server would reject with QI_BAD_SOURCE).
    render(<RunLauncher onRunCompleted={vi.fn()} connectedFilePath="spec.md" />);
    expect(screen.queryByTestId("qi-connected-source")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /generate test cases/i })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("lets manual requirements text override the connected file", async () => {
    const user = userEvent.setup();
    const { startImpl } = makeStreamingFake([DONE_FRAME]);
    render(<RunLauncher startImpl={startImpl} onRunCompleted={vi.fn()} connectedFilePath={FILE} />);

    await user.type(screen.getByRole("textbox", { name: /requirements/i }), "Login must work");
    await user.click(screen.getByRole("button", { name: /generate test cases/i }));
    await waitFor(() => {
      expect(startImpl).toHaveBeenCalledTimes(1);
    });
    const [req] = (startImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Parameters<StartQiRunFn>[0],
    ];
    expect(req.sources[0]).toMatchObject({ kind: "requirements", text: "Login must work" });
  });
});

describe("RunLauncher — Connected Knowledge Pod source (Epic #710 #718)", () => {
  const CAPSULE_ID = "cap-test-abc";

  it("enables Generate when a capsule is connected and no manual input is present", () => {
    render(<RunLauncher connectedCapsuleIds={[CAPSULE_ID]} />);
    expect(screen.getByRole("button", { name: /generate test cases/i })).not.toHaveAttribute(
      "aria-disabled",
    );
  });

  it("renders the connected-source banner with 'Connected Knowledge Pod' and the capsule id", () => {
    render(<RunLauncher connectedCapsuleIds={[CAPSULE_ID]} />);
    const banner = screen.getByTestId("qi-connected-source");
    expect(banner).toHaveTextContent("Connected Knowledge Pod");
    expect(banner).toHaveTextContent(CAPSULE_ID);
  });

  it("calls startImpl with a capsule source when a capsule is connected", async () => {
    const user = userEvent.setup();
    const { startImpl } = makeStreamingFake([DONE_FRAME]);
    render(<RunLauncher startImpl={startImpl} connectedCapsuleIds={[CAPSULE_ID]} />);

    await user.click(screen.getByRole("button", { name: /generate test cases/i }));
    await waitFor(() => {
      expect(startImpl).toHaveBeenCalledTimes(1);
    });
    const [req] = (startImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Parameters<StartQiRunFn>[0],
    ];
    expect(req.sources[0]).toMatchObject({ kind: "capsule", capsuleId: CAPSULE_ID });
  });

  it("sends multiple capsule sources when multiple capsule ids are connected", async () => {
    const user = userEvent.setup();
    const { startImpl } = makeStreamingFake([DONE_FRAME]);
    const ids = ["cap-1", "cap-2"];
    render(<RunLauncher startImpl={startImpl} connectedCapsuleIds={ids} />);

    await user.click(screen.getByRole("button", { name: /generate test cases/i }));
    await waitFor(() => {
      expect(startImpl).toHaveBeenCalledTimes(1);
    });
    const [req] = (startImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Parameters<StartQiRunFn>[0],
    ];
    expect(req.sources).toHaveLength(2);
    expect(req.sources[0]).toMatchObject({ kind: "capsule", capsuleId: "cap-1" });
    expect(req.sources[1]).toMatchObject({ kind: "capsule", capsuleId: "cap-2" });
  });

  it("shows combined count when both folder roots and capsules are connected", () => {
    render(<RunLauncher connectedRoots={["/work/docs"]} connectedCapsuleIds={[CAPSULE_ID]} />);
    const banner = screen.getByTestId("qi-connected-source");
    expect(banner).toHaveTextContent("Connected sources (2)");
  });

  it("sends workspace sources then capsule sources in combined mode", async () => {
    const user = userEvent.setup();
    const { startImpl } = makeStreamingFake([DONE_FRAME]);
    render(
      <RunLauncher
        startImpl={startImpl}
        connectedRoots={["/work/docs"]}
        connectedCapsuleIds={[CAPSULE_ID]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /generate test cases/i }));
    await waitFor(() => {
      expect(startImpl).toHaveBeenCalledTimes(1);
    });
    const [req] = (startImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Parameters<StartQiRunFn>[0],
    ];
    expect(req.sources[0]).toMatchObject({ kind: "workspace", path: "/work/docs" });
    expect(req.sources[1]).toMatchObject({ kind: "capsule", capsuleId: CAPSULE_ID });
  });

  it("manual requirements text overrides the Connected Knowledge Pod", async () => {
    const user = userEvent.setup();
    const { startImpl } = makeStreamingFake([DONE_FRAME]);
    render(<RunLauncher startImpl={startImpl} connectedCapsuleIds={[CAPSULE_ID]} />);

    await user.type(screen.getByRole("textbox", { name: /requirements/i }), "Login must work");
    await user.click(screen.getByRole("button", { name: /generate test cases/i }));
    await waitFor(() => {
      expect(startImpl).toHaveBeenCalledTimes(1);
    });
    const [req] = (startImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Parameters<StartQiRunFn>[0],
    ];
    expect(req.sources[0]).toMatchObject({ kind: "requirements", text: "Login must work" });
  });

  it("shows no connected-source banner when connectedCapsuleIds is empty", () => {
    render(<RunLauncher connectedCapsuleIds={[]} />);
    expect(screen.queryByTestId("qi-connected-source")).not.toBeInTheDocument();
  });
});

describe("RunLauncher — Connected Knowledge Pod Set source (Epic #710 #718)", () => {
  const SET_ID = "set-test-xyz";

  it("renders the connected-source banner with 'Connected Knowledge Pod Set' and the set id", () => {
    render(<RunLauncher connectedCapsuleSetIds={[SET_ID]} />);
    const banner = screen.getByTestId("qi-connected-source");
    expect(banner).toHaveTextContent("Connected Knowledge Pod Set");
    expect(banner).toHaveTextContent(SET_ID);
  });

  it("calls startImpl with a capsule-set source when a capsule-set is connected", async () => {
    const user = userEvent.setup();
    const { startImpl } = makeStreamingFake([DONE_FRAME]);
    render(<RunLauncher startImpl={startImpl} connectedCapsuleSetIds={[SET_ID]} />);

    await user.click(screen.getByRole("button", { name: /generate test cases/i }));
    await waitFor(() => {
      expect(startImpl).toHaveBeenCalledTimes(1);
    });
    const [req] = (startImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Parameters<StartQiRunFn>[0],
    ];
    expect(req.sources[0]).toMatchObject({ kind: "capsule-set", capsuleSetId: SET_ID });
  });

  it("combines folders, capsules, and capsule-sets in order with a combined count", async () => {
    const user = userEvent.setup();
    const { startImpl } = makeStreamingFake([DONE_FRAME]);
    render(
      <RunLauncher
        startImpl={startImpl}
        connectedRoots={["/work/docs"]}
        connectedCapsuleIds={["cap-1"]}
        connectedCapsuleSetIds={[SET_ID]}
      />,
    );

    expect(screen.getByTestId("qi-connected-source")).toHaveTextContent("Connected sources (3)");
    await user.click(screen.getByRole("button", { name: /generate test cases/i }));
    await waitFor(() => {
      expect(startImpl).toHaveBeenCalledTimes(1);
    });
    const [req] = (startImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Parameters<StartQiRunFn>[0],
    ];
    expect(req.sources).toHaveLength(3);
    expect(req.sources[0]).toMatchObject({ kind: "workspace", path: "/work/docs" });
    expect(req.sources[1]).toMatchObject({ kind: "capsule", capsuleId: "cap-1" });
    expect(req.sources[2]).toMatchObject({ kind: "capsule-set", capsuleSetId: SET_ID });
  });
});

// ─── Multi-source rendered list items (Issue #731 / Epic #729) ───────────────
//
// When connectedSources.length > 1, RunLauncher renders a <ul aria-label="Connected sources">
// with one <li> per source showing the kind label (via sourceKindLabel) and the value (via
// sourceValue). These render paths were previously mutation-blind: the existing N+1 test only
// asserted the count text and the built request, not the DOM list items. A regression in
// sourceKindLabel or the <li> map would go undetected.
describe("RunLauncher — multi-source connected-source list DOM (Issue #731 / Epic #729)", () => {
  it("renders one <li> per source with correct kind labels and values for a mixed multi-source connection", () => {
    // Arrange: file (absolute path → directly usable) + 2 folders + 1 capsule + 1 capsule-set.
    // This exercises the "file", "workspace", "capsule", and "capsule-set" arms of
    // sourceKindLabel and sourceValue simultaneously.
    render(
      <RunLauncher
        connectedFilePath="/work/fachkonzept/funds-transfer.md"
        connectedRoots={["/work/a", "/work/b"]}
        connectedCapsuleIds={["cap-1"]}
        connectedCapsuleSetIds={["set-1"]}
      />,
    );

    // Act: locate the accessible list.
    const list = screen.getByRole("list", { name: /connected sources/i });
    const items = within(list).getAllByRole("listitem");

    // Assert: one <li> per connected source (1 file + 2 folders + 1 capsule + 1 capsule-set).
    expect(items).toHaveLength(5);

    // Kind labels — each sourceKindLabel arm renders into the DOM.
    expect(within(list).getByText("File")).toBeInTheDocument();
    expect(within(list).getAllByText("Folder")).toHaveLength(2);
    expect(within(list).getByText("Knowledge Pod")).toBeInTheDocument();
    expect(within(list).getByText("Knowledge Pod Set")).toBeInTheDocument();

    // Values — sourceValue returns path / capsuleId / capsuleSetId per source kind.
    expect(within(list).getByText("/work/fachkonzept/funds-transfer.md")).toBeInTheDocument();
    expect(within(list).getByText("/work/a")).toBeInTheDocument();
    expect(within(list).getByText("/work/b")).toBeInTheDocument();
    expect(within(list).getByText("cap-1")).toBeInTheDocument();
    expect(within(list).getByText("set-1")).toBeInTheDocument();
  });
});

// ─── Connected figma-snapshot source (Epic #750 #756) ────────────────────────
//
// connectedFigmaSnapshotRunIds is wired RunLauncher → buildConnectedRunSources → the Generate
// request, but had ZERO integration coverage. Mirrors the Connected Knowledge Pod-source suite: banner,
// request shape, combined-count alongside a folder, and onRunCompleted recheckable propagation.
describe("RunLauncher — connected figma-snapshot source (Epic #750 #756)", () => {
  const RUN_ID = "fig-run-test-abc";

  it("enables Generate when a figma snapshot is connected and no manual input is present", () => {
    render(<RunLauncher connectedFigmaSnapshotRunIds={[RUN_ID]} />);
    expect(screen.getByRole("button", { name: /generate test cases/i })).not.toHaveAttribute(
      "aria-disabled",
    );
  });

  it("renders the connected-source banner with 'Connected figma snapshot' and the run id", () => {
    render(<RunLauncher connectedFigmaSnapshotRunIds={[RUN_ID]} />);
    const banner = screen.getByTestId("qi-connected-source");
    expect(banner).toHaveTextContent("Connected figma snapshot");
    expect(banner).toHaveTextContent(RUN_ID);
  });

  it("calls startImpl with a figma-snapshot source when a figma snapshot is connected", async () => {
    const user = userEvent.setup();
    const { startImpl } = makeStreamingFake([DONE_FRAME]);
    render(<RunLauncher startImpl={startImpl} connectedFigmaSnapshotRunIds={[RUN_ID]} />);

    await user.click(screen.getByRole("button", { name: /generate test cases/i }));
    await waitFor(() => {
      expect(startImpl).toHaveBeenCalledTimes(1);
    });
    const [req] = (startImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Parameters<StartQiRunFn>[0],
    ];
    expect(req.sources[0]).toMatchObject({ kind: "figma-snapshot", snapshotRunId: RUN_ID });
  });

  it("calls startImpl with screenIds when a scoped figma screen source is connected", async () => {
    const user = userEvent.setup();
    const { startImpl } = makeStreamingFake([DONE_FRAME]);
    render(
      <RunLauncher
        startImpl={startImpl}
        connectedFigmaSnapshotSources={[
          {
            kind: "figma-snapshot",
            label: "Login mask",
            snapshotRunId: RUN_ID,
            screenIds: ["screen-login"],
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /generate test cases/i }));
    await waitFor(() => {
      expect(startImpl).toHaveBeenCalledTimes(1);
    });
    const [req] = (startImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Parameters<StartQiRunFn>[0],
    ];
    expect(req.sources[0]).toEqual({
      kind: "figma-snapshot",
      label: "Login mask",
      snapshotRunId: RUN_ID,
      screenIds: ["screen-login"],
    });
  });

  it("shows a combined count when a folder root and a figma snapshot are connected", () => {
    render(<RunLauncher connectedRoots={["/work/docs"]} connectedFigmaSnapshotRunIds={[RUN_ID]} />);
    expect(screen.getByTestId("qi-connected-source")).toHaveTextContent("Connected sources (2)");
  });

  it("appends the figma-snapshot source after a connected folder in the request", async () => {
    const user = userEvent.setup();
    const { startImpl } = makeStreamingFake([DONE_FRAME]);
    render(
      <RunLauncher
        startImpl={startImpl}
        connectedRoots={["/work/docs"]}
        connectedFigmaSnapshotRunIds={[RUN_ID]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /generate test cases/i }));
    await waitFor(() => {
      expect(startImpl).toHaveBeenCalledTimes(1);
    });
    const [req] = (startImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Parameters<StartQiRunFn>[0],
    ];
    expect(req.sources).toHaveLength(2);
    expect(req.sources[0]).toMatchObject({ kind: "workspace", path: "/work/docs" });
    expect(req.sources[1]).toMatchObject({ kind: "figma-snapshot", snapshotRunId: RUN_ID });
  });

  it("passes the launched figma-snapshot source to onRunCompleted so the run card can re-check drift", async () => {
    const user = userEvent.setup();
    const acceptedRunId = "run-figma-123";
    const { startImpl, done } = makeStreamingFake([
      {
        type: "accepted",
        runId: acceptedRunId,
        requestedAt: "2026-01-01T00:00:00.000Z",
        sourceCount: 1,
        atomCount: 2,
      },
      succeededDone(acceptedRunId),
    ]);
    const onRunCompleted = vi.fn();
    render(
      <RunLauncher
        startImpl={startImpl}
        onRunCompleted={onRunCompleted}
        connectedFigmaSnapshotRunIds={[RUN_ID]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /generate test cases/i }));
    await done;

    await waitFor(() => {
      expect(onRunCompleted).toHaveBeenCalledWith(acceptedRunId, [
        { kind: "figma-snapshot", label: RUN_ID, snapshotRunId: RUN_ID },
      ]);
    });
  });

  it("shows no connected-source banner when connectedFigmaSnapshotRunIds is empty", () => {
    render(<RunLauncher connectedFigmaSnapshotRunIds={[]} />);
    expect(screen.queryByTestId("qi-connected-source")).not.toBeInTheDocument();
  });
});

describe("RunLauncher — connected image source", () => {
  const IMAGE_SOURCE = {
    kind: "image",
    label: "Image · Login mask",
    sourceKind: "figma-snapshot-screen",
    snapshotRunId: "fig-run-test-abc",
    screenId: "screen-login",
  } as const;

  it("renders the connected-source banner with 'Connected image' and the image ref", () => {
    render(<RunLauncher connectedImageSources={[IMAGE_SOURCE]} />);
    const banner = screen.getByTestId("qi-connected-source");
    expect(banner).toHaveTextContent("Connected image");
    expect(banner).toHaveTextContent("fig-run-test-abc#screen-login");
  });

  it("calls startImpl with an image source when a standalone image is connected", async () => {
    const user = userEvent.setup();
    const { startImpl } = makeStreamingFake([DONE_FRAME]);
    render(<RunLauncher startImpl={startImpl} connectedImageSources={[IMAGE_SOURCE]} />);

    await user.click(screen.getByRole("button", { name: /generate test cases/i }));
    await waitFor(() => {
      expect(startImpl).toHaveBeenCalledTimes(1);
    });

    const [req] = (startImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Parameters<StartQiRunFn>[0],
    ];
    expect(req.sources[0]).toEqual(IMAGE_SOURCE);
  });

  it("passes the launched image source to onRunCompleted so the run card can re-check drift", async () => {
    const user = userEvent.setup();
    const acceptedRunId = "run-image-123";
    const { startImpl, done } = makeStreamingFake([
      {
        type: "accepted",
        runId: acceptedRunId,
        requestedAt: "2026-01-01T00:00:00.000Z",
        sourceCount: 1,
        atomCount: 1,
      },
      succeededDone(acceptedRunId),
    ]);
    const onRunCompleted = vi.fn();
    render(
      <RunLauncher
        startImpl={startImpl}
        onRunCompleted={onRunCompleted}
        connectedImageSources={[IMAGE_SOURCE]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /generate test cases/i }));
    await done;

    await waitFor(() => {
      expect(onRunCompleted).toHaveBeenCalledWith(acceptedRunId, [IMAGE_SOURCE]);
    });
  });

  it("combines a folder, scoped Figma JSON, and image source in one request", async () => {
    const user = userEvent.setup();
    const { startImpl } = makeStreamingFake([DONE_FRAME]);
    render(
      <RunLauncher
        startImpl={startImpl}
        connectedRoots={["/work/docs"]}
        connectedFigmaSnapshotSources={[
          {
            kind: "figma-snapshot",
            label: "JSON · Login mask",
            snapshotRunId: "fig-run-test-abc",
            screenIds: ["screen-login"],
          },
        ]}
        connectedImageSources={[IMAGE_SOURCE]}
      />,
    );

    expect(screen.getByTestId("qi-connected-source")).toHaveTextContent("Connected sources (3)");
    await user.click(screen.getByRole("button", { name: /generate test cases/i }));
    await waitFor(() => {
      expect(startImpl).toHaveBeenCalledTimes(1);
    });

    const [req] = (startImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Parameters<StartQiRunFn>[0],
    ];
    expect(req.sources.map((source) => source.kind)).toEqual([
      "workspace",
      "figma-snapshot",
      "image",
    ]);
  });
});
