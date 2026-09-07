import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitHubIssueReaderAuthorizationWire } from "@oscharko-dev/keiko-contracts";

import { ApiError } from "@/lib/api";
import {
  resetClientDiagnosticWriter,
  setClientDiagnosticWriter,
  type ClientDiagnosticMeta,
} from "@/lib/client-diagnostics";
import {
  useGitHubIssueReaderAuthorization,
  type GitHubIssueReaderAuthorization,
  type GitHubIssueReaderAuthorizationOptions,
} from "./useGitHubIssueReaderAuthorization";

const REPOSITORY_ID = "f".repeat(64);

function grant(authorized: boolean, revision: number): GitHubIssueReaderAuthorizationWire {
  return { repositoryId: REPOSITORY_ID, authorized, revision };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail): void => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function conflict(): ApiError {
  const error = new ApiError("CONFLICT", "GitHub issue access changed. Reload and retry.", 409);
  error.correlationId = "corr-409";
  return error;
}

function unknownRepository(): ApiError {
  return new ApiError("UNKNOWN_REPOSITORY", "Open the repository first.", 409);
}

function useHook(
  repositoryPath: string | null,
  options: GitHubIssueReaderAuthorizationOptions,
): GitHubIssueReaderAuthorization {
  return useGitHubIssueReaderAuthorization(repositoryPath, options);
}

afterEach((): void => {
  resetClientDiagnosticWriter();
});

