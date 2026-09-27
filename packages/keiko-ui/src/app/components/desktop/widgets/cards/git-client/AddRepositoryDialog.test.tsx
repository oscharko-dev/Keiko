// PR #3625 review: a completed clone/register request discarded after the dialog closed used to
// report either a generic failure-shaped message (a succeeded clone) or nothing at all (a failed
// register) — an activity-log reader could not tell a repository that was created but deliberately
// not activated from a genuinely lost result, or a discarded clone from a discarded register. These
// tests prove the structured, body-free settlement this now reports through the real
// `reportClientDiagnostic` sink, for both the success-after-close and failure-after-close paths.

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetClientDiagnosticWriter,
  setClientDiagnosticWriter,
  type ClientDiagnosticMeta,
} from "@/lib/client-diagnostics";
import { recordResponseCorrelationId } from "@/lib/bff-correlation";
import { ApiError } from "@/lib/api";
import type { ProjectWithAvailability } from "@/lib/types";
import { AddRepositoryDialog } from "./AddRepositoryDialog";
import { DEFAULT_GIT_CLIENT, type GitClientSeam } from "./git-client-seam";

const PROJECT_FIXTURE: ProjectWithAvailability = {
  path: "/repos/alpha",
  name: "alpha",
  favorite: false,
  createdAt: 0,
  lastOpenedAt: 0,
  available: true,
  workspaceAvailable: true,
};

function makeClient(overrides: Partial<GitClientSeam> = {}): GitClientSeam {
  return { ...DEFAULT_GIT_CLIENT, ...overrides };
}

interface CapturedDiagnostic {
  readonly message: string;
  readonly meta: ClientDiagnosticMeta | undefined;
}

function captureDiagnostics(): CapturedDiagnostic[] {
  const diagnostics: CapturedDiagnostic[] = [];
  setClientDiagnosticWriter((message, meta) => diagnostics.push({ message, meta }));
  return diagnostics;
}

afterEach(() => {
  resetClientDiagnosticWriter();
});

// The server stamps `X-Keiko-Correlation-Id` on every response, success included (server.ts), and
// the BFF fetch scaffold records it against the value it parsed (bff-correlation.ts; proven through
// api.ts's own scaffold in http.test.ts). This helper stands in for that scaffold (PR #3625 review).
function correlatedProjectResponse(correlationId: string): { project: ProjectWithAvailability } {
  const value = { project: PROJECT_FIXTURE };
  recordResponseCorrelationId(value, correlationId);
  return value;
}

describe("AddRepositoryDialog — settlement after the dialog has closed", () => {
  it("reports a discarded-succeeded clone settlement, with the response's correlation id and no path/URL", async () => {
    const user = userEvent.setup();
    const diagnostics = captureDiagnostics();
    let resolveClone!: (value: { project: ProjectWithAvailability }) => void;
    const clonePromise = new Promise<{ project: ProjectWithAvailability }>((resolve) => {
      resolveClone = resolve;
    });
    const client = makeClient({ cloneRepository: vi.fn(() => clonePromise) });
    const onAdded = vi.fn();
    const view = render(
      <AddRepositoryDialog
        client={client}
        onAdded={onAdded}
        onClose={vi.fn()}
        initialMode="clone"
      />,
    );
    await user.type(
      screen.getByLabelText("Repository URL"),
      "https://example.test/org/private-repo.git",
    );
    await user.type(screen.getByLabelText("Clone to folder"), "/tmp/private-destination");
    const cloneBtns = screen.getAllByRole("button", { name: "Clone repository" });
    await user.click(cloneBtns[cloneBtns.length - 1]!);
    await waitFor(() => expect(client.cloneRepository).toHaveBeenCalled());

    // The dialog closing unmounts it — the same lifecycle a parent's onClose-driven unmount
    // triggers in production (#3646) — which is what flips `closedRef.current`.
    view.unmount();
    const resolved = correlatedProjectResponse("server-echoed-clone-1");
    await act(async () => {
      resolveClone(resolved);
      await clonePromise;
    });

    expect(onAdded).not.toHaveBeenCalled();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.meta).toMatchObject({
      kind: "other",
      correlationId: "server-echoed-clone-1",
      gitClientOperation: { operation: "repository-clone", outcome: "discarded-succeeded" },
    });
    expect(diagnostics[0]?.meta?.errorKind).toBeUndefined();
    const serialized = JSON.stringify(diagnostics[0]);
    expect(serialized).not.toContain("private-repo");
    expect(serialized).not.toContain("private-destination");
    expect(serialized).not.toContain("example.test");
  });

  // A response resolved with no correlation header at all (a fixture, never a real BFF response)
  // must not crash the settlement — it simply carries no correlation id, same as before this fix.
  it("omits the correlation id when the resolved value carries none", async () => {
    const diagnostics = captureDiagnostics();
    let resolveClone!: (value: { project: ProjectWithAvailability }) => void;
    const clonePromise = new Promise<{ project: ProjectWithAvailability }>((resolve) => {
      resolveClone = resolve;
    });
    const client = makeClient({ cloneRepository: vi.fn(() => clonePromise) });
    const view = render(
      <AddRepositoryDialog
        client={client}
        onAdded={vi.fn()}
        onClose={vi.fn()}
        initialMode="clone"
      />,
    );
    await waitFor(() => expect(screen.getByLabelText("Repository URL")).toBeInTheDocument());
    view.unmount();
    await act(async () => {
      resolveClone({ project: PROJECT_FIXTURE });
      await clonePromise;
    });

    expect(diagnostics[0]?.meta?.correlationId).toBeUndefined();
  });

  it("reports a discarded-failed register settlement with correlation id, error kind and error evidence, never silently", async () => {
    const user = userEvent.setup();
    const diagnostics = captureDiagnostics();
    let rejectRegister!: (reason: unknown) => void;
    const registerPromise = new Promise<{ project: ProjectWithAvailability }>(
      (_resolve, reject) => {
        rejectRegister = reject;
      },
    );
    const client = makeClient({ registerRepository: vi.fn(() => registerPromise) });
    const onAdded = vi.fn();
    const view = render(
      <AddRepositoryDialog
        client={client}
        onAdded={onAdded}
        onClose={vi.fn()}
        initialMode="open"
      />,
    );
    await user.type(screen.getByLabelText("Local repository path"), "/tmp/private-existing-repo");
    await user.click(screen.getByRole("button", { name: "Open repository" }));
    await waitFor(() => expect(client.registerRepository).toHaveBeenCalled());

    view.unmount();
    const failure = new ApiError("INTERNAL", "boom", 500);
    failure.correlationId = "corr-register-discard-1";
    await act(async () => {
      rejectRegister(failure);
      await registerPromise.catch(() => undefined);
    });

    expect(onAdded).not.toHaveBeenCalled();
    // Before this fix a discarded failure returned silently — this is the regression pin.
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.meta).toMatchObject({
      kind: "other",
      correlationId: "corr-register-discard-1",
      errorKind: "internal",
      gitClientOperation: { operation: "repository-register", outcome: "discarded-failed" },
    });
    // Structured, body-free error evidence (PR #3625 review): the closed error class and its
    // (empty, in this fixture) dist-anchored frames and cause chain — never the error's message.
    expect(diagnostics[0]?.meta?.errorEvidence).toEqual({
      errorClass: "ApiError",
      frames: [],
      causeChain: [],
    });
    expect(JSON.stringify(diagnostics[0])).not.toContain("private-existing-repo");
    expect(JSON.stringify(diagnostics[0])).not.toContain("boom");
  });
});
