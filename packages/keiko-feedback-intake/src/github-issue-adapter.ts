import {
  isFeedbackPublicationTargetPolicySnapshotV1,
  type FeedbackPublicationTargetPolicySnapshotV1,
} from "@oscharko-dev/keiko-contracts/feedback-publication";
import type { GithubAppConfig, GithubAppTarget } from "./github-app-config.js";
import type { GithubAppSignerSnapshot } from "./github-app-key.js";
import { createGithubAppJwt } from "./github-app-jwt.js";
import {
  digestFeedbackIssueProjectionV1,
  digestFeedbackTargetPolicyV1,
} from "./feedback-publication-projection.js";
import type { ApprovedFeedbackIssueProjection } from "./feedback-publication-types.js";
import { PostgresFeedbackPublicationWorkerStore } from "./feedback-publication-worker-store.js";
import type { FeedbackPublicationWorkerLease } from "./feedback-publication-worker-types.js";
import {
  GithubTransportError,
  GITHUB_MAX_SEARCH_RESULTS,
  GITHUB_SEARCH_PAGE_SIZE,
  type GithubHttpResponse,
  type GithubTransport,
  type GithubTransportRequestOptions,
} from "./github-app-transport.js";

export type GithubIssueFailureCode =
  | "permission-denied"
  | "validation-error"
  | "rate-limited"
  | "repository-unavailable"
  | "duplicate-candidate"
  | "provider-unavailable";

export type GithubCommitCertainty = "definite-pre-send" | "may-have-committed";

export class GithubIssueAdapterError extends Error {
  constructor(
    readonly code: GithubIssueFailureCode,
    readonly commitCertainty: GithubCommitCertainty,
    readonly retryAfterSeconds?: number,
  ) {
    super(`GitHub issue operation failed: ${code}`);
    this.name = "GithubIssueAdapterError";
  }
}

export interface BoundGithubTarget {
  readonly snapshot: FeedbackPublicationTargetPolicySnapshotV1;
  readonly digest: string;
}

export interface GithubIssueProjection {
  readonly repositoryId: string;
  readonly number: number;
  readonly nodeId: string;
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

export type GithubIssueReconciliationResult =
  | { readonly kind: "exact"; readonly issue: GithubIssueProjection }
  | {
      /**
       * A GitHub search-index observation, never authoritative absence. B2 may POST only when its
       * durable state is create-eligible and proves there was no prior possibly-committed POST.
       * Reconcile-only or may-have-committed state must reschedule or require manual settlement.
       */
      readonly kind: "not-observed";
      readonly createAuthority: "requires-create-eligible-with-no-possibly-committed-post";
    };

export interface GithubIssueAdapter {
  reconcileIssue(
    projection: ApprovedFeedbackIssueProjection,
    signal?: AbortSignal,
  ): Promise<GithubIssueReconciliationResult>;
}

const MARKER = /^<!-- keiko-feedback-reconciliation-v1:[A-Za-z0-9_-]{43} -->$/u;
const MAX_TOKEN_BYTES = 4096;
const MAX_RESPONSE_BYTES = 256 * 1024;
const AGGREGATE_DEADLINE_MS = 30_000;

interface RequestBudget {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  dispose(): void;
}

function requestBudget(
  external: AbortSignal | undefined,
  monotonicNow: () => number,
): RequestBudget {
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort();
  };
  if (external?.aborted === true) abort();
  else external?.addEventListener("abort", abort, { once: true });
  const deadlineAt = monotonicNow() + AGGREGATE_DEADLINE_MS;
  const timer = setTimeout(abort, AGGREGATE_DEADLINE_MS);
  timer.unref();
  return {
    signal: controller.signal,
    deadlineAt,
    dispose(): void {
      clearTimeout(timer);
      external?.removeEventListener("abort", abort);
    },
  };
}

function budgetOptions(
  budget: RequestBudget,
  monotonicNow: () => number,
): GithubTransportRequestOptions {
  const timeoutMs = budget.deadlineAt - monotonicNow();
  if (budget.signal.aborted || timeoutMs <= 0) throw safeFailure(false);
  return { signal: budget.signal, timeoutMs };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw safeFailure();
  return value as Record<string, unknown>;
}

function json(response: GithubHttpResponse, mayHaveCommitted = false): unknown {
  if (
    response.body.byteLength > MAX_RESPONSE_BYTES ||
    !/^application\/json(?:;|$)/iu.test(response.contentType)
  ) {
    throw safeFailure(mayHaveCommitted);
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body)) as unknown;
  } catch {
    throw safeFailure(mayHaveCommitted);
  }
}

