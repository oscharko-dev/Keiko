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

describe("AddRepositoryDialog — settlement after the dialog has closed", () => {
  it("reports a discarded-succeeded clone settlement, with no correlation id and no path/URL", async () => {
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
    await act(async () => {
      resolveClone({ project: PROJECT_FIXTURE });
      await clonePromise;
    });

    expect(onAdded).not.toHaveBeenCalled();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.meta).toMatchObject({
      kind: "other",
      gitClientOperation: { operation: "repository-clone", outcome: "discarded-succeeded" },
    });
    expect(diagnostics[0]?.meta?.correlationId).toBeUndefined();
    expect(diagnostics[0]?.meta?.errorKind).toBeUndefined();
    const serialized = JSON.stringify(diagnostics[0]);
    expect(serialized).not.toContain("private-repo");
    expect(serialized).not.toContain("private-destination");
    expect(serialized).not.toContain("example.test");
  });

  it("reports a discarded-failed register settlement with correlation id and error kind, never silently", async () => {
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
    expect(JSON.stringify(diagnostics[0])).not.toContain("private-existing-repo");
  });
});
