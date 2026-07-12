import { createHash } from "node:crypto";
import { createServer } from "node:http";

import { GovernedGithubIssueAdapter } from "../packages/keiko-feedback-intake/src/github-issue-adapter.js";
import type { GithubAppSignerSnapshot } from "../packages/keiko-feedback-intake/src/github-app-key.js";
import type {
  GithubHttpOperation,
  GithubHttpResponse,
  GithubTransport,
} from "../packages/keiko-feedback-intake/src/github-app-transport.js";
import { createMaintainerHttpHandler } from "../packages/keiko-feedback-intake/src/maintainer-http.js";
import { MaintainerLoginLimiter } from "../packages/keiko-feedback-intake/src/maintainer-login-limiter.js";
import { PostgresFeedbackPublicationQuery } from "../packages/keiko-feedback-intake/src/feedback-publication-query.js";
import { PostgresFeedbackPublicationRepository } from "../packages/keiko-feedback-intake/src/feedback-publication-store.js";
import { FeedbackPublicationWorker } from "../packages/keiko-feedback-intake/src/feedback-publication-worker.js";
import { PostgresFeedbackPublicationWorkerStore } from "../packages/keiko-feedback-intake/src/feedback-publication-worker-store.js";
import { PostgresFeedbackReviewQuery } from "../packages/keiko-feedback-intake/src/feedback-review-query.js";
import { PostgresFeedbackReviewRepository } from "../packages/keiko-feedback-intake/src/feedback-review-store.js";
import type { PgPoolLike } from "../packages/keiko-feedback-intake/src/postgres.js";

import {
  ACTOR,
  NOW,
  TARGET,
  type StartedServer,
  type StoredPayload,
} from "./feedback-flow-2077-common.js";
import { close, listen } from "./feedback-flow-2077-infrastructure.js";

interface MaintainerServer extends StartedServer {
  readonly csrfToken: string;
  readonly cookie: string;
}

interface PublicationApproval {
  readonly preparationId: string;
  readonly projectionDigest: string;
  readonly targetPolicyDigest: string;
}

interface MaintainerHandlerContext {
  readonly pool: PgPoolLike;
  readonly publication: PostgresFeedbackPublicationRepository;
  readonly origin: string;
  readonly capability: string;
  readonly csrfToken: string;
}

export class FakeGithubTransport implements GithubTransport {
  readonly operations: GithubHttpOperation[] = [];

  constructor(private readonly denySearch = false) {}

  execute(operation: GithubHttpOperation): Promise<GithubHttpResponse> {
    this.operations.push(operation);
    return Promise.resolve(this.responseFor(operation));
  }

  createdIssueCount(): number {
    return this.operations.filter((operation) => operation.kind === "create-issue").length;
  }

  private responseFor(operation: GithubHttpOperation): GithubHttpResponse {
    if (operation.kind === "inspect-app") return this.inspectAppResponse();
    if (operation.kind === "inspect-installation") return this.inspectInstallationResponse();
    if (operation.kind === "inspect-repository-installation") return this.json(200, { id: 2077 });
    if (operation.kind === "mint-token") return this.mintTokenResponse();
    if (this.denySearch && operation.kind === "find-marker") return this.json(403, {});
    if (operation.kind === "create-issue") return this.createIssueResponse(operation);
    return this.json(200, { total_count: 0, incomplete_results: false, items: [] });
  }

  private inspectAppResponse(): GithubHttpResponse {
    return this.json(200, { permissions: { issues: "write", metadata: "read" } });
  }

  private inspectInstallationResponse(): GithubHttpResponse {
    return this.json(200, {
      id: 2077,
      repository_selection: "selected",
      permissions: { issues: "write", metadata: "read" },
    });
  }

  private mintTokenResponse(): GithubHttpResponse {
    return this.json(201, {
      token: "test-token",
      expires_at: new Date(NOW.getTime() + 3_600_000).toISOString(),
      permissions: { issues: "write" },
      repositories: [
        {
          id: 2077,
          name: TARGET.repository,
          full_name: `${TARGET.owner}/${TARGET.repository}`,
          owner: { login: TARGET.owner },
        },
      ],
    });
  }

