import { act, render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GitChangedFile,
  GitHistoryResponse,
  GitRepositoryDiffResponse,
  GitRepositoryStatusResponse,
} from "@oscharko-dev/keiko-contracts";

import type { CodingWorkbenchChangesClient } from "@/lib/useCodingWorkbenchChanges";
import { CodingWorkbenchChanges } from "./CodingWorkbenchChanges";

const ROOT = "/managed/repository/workspace";

function changedFile(index = 0): GitChangedFile {
  return {
    path: `src/file-${String(index).padStart(3, "0")}.ts`,
    indexStatus: " ",
    worktreeStatus: "M",
    staged: false,
    unstaged: true,
    untracked: false,
    conflicted: false,
  };
}

function status(
  files: readonly GitChangedFile[] = [changedFile()],
  available = true,
): GitRepositoryStatusResponse {
  return {
    schemaVersion: "1",
    root: ROOT,
    state: available ? "available" : "unavailable",
    available,
    detached: false,
    clean: files.length === 0,
    stagedCount: files.filter((file) => file.staged).length,
    unstagedCount: files.filter((file) => file.unstaged).length,
    untrackedCount: files.filter((file) => file.untracked).length,
    conflictedCount: files.filter((file) => file.conflicted).length,
    changes: available ? files : [],
    truncated: false,
    maxChanges: 500,
  };
}

function history(available = true): GitHistoryResponse {
  return {
    schemaVersion: "1",
    root: ROOT,
    state: available ? "available" : "unavailable",
    available,
    entries: available
      ? [
          {
            sha: "a".repeat(40),
            shortSha: "aaaaaaaa",
            subject: "fixture",
            author: "Keiko",
            date: "2026-07-19T12:00:00.000Z",
            refs: ["HEAD -> task"],
            parentCount: 1,
            changedFileCount: 1,
          },
        ]
      : [],
    limit: 1,
    skip: 0,
    truncated: false,
  };
}

function diff(path = changedFile().path): GitRepositoryDiffResponse {
  return {
    schemaVersion: "1",
    root: ROOT,
    state: "available",
    available: true,
    path,
    scope: "all",
    diff: [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1 +1 @@",
      "-export const value = 'old';",
      "+export const value = '<img src=x onerror=alert(1)>';",
      "",
    ].join("\n"),
    truncated: false,
    maxBytes: 131_072,
  };
}

function client(
  overrides: Partial<CodingWorkbenchChangesClient> = {},
): CodingWorkbenchChangesClient {
  return {
    getStatus: vi.fn(async () => status()),
    getHistory: vi.fn(async () => history()),
    getDiff: vi.fn(async (_root, path) => diff(path)),
    ...overrides,
  };
}

