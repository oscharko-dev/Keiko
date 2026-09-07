"use client";

// The per-checkout GitHub issue reader grant (#3385), as a settings-surface hook.
//
// Mirrors `useAutonomyModePolicy`'s posture: the server is the only source of truth, every read and
// write is revision-checked, and a surface never projects an optimistic value. Where the autonomy
// policy is ONE product-wide value shared by several mounted surfaces (hence its module-level
// intent queue), the grant is keyed by repository and owned by one control, so the guards here are
// per-hook: a sequence number retires every superseded read or write, and an unmounted hook
// publishes nothing. A 409 `CONFLICT` is not a failure to retry blind — the server's revision moved
// under the control — so the hook re-reads and shows what the server now holds, and the operator
// decides again against the fresh revision.

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  GitHubIssueReaderAuthorizationWire,
  UpdateGitHubIssueReaderAuthorizationWire,
} from "@oscharko-dev/keiko-contracts";
import {
  ApiError,
  fetchGitHubIssueReaderAuthorization,
  updateGitHubIssueReaderAuthorization,
} from "@/lib/api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorSummary, correlationIdOf } from "@/lib/client-error-summary";

type GitHubIssueReaderAuthorizationError =
  "hydrate" | "persist" | "conflict" | "unknown-repository" | null;

export interface GitHubIssueReaderAuthorization {
  /** The content-free repository identity the server keyed the grant on; null until confirmed. */
  readonly repositoryId: string | null;
  /** Fail-closed: false until the server confirms a grant. */
  readonly authorized: boolean;
  readonly revision: number;
  readonly pending: boolean;
  readonly error: GitHubIssueReaderAuthorizationError;
  readonly change: (authorized: boolean) => void;
  readonly reload: () => void;
}

type LoadGitHubIssueReaderAuthorization = (
  repositoryPath: string,
  signal?: AbortSignal,
) => Promise<GitHubIssueReaderAuthorizationWire>;

type PersistGitHubIssueReaderAuthorization = (
  input: UpdateGitHubIssueReaderAuthorizationWire,
  signal?: AbortSignal,
) => Promise<GitHubIssueReaderAuthorizationWire>;

export interface GitHubIssueReaderAuthorizationOptions {
  readonly load?: LoadGitHubIssueReaderAuthorization;
  readonly persist?: PersistGitHubIssueReaderAuthorization;
}

interface GrantState {
  readonly repositoryId: string | null;
  readonly authorized: boolean;
  readonly revision: number;
}

const NO_GRANT: GrantState = { repositoryId: null, authorized: false, revision: 0 };

function isConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === "CONFLICT";
}

function isUnknownRepository(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === "UNKNOWN_REPOSITORY";
}

function projected(wire: GitHubIssueReaderAuthorizationWire): GrantState {
  return { repositoryId: wire.repositoryId, authorized: wire.authorized, revision: wire.revision };
}

// Body-free: the failure CLASS and the correlation id. The repository path is a filesystem path
// and never leaves the request.
function diagnose(stage: "read" | "write" | "conflict", error: unknown): void {
  reportClientDiagnostic(
    `[keiko] github issue reader grant ${stage}: ${clientErrorSummary(error)}`,
    { correlationId: correlationIdOf(error) },
  );
}

interface GrantController {
  readonly state: GrantState;
  readonly pending: boolean;
  readonly error: GitHubIssueReaderAuthorizationError;
  readonly read: (repositoryPath: string, after?: GitHubIssueReaderAuthorizationError) => void;
  readonly nextSequence: () => number;
  readonly current: (sequence: number) => boolean;
  readonly setPending: (pending: boolean) => void;
  readonly setError: (error: GitHubIssueReaderAuthorizationError) => void;
  readonly setState: (state: GrantState) => void;
}