function safeFailure(committed = false): GithubIssueAdapterError {
  return new GithubIssueAdapterError(
    "provider-unavailable",
    committed ? "may-have-committed" : "definite-pre-send",
  );
}

function retryHint(value: string | undefined): number | undefined {
  if (value === undefined || !/^[0-9]{1,5}$/u.test(value)) return undefined;
  return Math.min(Number(value), 3600);
}

// The ordered provider status taxonomy is intentionally a single fail-closed decision table.
// eslint-disable-next-line complexity
function classify(response: GithubHttpResponse, create: boolean): never {
  const certainty = create ? "may-have-committed" : "definite-pre-send";
  if (
    response.status === 429 ||
    (response.status === 403 &&
      (response.retryAfter !== undefined || response.rateLimitRemaining === "0"))
  ) {
    throw new GithubIssueAdapterError("rate-limited", certainty, retryHint(response.retryAfter));
  }
  if (response.status === 401 || response.status === 403) {
    throw new GithubIssueAdapterError("permission-denied", certainty);
  }
  if (response.status === 404 || response.status === 410) {
    throw new GithubIssueAdapterError("repository-unavailable", certainty);
  }
  if (response.status === 400 || response.status === 422)
    throw new GithubIssueAdapterError("validation-error", certainty);
  throw new GithubIssueAdapterError("provider-unavailable", certainty);
}

function successful(response: GithubHttpResponse, statuses: readonly number[]): unknown {
  if (!statuses.includes(response.status)) classify(response, false);
  return json(response);
}

function exactPermissions(value: unknown): boolean {
  const permissions = record(value);
  return (
    Object.keys(permissions).sort().join(",") === "issues,metadata" &&
    permissions.issues === "write" &&
    permissions.metadata === "read"
  );
}

function exactTokenPermissions(value: unknown): boolean {
  const permissions = record(value);
  return Object.keys(permissions).sort().join(",") === "issues" && permissions.issues === "write";
}

function assertTarget(
  current: GithubAppTarget | undefined,
  target: BoundGithubTarget,
): GithubAppTarget {
  let suppliedDigest: string | undefined;
  let configuredDigest: string | undefined;
  try {
    suppliedDigest = digestFeedbackTargetPolicyV1(target.snapshot);
    configuredDigest =
      current === undefined ? undefined : digestFeedbackTargetPolicyV1(current.snapshot);
  } catch {
    suppliedDigest = undefined;
    configuredDigest = undefined;
  }
  if (
    current?.digest !== target.digest ||
    configuredDigest !== current.digest ||
    suppliedDigest !== target.digest
  ) {
    throw new GithubIssueAdapterError("permission-denied", "definite-pre-send");
  }
  return current;
}

function labels(value: unknown, mayHaveCommitted = false): readonly string[] {
  if (!Array.isArray(value)) throw safeFailure(mayHaveCommitted);
  return value.map((item) => {
    let name: unknown;
    try {
      name = record(item).name;
    } catch {
      throw safeFailure(mayHaveCommitted);
    }
    if (typeof name !== "string") throw safeFailure(mayHaveCommitted);
    return name;
  });
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

// The provider response schema gate checks every required field independently.
// eslint-disable-next-line complexity
function issue(
  value: unknown,
  target: FeedbackPublicationTargetPolicySnapshotV1,
  mayHaveCommitted = false,
): GithubIssueProjection {
  let item: Record<string, unknown>;
  try {
    item = record(value);
  } catch {
    throw safeFailure(mayHaveCommitted);
  }
  const number = item.number;
  const title = item.title;
  const body = item.body;
  const nodeId = item.node_id;
  const repositoryUrl = item.repository_url;
  const url = item.html_url;
  const expectedRepositoryUrl = `${target.apiOrigin}/repos/${target.owner}/${target.repository}`;
  if (
    !Number.isSafeInteger(number) ||
    Number(number) < 1 ||
    typeof title !== "string" ||
    typeof body !== "string" ||
    typeof nodeId !== "string" ||
    nodeId.length === 0 ||
    repositoryUrl !== expectedRepositoryUrl ||
    url !== `https://github.com/${target.owner}/${target.repository}/issues/${String(number)}`
  ) {
    throw safeFailure(mayHaveCommitted);
  }
  return {
    repositoryId: target.repositoryId,
    number: Number(number),
    nodeId,
    url,
    title,
    body,
    labels: labels(item.labels, mayHaveCommitted),
  };
}

interface ImmutableApprovedProjection {
  readonly title: string;
  readonly body: string;
  readonly projectionDigest: string;
  readonly reconciliationMarker: string;
  readonly targetPolicyDigest: string;
  readonly target: FeedbackPublicationTargetPolicySnapshotV1;
}

// This runtime boundary snapshots the readonly claim before the first await.
function immutableApprovedProjection(value: unknown): ImmutableApprovedProjection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GithubIssueAdapterError("validation-error", "definite-pre-send");
  }
  const source = value as Record<string, unknown>;
  if (
    typeof source.title !== "string" ||
    typeof source.body !== "string" ||
    typeof source.projectionDigest !== "string" ||
    typeof source.reconciliationMarker !== "string" ||
    typeof source.targetPolicyDigest !== "string" ||
    !isFeedbackPublicationTargetPolicySnapshotV1(source.target)
  ) {
    throw new GithubIssueAdapterError("validation-error", "definite-pre-send");
  }
  return Object.freeze({
    title: source.title,
    body: source.body,
    projectionDigest: source.projectionDigest,
    reconciliationMarker: source.reconciliationMarker,
    targetPolicyDigest: source.targetPolicyDigest,
    target: Object.freeze({
      ...source.target,
      labels: Object.freeze([...source.target.labels]),
    }),
  });
}

