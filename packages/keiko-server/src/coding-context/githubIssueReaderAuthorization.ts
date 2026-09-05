import type { UiHandlerDeps } from "../deps.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";
import type { ServerLogLevel, ServerLogSink } from "../observability/index.js";
import { errorKindOf } from "../observability/server-log.js";
import { realpathSync } from "node:fs";

import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { readGitRemoteUrl } from "@oscharko-dev/keiko-tools/internal/git-mutation";

import { githubOwnerAndRepoFromRemoteUrl } from "../gitDelivery/branchProtectionPreflight.js";
import { deriveRepositoryId } from "../task-workspace/naming.js";
import type { GitHubCodeContextApiPort } from "./githubCodeContextConnector.js";
import { createGitHubCodeContextApiPort } from "./githubCodeContextPort.js";

/**
 * Why the GitHub issue reader was admitted or refused for one repository. A closed vocabulary, so a
 * support timeline can tell a repository that was never granted apart from one whose grant was
 * withdrawn, and both apart from a request that named no repository at all.
 */
export type GitHubIssueReaderAuthorizationDecision =
  "authorized" | "repository-unresolved" | "store-unavailable" | "no-grant" | "revoked";

/**
 * How this module reports what it decided. Shared by both entry points here — the stored-grant
 * decision and the remote resolution below — rather than duplicated per function: they carry the
 * same two things and belong to the same operation, so one correlation id threads both lines.
 */
export interface GitHubIssueReaderAuthorizationObservation {
  readonly signal?: AbortSignal | undefined;
  readonly activityLog?: ServerLogSink | undefined;
  readonly correlationId?: string | undefined;
}

/**
 * The ONE identity a grant is stored and looked up under.
 *
 * `deriveRepositoryId` digests the string it is given and documents its precondition: the root is
 * already canonical, a realpath'd directory. The three sites that key this grant did not all honour
 * that. The editor reader passes its resolved `realRoot`; the pack route passes the root its
 * authority was minted for, which for a single-root workspace with no explicit binding is the
 * client's own lexical string; and the writer keyed the registered project path as typed. A checkout
 * registered through a symlink — every project under `/tmp` on macOS is one, `/tmp` being a link to
 * `/private/tmp` — was therefore granted under one id and looked up under another, and the grant
 * never took effect. Fail-closed, and silently broken.
 *
 * Canonicalising HERE, once, is what makes the three sites one: a caller may hand in either form.
 * A root that cannot be resolved — gone, or never a directory — yields no identity at all, which
 * the reader turns into `repository-unresolved` and the writer into "not a registered repository":
 * never a fallback to the lexical digest, which would reopen the split this closes.
 */
export function githubIssueReaderRepositoryId(repositoryRoot: string): string | undefined {
  let canonical: string;
  try {
    canonical = realpathSync(repositoryRoot);
  } catch {
    return undefined;
  }
  return deriveRepositoryId(canonical);
}

function decide(
  deps: Pick<UiHandlerDeps, "store">,
  repositoryRoot: string | undefined,
): {
  readonly decision: GitHubIssueReaderAuthorizationDecision;
  readonly repositoryId?: string;
  readonly revision?: number;
} {
  if (repositoryRoot === undefined || repositoryRoot === "") {
    return { decision: "repository-unresolved" };
  }
  const repositoryId = githubIssueReaderRepositoryId(repositoryRoot);
  if (repositoryId === undefined) return { decision: "repository-unresolved" };
  // A deps graph composed without persistence must DENY, not throw. `store` is typed as required,
  // but a partially-composed graph can still reach here, and an exception on the authorization path
  // would surface as an opaque failure rather than the fail-closed refusal this decision owes its
  // caller. The decision stays distinct from "no grant" so a support timeline can tell a repository
  // nobody granted apart from a deployment whose store was never wired.
  // `store` is typed as required, so the checker treats any nullish test on it as redundant. The
  // guard is about runtime SHAPE, not the type: a partially-composed deps graph — every hand-built
  // test double included — can reach here without one, and an exception on the authorization path
  // would surface as an opaque failure instead of the fail-closed refusal this decision owes its
  // caller. The unknown-typed view states that honestly rather than silencing the rule.
  const read = (deps as { readonly store?: Partial<UiHandlerDeps["store"]> | undefined }).store
    ?.readGitHubIssueReaderAuthorization;
  if (typeof read !== "function") return { decision: "store-unavailable", repositoryId };
  const record = read(repositoryId);
  if (record === undefined) return { decision: "no-grant", repositoryId };
  return {
    decision: record.authorized ? "authorized" : "revoked",
    repositoryId,
    revision: record.revision,
  };
}

