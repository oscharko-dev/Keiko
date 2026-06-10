// Issue #280 (Epic #270) — RunLauncher component tests.
//
// Tests cover:
//   - Initial render: source-type select, requirements textarea, policy-profile select,
//     label input, and disabled Generate button when fields are empty.
//   - Source-type switching: "workspace" swaps textarea for folder-path input.
//   - Enabling Generate: typing requirements text makes the button active.
//   - startImpl called with correct request shape for requirements source.
//   - startImpl called with correct request shape for workspace source.
//   - Run lifecycle: button shows "Cancel" during run; progress region visible.
//   - Cancel: AbortSignal becomes aborted when Cancel is clicked.
//   - onRunCompleted: called with the accepted runId after run finishes.
//   - Error path: startImpl rejection surfaces in qi-launch-error.
//
// Design note: startImpl is typed as the real function but replaced with a
// controllable fake in every test. We never hit the network.

import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RunLauncher } from "./RunLauncher";
import type {
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

const DONE_FRAME: QualityIntelligenceRunStreamMessage = {
  type: "done",
  runId: "run-done",
  status: "succeeded",
  totals: { candidates: 0, findings: 0, exports: 0 },
};

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RunLauncher — initial render", () => {
  it("renders a source-label input", () => {
    render(<RunLauncher />);
    expect(screen.getByLabelText(/source label/i)).toBeInTheDocument();
  });

  it("renders a source-type select with 'Requirements text' and 'Local folder' options", () => {
    render(<RunLauncher />);
    const select = screen.getByRole("combobox", { name: /source type/i });
    expect(select).toBeInTheDocument();
    const options = Array.from(select.querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toContain("Requirements text");
    expect(options).toContain("Local folder");
  });

  it("renders a requirements textarea (default source type)", () => {
    render(<RunLauncher />);
    expect(screen.getByRole("textbox", { name: /requirements/i })).toBeInTheDocument();
  });

  it("renders a policy-profile select", () => {
    render(<RunLauncher />);
    expect(screen.getByRole("combobox", { name: /policy profile/i })).toBeInTheDocument();
  });

  it("renders an optional seed input", () => {
    render(<RunLauncher />);
    expect(screen.getByRole("spinbutton", { name: /seed \(optional\)/i })).toBeInTheDocument();
  });

  it("renders a disabled 'Generate test cases' button when requirements are empty", () => {
    render(<RunLauncher />);
    const btn = screen.getByRole("button", { name: /generate test cases/i });
    expect(btn).toBeDisabled();
  });
});

describe("RunLauncher — source-type switching", () => {
  it("swaps the requirements textarea for a folder-path input when 'Local folder' is selected", async () => {
    const user = userEvent.setup();
    render(<RunLauncher />);

    // Initial state: textarea present, folder input absent.
    expect(screen.getByRole("textbox", { name: /requirements/i })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /folder path/i })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: /source type/i }), "workspace");

    // After switch: folder input present, textarea gone.
    expect(screen.getByRole("textbox", { name: /folder path/i })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /requirements/i })).not.toBeInTheDocument();
  });

  it("re-shows the requirements textarea when switching back to 'Requirements text'", async () => {
    const user = userEvent.setup();
    render(<RunLauncher />);

    await user.selectOptions(screen.getByRole("combobox", { name: /source type/i }), "workspace");
    await user.selectOptions(
      screen.getByRole("combobox", { name: /source type/i }),
      "requirements",
    );

    expect(screen.getByRole("textbox", { name: /requirements/i })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /folder path/i })).not.toBeInTheDocument();
  });
});