describe("useGitHubIssueReaderAuthorization", (): void => {
  it("hydrates the server-confirmed grant for the named repository", async (): Promise<void> => {
    const load = vi.fn((): Promise<GitHubIssueReaderAuthorizationWire> =>
      Promise.resolve(grant(true, 4)),
    );
    const view = renderHook((): GitHubIssueReaderAuthorization => useHook("/repos/a", { load }));

    expect(view.result.current.pending).toBe(true);
    await waitFor((): void => expect(view.result.current.pending).toBe(false));

    expect(load).toHaveBeenCalledWith("/repos/a", expect.any(AbortSignal));
    expect(view.result.current).toMatchObject({
      repositoryId: REPOSITORY_ID,
      authorized: true,
      revision: 4,
      error: null,
    });
  });

  it("reports no repository, fail-closed, without a request when the path is null", (): void => {
    const load = vi.fn((): Promise<GitHubIssueReaderAuthorizationWire> =>
      Promise.resolve(grant(true, 1)),
    );
    const view = renderHook((): GitHubIssueReaderAuthorization => useHook(null, { load }));

    expect(load).not.toHaveBeenCalled();
    expect(view.result.current).toMatchObject({
      repositoryId: null,
      authorized: false,
      revision: 0,
      pending: false,
      error: null,
    });
  });

  it("persists a change with the last-read revision and adopts the server projection", async (): Promise<void> => {
    const load = vi.fn((): Promise<GitHubIssueReaderAuthorizationWire> =>
      Promise.resolve(grant(false, 2)),
    );
    const persist = vi.fn(
      (input: {
        readonly authorized: boolean;
        readonly expectedRevision: number;
      }): Promise<GitHubIssueReaderAuthorizationWire> =>
        Promise.resolve(grant(input.authorized, input.expectedRevision + 1)),
    );
    const view = renderHook((): GitHubIssueReaderAuthorization =>
      useHook("/repos/a", { load, persist }),
    );
    await waitFor((): void => expect(view.result.current.pending).toBe(false));

    act((): void => view.result.current.change(true));
    expect(view.result.current.pending).toBe(true);
    await waitFor((): void => expect(view.result.current.pending).toBe(false));

    expect(persist).toHaveBeenCalledWith(
      { repositoryPath: "/repos/a", authorized: true, expectedRevision: 2 },
      expect.any(AbortSignal),
    );
    expect(view.result.current).toMatchObject({ authorized: true, revision: 3, error: null });
  });

  it("re-reads the server state on a 409 revision conflict and names the conflict", async (): Promise<void> => {
    const load = vi
      .fn<() => Promise<GitHubIssueReaderAuthorizationWire>>()
      .mockResolvedValueOnce(grant(false, 2))
      .mockResolvedValueOnce(grant(true, 5));
    const persist = vi.fn((): Promise<GitHubIssueReaderAuthorizationWire> =>
      Promise.reject(conflict()),
    );
    const diagnostics: { message: string; meta: ClientDiagnosticMeta | undefined }[] = [];
    setClientDiagnosticWriter((message, meta) => {
      diagnostics.push({ message, meta });
    });
    const view = renderHook((): GitHubIssueReaderAuthorization =>
      useHook("/repos/a", { load, persist }),
    );
    await waitFor((): void => expect(view.result.current.pending).toBe(false));

    act((): void => view.result.current.change(true));
    await waitFor((): void => expect(view.result.current.error).toBe("conflict"));
    await waitFor((): void => expect(view.result.current.pending).toBe(false));

    // The re-read is the recovery: the surface shows what the server now holds, never the
    // optimistic value, and the operator decides again against the fresh revision.
    expect(load).toHaveBeenCalledTimes(2);
    expect(view.result.current).toMatchObject({ authorized: true, revision: 5 });
    // Body-free diagnostic: the failure class and the correlation id, never the path.
    expect(diagnostics).toEqual([
      {
        message: "[keiko] github issue reader grant conflict: ApiError",
        meta: { correlationId: "corr-409" },
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("/repos/a");
  });

  it("names an unregistered repository instead of a generic failure", async (): Promise<void> => {
    const load = vi.fn((): Promise<GitHubIssueReaderAuthorizationWire> =>
      Promise.reject(unknownRepository()),
    );
    const view = renderHook((): GitHubIssueReaderAuthorization => useHook("/repos/a", { load }));

    await waitFor((): void => expect(view.result.current.pending).toBe(false));

    expect(view.result.current).toMatchObject({
      error: "unknown-repository",
      authorized: false,
      repositoryId: null,
    });
  });

  it("keeps the last server-confirmed grant when persistence fails", async (): Promise<void> => {
    const load = vi.fn((): Promise<GitHubIssueReaderAuthorizationWire> =>
      Promise.resolve(grant(true, 7)),
    );
    const persist = vi.fn((): Promise<GitHubIssueReaderAuthorizationWire> =>
      Promise.reject(new Error("denied")),
    );
    const view = renderHook((): GitHubIssueReaderAuthorization =>
      useHook("/repos/a", { load, persist }),
    );
    await waitFor((): void => expect(view.result.current.pending).toBe(false));

    act((): void => view.result.current.change(false));
    await waitFor((): void => expect(view.result.current.error).toBe("persist"));

    expect(view.result.current).toMatchObject({ authorized: true, revision: 7, pending: false });
  });

  it("surfaces a hydration failure while staying fail-closed", async (): Promise<void> => {
    const load = vi.fn((): Promise<GitHubIssueReaderAuthorizationWire> =>
      Promise.reject(new Error("unavailable")),
    );
    const view = renderHook((): GitHubIssueReaderAuthorization => useHook("/repos/a", { load }));

    await waitFor((): void => expect(view.result.current.pending).toBe(false));

    expect(view.result.current).toMatchObject({
      error: "hydrate",
      authorized: false,
      repositoryId: null,
    });
  });

  it("ignores a stale hydration for a repository the surface has moved off", async (): Promise<void> => {
    const first = deferred<GitHubIssueReaderAuthorizationWire>();
    const load = vi.fn((path: string): Promise<GitHubIssueReaderAuthorizationWire> =>
      path === "/repos/a" ? first.promise : Promise.resolve(grant(false, 1)),
    );
    const view = renderHook(
      ({ path }: { readonly path: string }): GitHubIssueReaderAuthorization =>
        useHook(path, { load }),
      { initialProps: { path: "/repos/a" } },
    );

    view.rerender({ path: "/repos/b" });
    await waitFor((): void => expect(view.result.current.pending).toBe(false));
    await act(async (): Promise<void> => {
      first.resolve(grant(true, 9));
      await first.promise;
    });

    expect(view.result.current).toMatchObject({ authorized: false, revision: 1 });
  });

  it("refuses a change while no repository is named and while a request is pending", async (): Promise<void> => {
    const persist = vi.fn((): Promise<GitHubIssueReaderAuthorizationWire> =>
      Promise.resolve(grant(true, 1)),
    );
    const none = renderHook((): GitHubIssueReaderAuthorization => useHook(null, { persist }));
    act((): void => none.result.current.change(true));
    expect(persist).not.toHaveBeenCalled();

    const hydration = deferred<GitHubIssueReaderAuthorizationWire>();
    const load = vi.fn((): Promise<GitHubIssueReaderAuthorizationWire> => hydration.promise);
    const pending = renderHook((): GitHubIssueReaderAuthorization =>
      useHook("/repos/a", { load, persist }),
    );
    act((): void => pending.result.current.change(true));
    expect(persist).not.toHaveBeenCalled();
    await act(async (): Promise<void> => {
      hydration.resolve(grant(false, 0));
      await hydration.promise;
    });
  });

  it("does not publish a result that settles after unmount", async (): Promise<void> => {
    const persistence = deferred<GitHubIssueReaderAuthorizationWire>();
    const load = vi.fn((): Promise<GitHubIssueReaderAuthorizationWire> =>
      Promise.resolve(grant(false, 0)),
    );
    const persist = vi.fn((): Promise<GitHubIssueReaderAuthorizationWire> => persistence.promise);
    const view = renderHook((): GitHubIssueReaderAuthorization =>
      useHook("/repos/a", { load, persist }),
    );
    await waitFor((): void => expect(view.result.current.pending).toBe(false));

    act((): void => view.result.current.change(true));
    view.unmount();
    await act(async (): Promise<void> => {
      persistence.resolve(grant(true, 1));
      await persistence.promise;
    });

    expect(persist).toHaveBeenCalledTimes(1);
  });
});
