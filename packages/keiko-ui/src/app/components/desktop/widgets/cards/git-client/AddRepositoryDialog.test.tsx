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
import { AddRepositoryDialog, examplePath } from "./AddRepositoryDialog";
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

// #4491 (Windows 1.5.9 lab): the path fields showed a macOS path on Windows.
describe("AddRepositoryDialog example paths", () => {
  it("shows a drive path in a Windows browser and a POSIX path elsewhere", () => {
    const windows = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
    const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15";
    expect(examplePath("existing-repo", windows)).toBe("C:\\Users\\me\\Work\\existing-repo");
    expect(examplePath("existing-repo", mac)).toBe("/Users/me/Work/existing-repo");
  });

  it("uses the browser's own form in the local path field", () => {
    render(
      <AddRepositoryDialog
        client={makeClient()}
        onAdded={vi.fn()}
        onClose={vi.fn()}
        initialMode="open"
      />,
    );
    expect(screen.getByLabelText("Local repository path")).toHaveAttribute(
      "placeholder",
      examplePath("existing-repo"),
    );
  });
});

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
    // Modal stages share this sink; only Git events belong to the request's settlement sequence.
    const operations = diagnostics.filter(({ meta }) => meta?.gitClientOperation !== undefined);
    expect(operations).toHaveLength(2);
    expect(operations[0]?.meta?.gitClientOperation).toEqual({
      operation: "repository-clone",
      outcome: "started",
    });
    expect(operations[1]?.meta).toMatchObject({
      kind: "other",
      correlationId: "server-echoed-clone-1",
      gitClientOperation: { operation: "repository-clone", outcome: "discarded-succeeded" },
    });
    expect(operations[1]?.meta?.errorKind).toBeUndefined();
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain("private-repo");
    expect(serialized).not.toContain("private-destination");
    expect(serialized).not.toContain("example.test");
  });

  it("retains the attempt's correlation id when the resolved value carries no header", async () => {
    const user = userEvent.setup();
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
    await user.type(screen.getByLabelText("Repository URL"), "https://example.test/repo.git");
    await user.type(screen.getByLabelText("Clone to folder"), "/tmp/repo");
    await user.click(screen.getAllByRole("button", { name: "Clone repository" }).at(-1)!);
    expect(client.cloneRepository).toHaveBeenCalledOnce();
    view.unmount();
    await act(async () => {
      resolveClone({ project: PROJECT_FIXTURE });
      await clonePromise;
    });

    const operations = diagnostics.filter(({ meta }) => meta?.gitClientOperation !== undefined);
    expect(operations).toHaveLength(2);
    expect(operations[0]?.meta?.correlationId).toEqual(expect.any(String));
    expect(operations[1]?.meta?.correlationId).toBe(operations[0]?.meta?.correlationId);
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
    const operations = diagnostics.filter(({ meta }) => meta?.gitClientOperation !== undefined);
    expect(operations).toHaveLength(2);
    expect(operations[0]?.meta?.gitClientOperation).toEqual({
      operation: "repository-register",
      outcome: "started",
    });
    expect(operations[1]?.meta).toMatchObject({
      kind: "other",
      correlationId: "corr-register-discard-1",
      errorKind: "internal",
      gitClientOperation: { operation: "repository-register", outcome: "discarded-failed" },
    });
    // Structured, body-free error evidence (PR #3625 review): the closed error class and its
    // (empty, in this fixture) dist-anchored frames and cause chain — never the error's message.
    expect(operations[1]?.meta?.errorEvidence).toEqual({
      errorClass: "ApiError",
      frames: [],
      causeChain: [],
    });
    expect(JSON.stringify(diagnostics)).not.toContain("private-existing-repo");
    expect(JSON.stringify(diagnostics)).not.toContain("boom");
  });
});

describe("AddRepositoryDialog — Enter submits like the primary button (#4491)", () => {
  it("registers a typed local path once on Enter", async () => {
    const user = userEvent.setup();
    const registerRepository = vi.fn(() => Promise.resolve({ project: PROJECT_FIXTURE }));
    const onAdded = vi.fn();
    render(
      <AddRepositoryDialog
        client={makeClient({ registerRepository })}
        onAdded={onAdded}
        onClose={vi.fn()}
        initialMode="open"
      />,
    );
    await user.type(screen.getByLabelText("Local repository path"), "/repos/alpha{Enter}");
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(registerRepository).toHaveBeenCalledTimes(1);
    expect(registerRepository).toHaveBeenCalledWith({ path: "/repos/alpha" }, expect.any(String));
  });

  it("clones once on Enter from the destination field", async () => {
    const user = userEvent.setup();
    const cloneRepository = vi.fn(() => Promise.resolve({ project: PROJECT_FIXTURE }));
    render(
      <AddRepositoryDialog
        client={makeClient({ cloneRepository })}
        onAdded={vi.fn()}
        onClose={vi.fn()}
        initialMode="clone"
      />,
    );
    await user.type(screen.getByLabelText("Repository URL"), "https://example.test/o/r.git");
    await user.type(screen.getByLabelText("Clone to folder"), "/work/r{Enter}");
    await waitFor(() => expect(cloneRepository).toHaveBeenCalledTimes(1));
  });

  it("does nothing on Enter with an empty path", async () => {
    const user = userEvent.setup();
    const registerRepository = vi.fn(() => Promise.resolve({ project: PROJECT_FIXTURE }));
    render(
      <AddRepositoryDialog
        client={makeClient({ registerRepository })}
        onAdded={vi.fn()}
        onClose={vi.fn()}
        initialMode="open"
      />,
    );
    await user.type(screen.getByLabelText("Local repository path"), "   {Enter}");
    expect(registerRepository).not.toHaveBeenCalled();
  });

  it("never submits twice on Enter while a request is in flight", async () => {
    const user = userEvent.setup();
    const registerRepository = vi.fn(
      () => new Promise<{ project: ProjectWithAvailability }>(() => undefined),
    );
    render(
      <AddRepositoryDialog
        client={makeClient({ registerRepository })}
        onAdded={vi.fn()}
        onClose={vi.fn()}
        initialMode="open"
      />,
    );
    const field = screen.getByLabelText("Local repository path");
    await user.type(field, "/repos/alpha{Enter}");
    await user.type(field, "{Enter}");
    expect(registerRepository).toHaveBeenCalledTimes(1);
  });
});