function renderChanges(
  changesClient: CodingWorkbenchChangesClient,
  overrides: Partial<Parameters<typeof CodingWorkbenchChanges>[0]> = {},
): ReturnType<typeof render> {
  return render(
    <CodingWorkbenchChanges
      root={ROOT}
      runId="run-2482"
      changeSignal={null}
      bindingPending={false}
      pairing="paired"
      client={changesClient}
      {...overrides}
    />,
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("CodingWorkbenchChanges", () => {
  it("renders the bound run's real per-file diff with an honest head and escaped text", async () => {
    const changesClient = client();
    const view = renderChanges(changesClient);

    expect(await screen.findByText("As of aaaaaaaa")).toBeVisible();
    expect(screen.getByRole("button", { name: /src\/file-000\.ts/u })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await waitFor(() => {
      expect(view.container.querySelector(".rv-add .rv-src")).toHaveTextContent(
        "export const value = '<img src=x onerror=alert(1)>';",
      );
    });
    expect(view.container.querySelector("img")).toBeNull();
    expect(changesClient.getStatus).toHaveBeenCalledWith(ROOT);
    expect(changesClient.getHistory).toHaveBeenCalledWith(ROOT);
    expect(changesClient.getDiff).toHaveBeenCalledWith(ROOT, "src/file-000.ts");
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it("shows the honest empty revision without requesting a diff", async () => {
    const changesClient = client({ getStatus: vi.fn(async () => status([])) });
    renderChanges(changesClient);

    expect(
      await screen.findByText("This run has no workspace changes at this revision."),
    ).toBeVisible();
    expect(screen.getByText("As of aaaaaaaa")).toBeVisible();
    expect(changesClient.getDiff).not.toHaveBeenCalled();
  });

  it("clears content and offers a retry after a bounded-read error", async () => {
    const changesClient = client({
      getStatus: vi.fn(() => Promise.reject(new Error("redacted transport failure"))),
    });
    renderChanges(changesClient);

    expect(await screen.findByRole("alert")).toHaveTextContent("could not be refreshed");
    expect(screen.getByRole("button", { name: "Refresh changes" })).toBeVisible();
    expect(changesClient.getDiff).not.toHaveBeenCalled();
  });

  it("empties the view honestly when the run binding is lost", async () => {
    const changesClient = client();
    renderChanges(changesClient, { root: null });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "task-workspace binding is no longer available",
    );
    expect(changesClient.getStatus).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Run-scoped file diff" })).not.toBeInTheDocument();
  });

  it("clears content when the managed-root session projection is unavailable", async () => {
    const changesClient = client({
      getStatus: vi.fn(async () => status([], false)),
      getHistory: vi.fn(async () => history(false)),
    });
    renderChanges(changesClient);

    expect(await screen.findByRole("alert")).toHaveTextContent("app session may need to be paired");
    expect(changesClient.getDiff).not.toHaveBeenCalled();
    expect(screen.queryByText("src/file-000.ts")).not.toBeInTheDocument();
  });

  // Release-audit F-08: the run root always lives under the managed task-workspace area, which is
  // readable only through a launcher-paired app session (ADR-0141). While the window is confirmed
  // unpaired, a read denial must name that actionable condition instead of the ambiguous denial.
  it("names the unpaired window instead of the ambiguous denial when reads are denied (F-08)", async () => {
    const changesClient = client({
      getStatus: vi.fn(async () => status([], false)),
      getHistory: vi.fn(async () => history(false)),
    });
    renderChanges(changesClient, { pairing: "unpaired" });

    expect(await screen.findByText(/Browser window not paired/u)).toBeVisible();
    expect(screen.queryByText(/may need to be paired/u)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh changes" })).not.toBeInTheDocument();
  });

  // #2843 review corrected this expectation: the pairing hint belongs to an UNAVAILABLE read (the
  // managed root is genuinely unreadable without a paired session, so retry cannot help). A
  // transport/validation ERROR can recover on its own, so it must keep the retry control even
  // while the window is unpaired — otherwise a recoverable failure is presented as one that
  // requires re-opening Keiko through the launcher.
  it("keeps a transport error retryable while the window is unpaired", async () => {
    const changesClient = client({
      getStatus: vi.fn(() => Promise.reject(new Error("redacted transport failure"))),
    });
    renderChanges(changesClient, { pairing: "unpaired" });

    expect(await screen.findByText(/could not be refreshed/u)).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh changes" })).toBeVisible();
    expect(screen.queryByText(/Browser window not paired/u)).not.toBeInTheDocument();
  });

  it("does not retarget one run to a different workspace root", async () => {
    const changesClient = client();
    const view = renderChanges(changesClient);
    expect(await screen.findByText("As of aaaaaaaa")).toBeVisible();

    view.rerender(
      <CodingWorkbenchChanges
        root="/managed/other/workspace"
        runId="run-2482"
        changeSignal="cursor-other-root"
        bindingPending={false}
        pairing="paired"
        client={changesClient}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "task-workspace binding is no longer available",
    );
    expect(view.container.querySelector(".rv-add .rv-src")).toBeNull();
    expect(changesClient.getStatus).toHaveBeenCalledTimes(1);
  });

  it("virtualizes a 500-file change set to a bounded 24 rendered file buttons", async () => {
    const files = Array.from({ length: 500 }, (_, index) => changedFile(index));
    renderChanges(client({ getStatus: vi.fn(async () => status(files)) }));

    expect(await screen.findByText("Changed files (500)")).toBeVisible();
    const fileButtons = screen
      .getAllByRole("button")
      .filter((button) => button.textContent?.includes("src/file-"));
    expect(fileButtons).toHaveLength(24);
    expect(screen.queryByText("src/file-499.ts")).not.toBeInTheDocument();
  });

  it("coalesces a burst of runtime change signals into one refresh", async () => {
    vi.useFakeTimers();
    const changesClient = client();
    const view = renderChanges(changesClient);
    await act(async () => Promise.resolve());
    await act(async () => Promise.resolve());
    expect(changesClient.getStatus).toHaveBeenCalledTimes(1);

    for (const changeSignal of ["cursor-1", "cursor-2", "cursor-3"]) {
      view.rerender(
        <CodingWorkbenchChanges
          root={ROOT}
          runId="run-2482"
          changeSignal={changeSignal}
          bindingPending={false}
          pairing="paired"
          client={changesClient}
        />,
      );
    }
    act(() => vi.advanceTimersByTime(399));
    expect(changesClient.getStatus).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    await act(async () => Promise.resolve());
    expect(changesClient.getStatus).toHaveBeenCalledTimes(2);
  });
});