/**
 * Is the GitHub issue reader authorized for one repository?
 *
 * Issue #3385 replaces the `GITHUB_CONNECTOR_AUTHORIZED` environment variable with this
 * server-persisted answer, scoped to one local checkout. The variable was read once at process
 * launch and bound to whatever project the process started in, so a deployment could not authorize
 * one checkout without authorizing every checkout that process later opened, and revoking meant
 * restarting. The stored record is keyed by the content-free identity the task workspace derives
 * from the WORKSPACE ROOT, and is consulted per read, so a revocation takes effect on the next read.
 *
 * The scope is deliberately named precisely: this boolean is a per-checkout switch — it says
 * whether GitHub reading is turned on for this local checkout, NOT which remote repository may be
 * read. Two clones of the same remote are two separate grants. Binding a per-read decision to the
 * checkout's OWN remote repository, verified fresh on every call rather than cached at grant time,
 * is a separate, stronger guarantee that this row does not carry: see `githubRemoteOwnerAndRepoFor`
 * below, which every read path (`codingContextRoutes.ts`'s `composeCodingContextConnectors` and its
 * editor twin) resolves per request and compares against the ref through
 * `codeContextConnector.ts`'s `connectorAuthorized`. A checkout repointed to a new remote therefore
 * cannot coast on this row's boolean to read the old remote's repository: the very next read
 * re-resolves the checkout's live remote and denies any ref that no longer matches it.
 *
 * Fail-closed in every direction: no repository root, an unknown root, and no row all answer
 * `false`. Only an explicit stored grant answers `true`. Neither a browser request field nor issue
 * text can reach this decision — the only input is a server-resolved repository root.
 *
 * Every evaluation leaves body-free evidence on the activity log (ADR-0173): without it a denied
 * external read is indistinguishable in a support timeline from a missing row, a withdrawn grant, or
 * a request that never named a repository. The line carries the content-free repository id, the
 * decision and the grant's revision — never a path, a remote, or issue text.
 */
export function isGitHubIssueReaderAuthorized(
  deps: Pick<UiHandlerDeps, "store">,
  repositoryRoot: string | undefined,
  observation: GitHubIssueReaderAuthorizationObservation = {},
): boolean {
  const { decision, repositoryId, revision } = decide(deps, repositoryRoot);
  const authorized = decision === "authorized";
  const sink = observation.activityLog ?? processServerLogSink();
  sink.write({
    level: authorized ? "debug" : "info",
    category: "security",
    op: "coding-context.github-authorization.evaluated",
    correlationId: observation.correlationId ?? UNKNOWN_CORRELATION_ID,
    extra: {
      decision,
      authorized,
      ...(repositoryId === undefined ? {} : { repositoryId }),
      // Which stored grant was evaluated, so a timeline can tell one revision from the next. Absent
      // exactly when no row was read, which the decision already says.
      ...(revision === undefined ? {} : { revision }),
    },
  });
  return authorized;
}

/**
 * Build the read-only `gh api` port for ONE repository root.
 *
 * Both composition sites used to build it from `deps.preferredProjectPath`, the project the process
 * happened to start in. That made the port a launch-time snapshot: opening another repository later
 * left GitHub context unavailable however the grant was set, and where the two roots differed,
 * authorization was evaluated for one repository while `gh` was confined to another. The port is now
 * always built for the repository the caller is actually working in, so the stored grant is the only
 * thing that decides.
 */
export function gitHubCodeContextPortFor(
  repositoryRoot: string | undefined,
  processEnv: NodeJS.ProcessEnv,
): GitHubCodeContextApiPort | undefined {
  if (repositoryRoot === undefined || repositoryRoot === "") return undefined;
  return createGitHubCodeContextApiPort({
    workspace: contentFreeWorkspaceFor(repositoryRoot),
    processEnv,
  });
}

/**
 * Why the checkout resolved to a GitHub repository, or why it did not.
 *
 * The four refusals are NOT interchangeable, even though every one of them denies. Three are the
 * expected shape of a checkout that simply has no GitHub remote to read; `remote-unreadable` and
 * `resolver-failed` are operational faults. Collapsing them, as this module first did, left an
 * operator unable to tell a deployment whose `git` is broken from one that is behaving exactly as
 * designed — both were silence followed by a denied read.
 */
export type GitHubRemoteResolutionOutcome =
  | "resolved"
  | "repository-unresolved"
  | "remote-not-github"
  | "remote-redacted"
  | "remote-unreadable"
  | "resolver-failed";

// `remote-redacted` is a fault too, of a very specific kind: the read succeeded, but the spawn
// boundary replaced part of the URL with its marker because some non-allowlisted environment value
// happened to appear inside the owner or repository name. The value is then unusable, the read is
// denied, and WITHOUT its own outcome the timeline would show it as "not a GitHub remote" — which is
// exactly how a CI runner's GITHUB_REPOSITORY variable hid this once.
function isOperationalFault(outcome: GitHubRemoteResolutionOutcome): boolean {
  return (
    outcome === "remote-unreadable" ||
    outcome === "resolver-failed" ||
    outcome === "remote-redacted"
  );
}