// The read path, shared by hydration, `reload`, and the post-conflict re-read. `after` is the error
// the re-read is recovering from: a successful re-read after a conflict keeps naming the conflict,
// because the operator still has to learn that their change did not apply.
function useGrantController(
  load: LoadGitHubIssueReaderAuthorization,
  repositoryPath: string | null,
): GrantController {
  const [state, setState] = useState<GrantState>(NO_GRANT);
  const [pending, setPending] = useState(repositoryPath !== null);
  const [error, setError] = useState<GitHubIssueReaderAuthorizationError>(null);
  const sequence = useRef(0);
  const mounted = useRef(true);
  useEffect((): (() => void) => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
      sequence.current += 1;
    };
  }, []);
  const nextSequence = useCallback((): number => (sequence.current += 1), []);
  const current = useCallback(
    (request: number): boolean => mounted.current && request === sequence.current,
    [],
  );
  const read = useCallback(
    (path: string, after: GitHubIssueReaderAuthorizationError = null): void => {
      const request = nextSequence();
      const controller = new AbortController();
      setPending(true);
      setError(after);
      load(path, controller.signal)
        .then((wire): void => {
          if (!current(request)) return;
          setState(projected(wire));
          setError(after);
        })
        .catch((error_: unknown): void => {
          if (!current(request)) return;
          diagnose("read", error_);
          setState(NO_GRANT);
          setError(isUnknownRepository(error_) ? "unknown-repository" : "hydrate");
        })
        .finally((): void => {
          if (current(request)) setPending(false);
        });
    },
    [current, load, nextSequence],
  );
  return { state, pending, error, read, nextSequence, current, setPending, setError, setState };
}

function persistFailureError(error: unknown): GitHubIssueReaderAuthorizationError {
  if (isUnknownRepository(error)) return "unknown-repository";
  return "persist";
}

// The write path. Refused outright while no repository is named or a request is in flight: the
// echoed revision is only meaningful against a settled read, and two writes racing each other would
// hand the server one stale revision on purpose.
function useGrantChange(
  grant: GrantController,
  persist: PersistGitHubIssueReaderAuthorization,
  repositoryPath: string | null,
): (authorized: boolean) => void {
  const { read, nextSequence, current, setPending, setError, setState } = grant;
  const { pending } = grant;
  const { revision } = grant.state;
  return useCallback(
    (authorized: boolean): void => {
      if (repositoryPath === null || pending) return;
      const request = nextSequence();
      const controller = new AbortController();
      setPending(true);
      setError(null);
      persist({ repositoryPath, authorized, expectedRevision: revision }, controller.signal)
        .then((wire): void => {
          if (!current(request)) return;
          setState(projected(wire));
          setPending(false);
        })
        .catch((error_: unknown): void => {
          if (!current(request)) return;
          if (isConflict(error_)) {
            diagnose("conflict", error_);
            read(repositoryPath, "conflict");
            return;
          }
          diagnose("write", error_);
          setError(persistFailureError(error_));
          setPending(false);
        });
    },
    [
      current,
      nextSequence,
      pending,
      persist,
      read,
      repositoryPath,
      revision,
      setError,
      setPending,
      setState,
    ],
  );
}

export function useGitHubIssueReaderAuthorization(
  repositoryPath: string | null,
  options: GitHubIssueReaderAuthorizationOptions = {},
): GitHubIssueReaderAuthorization {
  const load = options.load ?? fetchGitHubIssueReaderAuthorization;
  const persist = options.persist ?? updateGitHubIssueReaderAuthorization;
  const grant = useGrantController(load, repositoryPath);
  const { read, nextSequence, setPending, setError, setState } = grant;

  // Hydrate for the named repository; a path change retires the previous read. No repository
  // means nothing to read and nothing to grant — the control states that instead of guessing.
  useEffect((): void => {
    if (repositoryPath === null) {
      nextSequence();
      setState(NO_GRANT);
      setError(null);
      setPending(false);
      return;
    }
    read(repositoryPath);
  }, [nextSequence, read, repositoryPath, setError, setPending, setState]);

  const change = useGrantChange(grant, persist, repositoryPath);

  const reload = useCallback((): void => {
    if (repositoryPath !== null) read(repositoryPath);
  }, [read, repositoryPath]);

  return {
    repositoryId: grant.state.repositoryId,
    authorized: grant.state.authorized,
    revision: grant.state.revision,
    pending: grant.pending,
    error: grant.error,
    change,
    reload,
  };
}