  private createIssueResponse(operation: GithubHttpOperation): GithubHttpResponse {
    if (operation.kind !== "create-issue") throw new Error("Expected a create-issue operation");
    return this.json(
      201,
      {
        repository_url: `${TARGET.apiOrigin}/repos/${TARGET.owner}/${TARGET.repository}`,
        html_url: `https://github.com/${TARGET.owner}/${TARGET.repository}/issues/2077`,
        number: 2077,
        node_id: "I_feedback_2077",
        title: operation.title,
        body: operation.body,
        labels: operation.labels.map((name) => ({ name })),
      },
      true,
    );
  }

  private json(status: number, value: unknown, requestCommitted = false): GithubHttpResponse {
    return {
      status,
      contentType: "application/json",
      body: Buffer.from(JSON.stringify(value)),
      requestCommitted,
    };
  }
}

function csrfHash(token: string): Uint8Array {
  return createHash("sha256")
    .update("keiko-maintainer-csrf-v1")
    .update("\0")
    .update(token)
    .digest();
}

async function startMaintainer(
  pool: PgPoolLike,
  publication: PostgresFeedbackPublicationRepository,
): Promise<MaintainerServer> {
  const capability = "A".repeat(43);
  const csrfToken = "feedback-flow-csrf";
  const holder: { current?: ReturnType<typeof createMaintainerHttpHandler> } = {};
  const server = createServer((request, response): void => {
    const handler = holder.current;
    if (handler !== undefined) void handler(request, response);
  });
  const started = await listen(server);
  holder.current = createMaintainerHttpHandler(
    maintainerHandlerDependencies({
      pool,
      publication,
      origin: started.origin,
      capability,
      csrfToken,
    }),
  );
  return { ...started, csrfToken, cookie: `__Host-keiko-feedback-session=${capability}` };
}

function maintainerHandlerDependencies(
  context: MaintainerHandlerContext,
): Parameters<typeof createMaintainerHttpHandler>[0] {
  return {
    publicOrigin: context.origin,
    auth: maintainerAuth(context.capability, context.csrfToken),
    query: new PostgresFeedbackReviewQuery(context.pool),
    review: new PostgresFeedbackReviewRepository(context.pool, 2_000, [], () => new Date()),
    publication: {
      query: new PostgresFeedbackPublicationQuery(context.pool, () => TARGET),
      repository: context.publication,
    },
    publicationTargets: [
      {
        targetKey: TARGET.targetKey,
        owner: TARGET.owner,
        repository: TARGET.repository,
        labels: TARGET.labels,
        targetPolicyVersion: TARGET.targetPolicyVersion,
        projectionPolicyVersion: "github-issue-v1",
      },
    ],
    loginLimiter: new MaintainerLoginLimiter({
      perSource: 10,
      global: 10,
      windowMs: 60_000,
      concurrency: 2,
    }),
    proxy: { family: "forwarded", trustedCidrs: [], maxHops: 2 },
  };
}

function maintainerAuth(
  capability: string,
  csrfToken: string,
): Parameters<typeof createMaintainerHttpHandler>[0]["auth"] {
  return {
    login: (): Promise<never> => Promise.reject(new Error("not used")),
    callback: (): Promise<never> => Promise.reject(new Error("not used")),
    session: (value) =>
      Promise.resolve(
        value === capability
          ? {
              ...ACTOR,
              permissions: ["feedback.review", "feedback.publish"],
              csrfHash: csrfHash(csrfToken),
              absoluteExpiresAt: new Date(Date.now() + 60_000),
            }
          : undefined,
      ),
    logout: (): Promise<void> => Promise.resolve(),
  };
}

