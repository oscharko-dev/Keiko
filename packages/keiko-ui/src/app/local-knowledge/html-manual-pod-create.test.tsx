// Issue #2063 — unit tests for the live HTML Manual Knowledge Pod create control. Every BFF call is
// an injected seam, so the open -> validate -> start -> poll -> settle flow runs with no network, and
// jest-axe gates both the idle button and the open form.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HtmlManualPodJob } from "@oscharko-dev/keiko-contracts";
import { HtmlManualPodCreate } from "./html-manual-pod-create";

function job(state: HtmlManualPodJob["state"]): HtmlManualPodJob {
  return {
    schemaVersion: "1",
    jobId: "job-1",
    operation: "create",
    state,
    phase: state === "running" ? "crawling" : "ready",
    capsuleId: "cap-1",
    sourceId: "src-1",
    crawl: { discovered: 3, accepted: 2, deniedCount: 1, bytesFetched: 100 },
    indexing:
      state === "running"
        ? null
        : {
            totalDocuments: 2,
            processedDocuments: 2,
            failedDocuments: 0,
            skippedDocuments: 0,
            vectorsPersisted: 5,
          },
    remediations: [],
    startedAt: 0,
    updatedAt: 0,
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function openForm(): void {
  fireEvent.click(screen.getByRole("button", { name: /add html manual/i }));
}

function startFilledCreate(): void {
  openForm();
  fill(/display name/i, "Guide");
  fill(/manual site origin/i, "https://docs.example.com");
  submit();
}

function fill(label: RegExp, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function submit(): void {
  fireEvent.click(screen.getByRole("button", { name: /create manual pod/i }));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("HtmlManualPodCreate", () => {
  it("shows the add button and has no accessibility violations", async () => {
    const { container } = render(<HtmlManualPodCreate />);
    expect(screen.getByRole("button", { name: /add html manual/i })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("opens a labelled form with no accessibility violations", async () => {
    const { container } = render(<HtmlManualPodCreate />);
    openForm();
    expect(screen.getByLabelText(/display name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/manual site origin/i)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("rejects an empty or malformed submit without calling the BFF", () => {
    const startCreateImpl = vi.fn();
    render(<HtmlManualPodCreate startCreateImpl={startCreateImpl} />);
    openForm();
    submit();
    expect(screen.getByRole("alert")).toHaveTextContent(/display name and an http/i);
    expect(startCreateImpl).not.toHaveBeenCalled();

    fill(/display name/i, "Guide");
    fill(/manual site origin/i, "not-a-url");
    submit();
    expect(startCreateImpl).not.toHaveBeenCalled();
  });

  it("starts a create with a normalized request and shows live progress", async () => {
    const startCreateImpl = vi.fn().mockResolvedValue(job("running"));
    render(<HtmlManualPodCreate startCreateImpl={startCreateImpl} />);
    openForm();
    fill(/display name/i, "  Vendor guide  ");
    fill(/manual site origin/i, "https://docs.example.com");
    submit();
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(/Creating manual pod/i);
    });
    expect(startCreateImpl).toHaveBeenCalledWith({
      displayName: "Vendor guide",
      origin: "https://docs.example.com",
      pathPrefix: null,
    });
    expect(screen.getByRole("status")).toHaveTextContent(/2 pages indexed, 1 links skipped/i);
  });

  it("passes a provided path prefix through", async () => {
    const startCreateImpl = vi.fn().mockResolvedValue(job("running"));
    render(<HtmlManualPodCreate startCreateImpl={startCreateImpl} />);
    openForm();
    fill(/display name/i, "Guide");
    fill(/manual site origin/i, "https://docs.example.com");
    fill(/path prefix/i, "/guide");
    submit();
    await waitFor(() => {
      expect(startCreateImpl).toHaveBeenCalled();
    });
    expect(startCreateImpl).toHaveBeenCalledWith({
      displayName: "Guide",
      origin: "https://docs.example.com",
      pathPrefix: "/guide",
    });
  });

  it("polls to completion and reports the terminal state exactly once", async () => {
    const startCreateImpl = vi.fn().mockResolvedValue(job("running"));
    const getJobImpl = vi.fn().mockResolvedValue(job("succeeded"));
    const onCreateComplete = vi.fn();
    render(
      <HtmlManualPodCreate
        startCreateImpl={startCreateImpl}
        getJobImpl={getJobImpl}
        onCreateComplete={onCreateComplete}
        pollIntervalMs={5}
      />,
    );
    openForm();
    fill(/display name/i, "Guide");
    fill(/manual site origin/i, "https://docs.example.com");
    submit();
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(/Manual pod created/i);
    });
    expect(getJobImpl).toHaveBeenCalledWith("job-1");
    expect(onCreateComplete).toHaveBeenCalledTimes(1);
  });

  it("keeps polling while the job is still running, then settles once", async () => {
    const startCreateImpl = vi.fn().mockResolvedValue(job("running"));
    const getJobImpl = vi
      .fn()
      .mockResolvedValueOnce(job("running"))
      .mockResolvedValue(job("succeeded"));
    const onCreateComplete = vi.fn();
    render(
      <HtmlManualPodCreate
        startCreateImpl={startCreateImpl}
        getJobImpl={getJobImpl}
        onCreateComplete={onCreateComplete}
        pollIntervalMs={5}
      />,
    );
    openForm();
    fill(/display name/i, "Guide");
    fill(/manual site origin/i, "https://docs.example.com");
    submit();
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(/Manual pod created/i);
    });
    expect(getJobImpl.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(onCreateComplete).toHaveBeenCalledTimes(1);
  });

  it("surfaces a polling failure without crashing", async () => {
    const startCreateImpl = vi.fn().mockResolvedValue(job("running"));
    const getJobImpl = vi.fn().mockRejectedValue(new Error("poll boom"));
    render(
      <HtmlManualPodCreate
        startCreateImpl={startCreateImpl}
        getJobImpl={getJobImpl}
        pollIntervalMs={5}
      />,
    );
    openForm();
    fill(/display name/i, "Guide");
    fill(/manual site origin/i, "https://docs.example.com");
    submit();
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });

  it("reports a failed job as a terminal state", async () => {
    const startCreateImpl = vi.fn().mockResolvedValue(job("running"));
    const getJobImpl = vi.fn().mockResolvedValue(job("failed"));
    render(
      <HtmlManualPodCreate
        startCreateImpl={startCreateImpl}
        getJobImpl={getJobImpl}
        pollIntervalMs={5}
      />,
    );
    openForm();
    fill(/display name/i, "Guide");
    fill(/manual site origin/i, "https://docs.example.com");
    submit();
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(/Create failed/i);
    });
  });

  it("surfaces a start failure without crashing", async () => {
    const startCreateImpl = vi.fn().mockRejectedValue(new Error("boom"));
    render(<HtmlManualPodCreate startCreateImpl={startCreateImpl} />);
    openForm();
    fill(/display name/i, "Guide");
    fill(/manual site origin/i, "https://docs.example.com");
    submit();
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });

  it("drops a poll result that resolves after unmount", async () => {
    const late = deferred<HtmlManualPodJob>();
    const getJobImpl = vi.fn().mockReturnValue(late.promise);
    const onCreateComplete = vi.fn();
    const { unmount } = render(
      <HtmlManualPodCreate
        startCreateImpl={vi.fn().mockResolvedValue(job("running"))}
        getJobImpl={getJobImpl}
        onCreateComplete={onCreateComplete}
        pollIntervalMs={5}
      />,
    );
    startFilledCreate();
    await waitFor(() => {
      expect(getJobImpl).toHaveBeenCalled();
    });
    unmount();
    late.resolve(job("succeeded"));
    await late.promise;
    expect(onCreateComplete).not.toHaveBeenCalled();
  });

  it("drops a poll rejection that arrives after unmount", async () => {
    const late = deferred<HtmlManualPodJob>();
    const getJobImpl = vi.fn().mockReturnValue(late.promise);
    const { unmount } = render(
      <HtmlManualPodCreate
        startCreateImpl={vi.fn().mockResolvedValue(job("running"))}
        getJobImpl={getJobImpl}
        pollIntervalMs={5}
      />,
    );
    startFilledCreate();
    await waitFor(() => {
      expect(getJobImpl).toHaveBeenCalled();
    });
    unmount();
    late.reject(new Error("late"));
    await late.promise.catch(() => undefined);
    expect(getJobImpl).toHaveBeenCalledTimes(1);
  });

  it("cancels the form back to the idle button", () => {
    render(<HtmlManualPodCreate />);
    openForm();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.getByRole("button", { name: /add html manual/i })).toBeInTheDocument();
  });
});