function assertApprovedProjection(projection: ImmutableApprovedProjection): void {
  const expectedProjectionDigest = digestFeedbackIssueProjectionV1(
    projection.title,
    projection.body,
    projection.targetPolicyDigest,
  );
  if (
    projection.targetPolicyDigest !== digestFeedbackTargetPolicyV1(projection.target) ||
    projection.projectionDigest !== expectedProjectionDigest ||
    !MARKER.test(projection.reconciliationMarker) ||
    projection.body.slice(projection.body.lastIndexOf("<!--")) !== projection.reconciliationMarker
  ) {
    throw new GithubIssueAdapterError("validation-error", "definite-pre-send");
  }
}

interface ParsedSearchPage {
  readonly total: number;
  readonly item?: unknown;
}

// Search completeness and cardinality are one fail-closed provider schema gate.
// eslint-disable-next-line complexity
function parseSearchPage(value: unknown, page: number, expectedTotal?: number): ParsedSearchPage {
  const result = record(value);
  const total = result.total_count;
  const items = result.items;
  if (
    !Number.isSafeInteger(total) ||
    Number(total) < 0 ||
    Number(total) > GITHUB_MAX_SEARCH_RESULTS ||
    result.incomplete_results !== false ||
    !Array.isArray(items) ||
    items.length > GITHUB_SEARCH_PAGE_SIZE ||
    (expectedTotal !== undefined && total !== expectedTotal)
  ) {
    throw safeFailure();
  }
  const exactTotal = Number(total);
  const expectedPageItems = page <= exactTotal ? GITHUB_SEARCH_PAGE_SIZE : 0;
  if (items.length !== expectedPageItems) throw safeFailure();
  return items.length === 0 ? { total: exactTotal } : { total: exactTotal, item: items[0] };
}

function exactSearchCandidate(
  value: unknown,
  target: GithubAppTarget,
  projection: ImmutableApprovedProjection,
): GithubIssueProjection {
  const raw = record(value);
  if (raw.pull_request !== undefined) throw safeFailure();
  const found = issue(raw, target.snapshot);
  if (
    found.title !== projection.title ||
    found.body !== projection.body ||
    found.body.split(projection.reconciliationMarker).length !== 2 ||
    !sameStrings(found.labels, target.snapshot.labels)
  ) {
    throw safeFailure();
  }
  return found;
}

export interface GithubIssueAdapterDependencies {
  readonly config: GithubAppConfig;
  readonly keyProvider: { snapshot(now: Date): GithubAppSignerSnapshot };
  readonly transport: GithubTransport;
  readonly trustedNow: () => Date;
  readonly monotonicNow?: () => number;
}

export class GovernedGithubIssueAdapter implements GithubIssueAdapter {
  private readinessAttestation: ReadonlySet<string> | undefined;
  private readinessGeneration = 0;
  private readonly coordinatedLeases = new WeakSet();

  constructor(private readonly dependencies: GithubIssueAdapterDependencies) {}