export async function publish(
  pool: PgPoolLike,
  installationPool: PgPoolLike,
  payload: StoredPayload,
  denySearch = false,
): Promise<FakeGithubTransport> {
  const repository = new PostgresFeedbackPublicationRepository(
    pool,
    ACTOR.permissionPolicyVersion,
    () => TARGET,
    2_000,
    () => NOW,
  );
  const maintainer = await startMaintainer(pool, repository);
  const approval = await approvePublication(maintainer, payload.id);
  return runPublicationWorker(pool, installationPool, approval.targetPolicyDigest, denySearch);
}

async function approvePublication(
  maintainer: MaintainerServer,
  payloadId: string,
): Promise<PublicationApproval> {
  try {
    const prepared = await preparePublication(maintainer, payloadId);
    await approvePreparedPublication(maintainer, payloadId, prepared);
    return prepared;
  } finally {
    await close(maintainer.server);
  }
}

async function preparePublication(
  maintainer: MaintainerServer,
  payloadId: string,
): Promise<PublicationApproval> {
  const response = await fetch(
    `${maintainer.origin}/v1/maintainer/reviews/${payloadId}/publication/prepare`,
    {
      method: "POST",
      headers: maintainerHeaders(maintainer),
      body: JSON.stringify({
        action: "prepare-publication",
        expectedVersion: 1,
        targetKey: TARGET.targetKey,
        idempotencyKey: "feedback-flow-prepare",
      }),
    },
  );
  if (!response.ok) throw new Error(`Maintainer prepare failed: ${await response.text()}`);
  return response.json() as Promise<PublicationApproval>;
}

async function approvePreparedPublication(
  maintainer: MaintainerServer,
  payloadId: string,
  prepared: PublicationApproval,
): Promise<void> {
  const response = await fetch(
    `${maintainer.origin}/v1/maintainer/reviews/${payloadId}/publication/approve`,
    {
      method: "POST",
      headers: maintainerHeaders(maintainer),
      body: JSON.stringify({
        action: "approve-publication",
        preparationId: prepared.preparationId,
        expectedProjectionDigest: prepared.projectionDigest,
        expectedTargetPolicyDigest: prepared.targetPolicyDigest,
        idempotencyKey: "feedback-flow-approve",
      }),
    },
  );
  if (!response.ok) throw new Error(`Maintainer approve failed: ${await response.text()}`);
}

function maintainerHeaders(maintainer: MaintainerServer): Record<string, string> {
  return {
    Cookie: maintainer.cookie,
    "Content-Type": "application/json",
    Origin: maintainer.origin,
    "keiko-feedback-csrf": maintainer.csrfToken,
  };
}

async function runPublicationWorker(
  pool: PgPoolLike,
  installationPool: PgPoolLike,
  targetPolicyDigest: string,
  denySearch: boolean,
): Promise<FakeGithubTransport> {
  const transport = new FakeGithubTransport(denySearch);
  const adapter = createIssueAdapter(transport, targetPolicyDigest);
  await adapter.inspectReadiness();
  const worker = new FeedbackPublicationWorker({
    store: new PostgresFeedbackPublicationWorkerStore(pool, installationPool, () => TARGET),
    adapter,
    workerId: "feedback-flow",
    leaseDurationMs: 60_000,
    circuitCooldownMs: 60_000,
    now: (): number => NOW.getTime(),
    random: (): number => 0.5,
  });
  await worker.runOne();
  return transport;
}

function createIssueAdapter(
  transport: GithubTransport,
  targetPolicyDigest: string,
): GovernedGithubIssueAdapter {
  return new GovernedGithubIssueAdapter({
    config: {
      apiOrigin: TARGET.apiOrigin,
      appId: "2077",
      privateKeyFile: "/unused",
      privateKeyRotatedAt: "2026-07-01T00:00:00.000Z",
      targets: new Map([[TARGET.targetKey, { snapshot: TARGET, digest: targetPolicyDigest }]]),
    },
    transport,
    trustedNow: (): Date => NOW,
    keyProvider: {
      snapshot: (): GithubAppSignerSnapshot => ({
        keyId: "test",
        rotatedAt: NOW,
        signRs256: (): Uint8Array => Uint8Array.from([1]),
      }),
    },
  });
}