// A fault is a warning because someone has to look at it; an expected absence is information; a
// success is debug, so a healthy deployment does not pay for a line on every read.
function levelForOutcome(outcome: GitHubRemoteResolutionOutcome): ServerLogLevel {
  if (outcome === "resolved") return "debug";
  return isOperationalFault(outcome) ? "warn" : "info";
}

/**
 * One body-free line per resolution (ADR-0173). It carries the outcome and, for a fault, the closed
 * vocabulary `errorKind` — never the root, the remote URL, or the resolved repository, any of which
 * would put a path or a customer's repository name into the log.
 */
function recordRemoteResolution(
  outcome: GitHubRemoteResolutionOutcome,
  observation: GitHubIssueReaderAuthorizationObservation,
  errorKind?: string,
): void {
  const sink = observation.activityLog ?? processServerLogSink();
  sink.write({
    level: levelForOutcome(outcome),
    category: "security",
    op: "coding-context.github-remote.evaluated",
    correlationId: observation.correlationId ?? UNKNOWN_CORRELATION_ID,
    ...(errorKind === undefined ? {} : { errorKind }),
    extra: { outcome },
  });
}

// The content-free workspace view both `gh` and `git` are given for one checkout. Declared once:
// two copies of this literal drifted apart the moment either one gained a field.
function contentFreeWorkspaceFor(repositoryRoot: string): WorkspaceInfo {
  return {
    root: repositoryRoot,
    selectedRoot: repositoryRoot,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

async function resolveThroughInjectedResolver(
  repositoryRoot: string,
  resolver: (repositoryRoot: string) => Promise<string | undefined>,
  observation: GitHubIssueReaderAuthorizationObservation,
): Promise<string | undefined> {
  try {
    const resolved = await resolver(repositoryRoot);
    recordRemoteResolution(resolved === undefined ? "remote-not-github" : "resolved", observation);
    return resolved;
  } catch (error) {
    recordRemoteResolution("resolver-failed", observation, errorKindOf(error));
    return undefined;
  }
}

/**
 * Which GitHub repository a grant for this checkout actually authorizes.
 *
 * A grant is stored against a LOCAL checkout, but the thing being read is a REMOTE repository named
 * freely by the request. Without this, a grant for checkout A authorized reading any repository the
 * `gh` credentials could reach — the subject of the grant and the resource being accessed were not
 * the same thing (CWE-863). Resolving the checkout's own remote here, per request, gives the read
 * path one repository to compare against, and a checkout later repointed at another remote resolves
 * to the new one rather than coasting on the old grant.
 *
 * Returns undefined when the checkout has no readable GitHub remote, which denies rather than
 * widens: the caller treats "no allowed repository" as "authorize nothing". Every path says on the
 * activity log WHICH of those it was, so a denial that is really a broken `git` is visible as one.
 */
export async function githubRemoteOwnerAndRepoFor(
  repositoryRoot: string | undefined,
  processEnv: NodeJS.ProcessEnv,
  resolver?: (repositoryRoot: string) => Promise<string | undefined>,
  observation: GitHubIssueReaderAuthorizationObservation = {},
): Promise<string | undefined> {
  if (repositoryRoot === undefined || repositoryRoot === "") {
    recordRemoteResolution("repository-unresolved", observation);
    return undefined;
  }
  if (resolver !== undefined) {
    return await resolveThroughInjectedResolver(repositoryRoot, resolver, observation);
  }
  let remoteUrl: string;
  try {
    remoteUrl = await readGitRemoteUrl(
      {
        workspace: contentFreeWorkspaceFor(repositoryRoot),
        processEnv,
        signal: observation.signal,
      },
      "origin",
    );
  } catch (error) {
    // The read itself failed: no repository, no `origin`, or `git` could not run. That is an
    // operational fault and is reported as one, separately from a remote that is merely not GitHub.
    recordRemoteResolution("remote-unreadable", observation, errorKindOf(error));
    return undefined;
  }
  const ownerAndRepo = githubOwnerAndRepoFromRemoteUrl(remoteUrl);
  recordRemoteResolution(unresolvedOutcomeFor(remoteUrl, ownerAndRepo), observation);
  return ownerAndRepo;
}

// The marker `runCommand` substitutes for a scrubbed environment value. Checked here only to NAME
// the outcome on the activity log; the refusal itself already comes from
// `githubOwnerAndRepoFromRemoteUrl`, whose segment rule rejects the marker's brackets.
const SPAWN_REDACTION_MARKER = "[REDACTED]";

function unresolvedOutcomeFor(
  remoteUrl: string,
  ownerAndRepo: string | undefined,
): GitHubRemoteResolutionOutcome {
  if (ownerAndRepo !== undefined) return "resolved";
  return remoteUrl.includes(SPAWN_REDACTION_MARKER) ? "remote-redacted" : "remote-not-github";
}