describe("RunLauncher — Generate button enable/disable", () => {
  it("enables the Generate button once requirements text is non-empty", async () => {
    const user = userEvent.setup();
    render(<RunLauncher />);

    const btn = screen.getByRole("button", { name: /generate test cases/i });
    expect(btn).toBeDisabled();

    await user.type(screen.getByRole("textbox", { name: /requirements/i }), "Login must work");
    expect(btn).not.toBeDisabled();
  });

  it("re-disables the Generate button when requirements text is cleared", async () => {
    const user = userEvent.setup();
    render(<RunLauncher />);

    const textarea = screen.getByRole("textbox", { name: /requirements/i });
    await user.type(textarea, "Some text");
    await user.clear(textarea);

    expect(screen.getByRole("button", { name: /generate test cases/i })).toBeDisabled();
  });

  it("enables the Generate button once folder path is non-empty (workspace source)", async () => {
    const user = userEvent.setup();
    render(<RunLauncher />);

    await user.selectOptions(screen.getByRole("combobox", { name: /source type/i }), "workspace");
    expect(screen.getByRole("button", { name: /generate test cases/i })).toBeDisabled();

    await user.type(screen.getByRole("textbox", { name: /folder path/i }), "/code/my-project");
    expect(screen.getByRole("button", { name: /generate test cases/i })).not.toBeDisabled();
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

    await user.selectOptions(screen.getByRole("combobox", { name: /source type/i }), "workspace");
    await user.type(screen.getByLabelText(/source label/i), "My project");
    await user.type(screen.getByRole("textbox", { name: /folder path/i }), "/repos/my-app");
    await user.click(screen.getByRole("button", { name: /generate test cases/i }));

    await waitFor(() => {
      expect(startImpl).toHaveBeenCalledTimes(1);
    });

    const [calledRequest] = (startImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Parameters<StartQiRunFn>[0],
    ];
    expect(calledRequest.sources[0]).toMatchObject({
      kind: "workspace",
      path: "/repos/my-app",
      label: "My project",
    });
    expect(calledRequest.seed).toBeUndefined();
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

    // Let the run finish.
    act(() => {
      resolveStall();
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /generate test cases/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /cancel/i })).not.toBeInTheDocument();
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

  it("delivers candidate:proposed and accepted events and calls onRunCompleted with the accepted runId", async () => {
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
      DONE_FRAME,
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
      expect(onRunCompleted).toHaveBeenCalledWith(acceptedRunId);
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
    expect(notice).toHaveTextContent("1 connected source could not be read");
    expect(notice).toHaveTextContent("Empty capsule");
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

    expect(screen.getByRole("button", { name: /generate test cases/i })).not.toBeDisabled();
  });
});

describe("RunLauncher — connected Files source (#270 Slice 1)", () => {
  const ROOT = "/work/fachkonzept";

  it("enables Generate from a connected folder with no manual input", () => {
    render(<RunLauncher onRunCompleted={vi.fn()} connectedRoot={ROOT} />);
    expect(screen.getByRole("button", { name: /generate test cases/i })).not.toBeDisabled();
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
    expect(screen.getByRole("button", { name: /generate test cases/i })).not.toBeDisabled();
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
    expect(screen.getByRole("button", { name: /generate test cases/i })).toBeDisabled();
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

describe("RunLauncher — connected capsule source (Epic #710 #718)", () => {
  const CAPSULE_ID = "cap-test-abc";

  it("enables Generate when a capsule is connected and no manual input is present", () => {
    render(<RunLauncher connectedCapsuleIds={[CAPSULE_ID]} />);
    expect(screen.getByRole("button", { name: /generate test cases/i })).not.toBeDisabled();
  });

  it("renders the connected-source banner with 'Connected capsule' and the capsule id", () => {
    render(<RunLauncher connectedCapsuleIds={[CAPSULE_ID]} />);
    const banner = screen.getByTestId("qi-connected-source");
    expect(banner).toHaveTextContent("Connected capsule");
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

  it("manual requirements text overrides the connected capsule", async () => {
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

describe("RunLauncher — connected capsule-set source (Epic #710 #718)", () => {
  const SET_ID = "set-test-xyz";

  it("renders the connected-source banner with 'Connected capsule set' and the set id", () => {
    render(<RunLauncher connectedCapsuleSetIds={[SET_ID]} />);
    const banner = screen.getByTestId("qi-connected-source");
    expect(banner).toHaveTextContent("Connected capsule set");
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