  private monotonicNow(): number {
    return this.dependencies.monotonicNow?.() ?? performance.now();
  }

  private jwt(now: Date): string {
    return createGithubAppJwt(
      this.dependencies.config.appId,
      this.dependencies.keyProvider.snapshot(now),
      now,
    );
  }

  async inspectReadiness(): Promise<void> {
    const generation = ++this.readinessGeneration;
    this.readinessAttestation = undefined;
    const budget = requestBudget(undefined, () => this.monotonicNow());
    try {
      const now = this.dependencies.trustedNow();
      const jwt = this.jwt(now);
      const app = record(
        successful(
          await this.dependencies.transport.execute(
            { kind: "inspect-app", jwt },
            budgetOptions(budget, () => this.monotonicNow()),
          ),
          [200],
        ),
      );
      if (!exactPermissions(app.permissions))
        throw new GithubIssueAdapterError("permission-denied", "definite-pre-send");
      const attested = new Set<string>();
      for (const target of this.dependencies.config.targets.values()) {
        await this.inspectTarget(target, jwt, budget);
        attested.add(target.digest);
      }
      if (generation !== this.readinessGeneration) throw safeFailure(false);
      this.readinessAttestation = attested;
    } catch (error) {
      if (generation === this.readinessGeneration) this.readinessAttestation = undefined;
      if (error instanceof GithubIssueAdapterError) throw error;
      throw safeFailure(false);
    } finally {
      budget.dispose();
    }
  }

  private assertAttested(target: GithubAppTarget): void {
    if (this.readinessAttestation?.has(target.digest) !== true) {
      throw new GithubIssueAdapterError("permission-denied", "definite-pre-send");
    }
  }

  private async inspectTarget(
    target: GithubAppTarget,
    jwt: string,
    budget: RequestBudget,
  ): Promise<void> {
    const installation = record(
      successful(
        await this.dependencies.transport.execute(
          {
            kind: "inspect-installation",
            installationId: target.snapshot.installationId,
            jwt,
          },
          budgetOptions(budget, () => this.monotonicNow()),
        ),
        [200],
      ),
    );
    if (
      String(installation.id) !== target.snapshot.installationId ||
      installation.repository_selection !== "selected" ||
      !exactPermissions(installation.permissions)
    ) {
      throw new GithubIssueAdapterError("permission-denied", "definite-pre-send");
    }
    const repositoryInstallation = record(
      successful(
        await this.dependencies.transport.execute(
          {
            kind: "inspect-repository-installation",
            repositoryId: target.snapshot.repositoryId,
            jwt,
          },
          budgetOptions(budget, () => this.monotonicNow()),
        ),
        [200],
      ),
    );
    if (String(repositoryInstallation.id) !== target.snapshot.installationId) {
      throw new GithubIssueAdapterError("permission-denied", "definite-pre-send");
    }
  }

  // The response gate checks every independent token scope invariant.
  // eslint-disable-next-line complexity
  private async token(
    target: GithubAppTarget,
    options?: GithubTransportRequestOptions,
  ): Promise<string> {
    const now = this.dependencies.trustedNow();
    const response = await this.dependencies.transport.execute(
      {
        kind: "mint-token",
        installationId: target.snapshot.installationId,
        repositoryId: target.snapshot.repositoryId,
        jwt: this.jwt(now),
      },
      options,
    );
    const result = record(successful(response, [201]));
    const token = result.token;
    const expiresAt = new Date(String(result.expires_at));
    const repositories = result.repositories;
    if (
      typeof token !== "string" ||
      Buffer.byteLength(token) === 0 ||
      Buffer.byteLength(token) > MAX_TOKEN_BYTES ||
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt <= now ||
      expiresAt.getTime() - now.getTime() > 3_600_000 ||
      !exactTokenPermissions(result.permissions) ||
      !Array.isArray(repositories) ||
      repositories.length !== 1
    ) {
      throw safeFailure();
    }
    const repository = record(repositories[0]);
    if (
      String(repository.id) !== target.snapshot.repositoryId ||
      repository.name !== target.snapshot.repository ||
      repository.full_name !== `${target.snapshot.owner}/${target.snapshot.repository}` ||
      record(repository.owner).login !== target.snapshot.owner
    ) {
      throw new GithubIssueAdapterError("permission-denied", "definite-pre-send");
    }
    return token;
  }

  private async tokenDefinitelyPreSend(target: GithubAppTarget): Promise<string> {
    try {
      return await this.token(target);
    } catch (error) {
      if (error instanceof GithubIssueAdapterError) throw error;
      throw safeFailure(false);
    }
  }

  private async scanIssues(
    target: GithubAppTarget,
    projection: ImmutableApprovedProjection,
    token: string,
    budget: RequestBudget,
  ): Promise<GithubIssueProjection | undefined> {
    let candidate: GithubIssueProjection | undefined;
    let expectedTotal: number | undefined;
    for (let page = 1; page <= GITHUB_MAX_SEARCH_RESULTS; page += 1) {
      const result = successful(
        await this.dependencies.transport.execute(
          {
            kind: "find-marker",
            owner: target.snapshot.owner,
            repository: target.snapshot.repository,
            marker: projection.reconciliationMarker,
            page,
            token,
          },
          budgetOptions(budget, () => this.monotonicNow()),
        ),
        [200],
      );
      const parsed = parseSearchPage(result, page, expectedTotal);
      expectedTotal = parsed.total;
      if (parsed.item === undefined) return candidate;
      const found = exactSearchCandidate(parsed.item, target, projection);
      if (candidate !== undefined) {
        throw new GithubIssueAdapterError("duplicate-candidate", "definite-pre-send");
      }
      candidate = found;
      if (page === parsed.total) return candidate;
    }
    throw safeFailure();
  }

  async #postIssue(
    target: GithubAppTarget,
    projection: ImmutableApprovedProjection,
    token: string,
  ): Promise<GithubIssueProjection> {
    try {
      const response = await this.dependencies.transport.execute({
        kind: "create-issue",
        repositoryId: target.snapshot.repositoryId,
        title: projection.title,
        body: projection.body,
        labels: target.snapshot.labels,
        token,
      });
      if (response.status !== 201) classify(response, true);
      const created = issue(json(response, true), target.snapshot, true);
      if (
        created.title !== projection.title ||
        created.body !== projection.body ||
        !sameStrings(created.labels, target.snapshot.labels)
      ) {
        throw safeFailure(true);
      }
      return created;
    } catch (error) {
      if (error instanceof GithubIssueAdapterError) throw error;
      if (error instanceof GithubTransportError) throw safeFailure(error.requestCommitted);
      throw safeFailure(true);
    }
  }

  async reconcileIssue(
    projection: ApprovedFeedbackIssueProjection,
    signal?: AbortSignal,
  ): Promise<GithubIssueReconciliationResult> {
    const approved = immutableApprovedProjection(projection);
    assertApprovedProjection(approved);
    const target: BoundGithubTarget = {
      snapshot: approved.target,
      digest: approved.targetPolicyDigest,
    };
    const current = assertTarget(
      this.dependencies.config.targets.get(target.snapshot.targetKey),
      target,
    );
    this.assertAttested(current);
    const budget = requestBudget(signal, () => this.monotonicNow());
    try {
      const token = await this.token(
        current,
        budgetOptions(budget, () => this.monotonicNow()),
      );
      const issue = await this.scanIssues(current, approved, token, budget);
      return issue === undefined
        ? {
            kind: "not-observed",
            createAuthority: "requires-create-eligible-with-no-possibly-committed-post",
          }
        : { kind: "exact", issue };
    } catch (error) {
      if (error instanceof GithubIssueAdapterError) throw error;
      if (error instanceof GithubTransportError) throw safeFailure(false);
      throw safeFailure();
    } finally {
      budget.dispose();
    }
  }

  async publishClaimedCandidate(
    store: PostgresFeedbackPublicationWorkerStore,
    projection: FeedbackPublicationWorkerLease,
  ): Promise<GithubIssueProjection> {
    if (!(store instanceof PostgresFeedbackPublicationWorkerStore)) throw safeFailure(false);
    if (this.coordinatedLeases.has(projection)) throw safeFailure(false);
    this.coordinatedLeases.add(projection);
    const approved = immutableApprovedProjection(projection);
    const target: BoundGithubTarget = {
      snapshot: approved.target,
      digest: approved.targetPolicyDigest,
    };
    const current = assertTarget(
      this.dependencies.config.targets.get(target.snapshot.targetKey),
      target,
    );
    this.assertAttested(current);
    assertApprovedProjection(approved);
    const token = await this.tokenDefinitelyPreSend(current);
    await store.armCreate(projection);
    return this.#postIssue(current, approved, token);
  }
}
