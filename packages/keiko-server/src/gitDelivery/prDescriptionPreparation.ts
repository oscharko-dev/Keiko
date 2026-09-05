import { randomUUID } from "node:crypto";
import { PrDescription } from "@oscharko-dev/keiko-model-gateway";
import { canonicalise, redact, sha256Hex } from "@oscharko-dev/keiko-security";
import { isGitChangeSnapshot } from "@oscharko-dev/keiko-contracts/runtime/git-change-snapshot";
import {
  PR_DESCRIPTION_LANGUAGES,
  prDescriptionArtifactDigestFields,
} from "@oscharko-dev/keiko-contracts/runtime/pr-description";
import { PR_DESCRIPTION_CONCURRENCY_LIMITATION } from "@oscharko-dev/keiko-contracts/runtime/pr-description-application";
import type { PrDescriptionApplicationBinding } from "@oscharko-dev/keiko-contracts/runtime/pr-description-application";
import { isGitPullRequestIdentity } from "@oscharko-dev/keiko-contracts/runtime/git-pull-request";
import {
  GITHUB_ISSUE_NUMBER_MAX,
  isGitHubOwnerAndRepo,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";
import { validGitPrBodyText, type GitPrBody } from "@oscharko-dev/keiko-tools";
import { codingWorkbenchRemoteDigest } from "../coding-context/githubIssueResolution.js";
import { reconcilePrDescriptionRegion } from "./prDescriptionRegion.js";
import { applicationStatus } from "./prDescriptionProjection.js";
import {
  PrDescriptionFailure,
  type PrDescriptionContext,
  type PrDescriptionServiceOptions,
  type PrDescriptionPreviewRequest,
  type PreparedPrDescription,
} from "./prDescriptionTypes.js";

export function parsePrDescriptionPreviewRequest(
  value: unknown,
): PrDescriptionPreviewRequest | undefined {
  if (!previewRecord(value)) return undefined;
  const input = value;
  if (Reflect.ownKeys(input).some((key) => key !== "language" && key !== "refinement"))
    return undefined;
  if (
    Object.keys(input).some(
      (key) => !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key) ?? {}, "value"),
    )
  )
    return undefined;
  if (
    !PR_DESCRIPTION_LANGUAGES.includes(input.language as (typeof PR_DESCRIPTION_LANGUAGES)[number])
  )
    return undefined;
  if (
    input.refinement !== undefined &&
    (typeof input.refinement !== "string" || Buffer.byteLength(input.refinement, "utf8") > 4096)
  )
    return undefined;
  return {
    language: input.language as PrDescriptionPreviewRequest["language"],
    ...(input.refinement === undefined ? {} : { refinement: input.refinement }),
  };
}
export function validDescriptionContext(context: PrDescriptionContext): boolean {
  return (
    isGitHubOwnerAndRepo(context.repository) &&
    Number.isSafeInteger(context.prNumber) &&
    context.prNumber > 0 &&
    context.prNumber <= GITHUB_ISSUE_NUMBER_MAX &&
    /^[a-f0-9]{64}$/u.test(context.authorityDigest) &&
    context.stillAuthorized() &&
    context.signal?.aborted !== true
  );
}
export function sameDescriptionContext(a: PrDescriptionContext, b: PrDescriptionContext): boolean {
  return (
    a.accessScope === b.accessScope &&
    a.authorityDigest === b.authorityDigest &&
    a.repository === b.repository &&
    a.prNumber === b.prNumber &&
    a.workspace.root === b.workspace.root &&
    a.runId === b.runId
  );
}
export function assertSafeDescriptionBody(
  options: PrDescriptionServiceOptions,
  body: string,
): void {
  if (
    !validGitPrBodyText(body) ||
    redact(body) !== body ||
    options.mutationDeps.redactor(body) !== body
  )
    throw new PrDescriptionFailure("unsafe-content");
}
export async function readDescriptionBody(
  options: PrDescriptionServiceOptions,
  context: PrDescriptionContext,
): Promise<GitPrBody> {
  if (!validDescriptionContext(context)) throw new PrDescriptionFailure("authority-denied");
  const adapter = options.adapter(context);
  if (adapter === undefined) throw new PrDescriptionFailure("provider-failed");
  const read = await adapter.readPullRequestBody({
    ownerAndRepo: context.repository,
    prExternalId: String(context.prNumber),
  });
  if (!validDescriptionContext(context)) throw new PrDescriptionFailure("authority-denied");
  if (!read.ok) throw new PrDescriptionFailure("provider-failed");
  if (!validReadBody(read.value, context)) throw new PrDescriptionFailure("provider-failed");
  if (read.value.identity.state !== "open") throw new PrDescriptionFailure("stale-pr");
  assertSafeDescriptionBody(options, read.value.body);
  return structuredClone(read.value);
}
function captureInput(
  context: PrDescriptionContext,
  previous: GitPrBody,
): PreparedPrDescription["captureInput"] {
  return {
    workspace: context.workspace,
    accessScope: context.accessScope,
    correlationId: context.correlationId,
    baseRef: previous.identity.baseSha,
    headRef: previous.identity.headSha,
    expectedHeadSha: previous.identity.headSha,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  };
}
async function generate(
  options: PrDescriptionServiceOptions,
  context: PrDescriptionContext,
  request: PrDescriptionPreviewRequest,
  reference: string,
): Promise<PrDescription.PrDescriptionGenerationResult> {
  return PrDescription.generatePrDescription(
    {
      ...request,
      snapshotReference: reference,
      authority: { authorityDigest: context.authorityDigest, correlationId: context.correlationId },
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    },
    {
      ...options.generation,
      resolveSnapshot: (supplied, signal) => {
        if (supplied !== reference || signal.aborted || !validDescriptionContext(context))
          return Promise.resolve(undefined);
        const content = options.snapshots.read(
          reference,
          context.accessScope,
          context.correlationId,
        );
        return Promise.resolve(
          content === undefined
            ? undefined
            : {
                snapshot: content.snapshot,
                evidence: content.files.map((file) => ({
                  evidenceId: file.evidenceId,
                  text: JSON.stringify(file),
                })),
              },
        );
      },
    },
  );
}
function bindingFor(
  context: PrDescriptionContext,
  previous: GitPrBody,
  artifact: PreparedPrDescription["artifact"],
  body: ReturnType<typeof reconcilePrDescriptionRegion>,
): PrDescriptionApplicationBinding {
  const identity = previous.identity;
  return {
    repositoryId: artifact.binding.repositoryId,
    remoteDigest: codingWorkbenchRemoteDigest(context.repository),
    repository: identity.repository,
    prNumber: identity.number,
    prExternalId: identity.externalId,
    baseRef: identity.baseRef,
    baseSha: identity.baseSha,
    headRepository: identity.headRepository,
    headRef: identity.headRef,
    headSha: identity.headSha,
    isDraft: identity.isDraft,
    snapshotDigest: artifact.binding.snapshotDigest,
    draftDigest: artifact.artifactDigest,
    renderingVersion: artifact.renderingVersion,
    expectedBodyDigest: sha256Hex(previous.body),
    outsideRegionDigest: body.outsideRegionDigest,
    finalBodyDigest: sha256Hex(body.finalBody),
    providerUpdatedAt: previous.updatedAt,
  };
}
export async function prepareDescription(
  options: PrDescriptionServiceOptions,
  context: PrDescriptionContext,
  request: PrDescriptionPreviewRequest,
  now: number,
): Promise<PreparedPrDescription> {
  const previous = await readDescriptionBody(options, context);
  const input = captureInput(context, previous);
  const captured = await options.snapshots.capture(input);
  const snapshot = captured.snapshot;
  if (
    !isGitChangeSnapshot(snapshot) ||
    captured.reference === undefined ||
    snapshot.baseSha !== previous.identity.baseSha ||
    snapshot.headSha !== previous.identity.headSha ||
    snapshot.remoteDigest !== codingWorkbenchRemoteDigest(context.repository)
  )
    throw new PrDescriptionFailure("stale-snapshot");
  const generated = await generate(options, context, request, captured.reference);
  if (generated.status !== "generated" || generated.artifact.outcome === "failed")
    throw new PrDescriptionFailure("provider-failed");
  return finishPreparation({
    options,
    context,
    previous,
    input,
    reference: captured.reference,
    artifact: generated.artifact,
    expiresAt: Math.min(now + 60_000, Date.parse(snapshot.expiresAt)),
    now,
  });
}

export async function prepareDescriptionArtifact(
  options: PrDescriptionServiceOptions,
  context: PrDescriptionContext,
  artifact: PreparedPrDescription["artifact"],
  now: number,
): Promise<PreparedPrDescription> {
  const previous = await readDescriptionBody(options, context);
  const input = captureInput(context, previous);
  const captured = await options.snapshots.capture(input);
  const snapshot = captured.snapshot;
  if (
    !isGitChangeSnapshot(snapshot) ||
    captured.reference === undefined ||
    snapshot.baseSha !== previous.identity.baseSha ||
    snapshot.headSha !== previous.identity.headSha ||
    snapshot.remoteDigest !== codingWorkbenchRemoteDigest(context.repository) ||
    artifact.binding.repositoryId !== snapshot.repositoryId ||
    artifact.binding.snapshotDigest !== snapshot.snapshotDigest
  ) {
    throw new PrDescriptionFailure("stale-snapshot");
  }
  return finishPreparation({
    options,
    context,
    previous,
    input,
    reference: captured.reference,
    artifact,
    expiresAt: Math.min(now + 60_000, Date.parse(snapshot.expiresAt)),
    now,
  });
}
interface FinishPreparationInput {
  readonly options: PrDescriptionServiceOptions;
  readonly context: PrDescriptionContext;
  readonly previous: GitPrBody;
  readonly input: PreparedPrDescription["captureInput"];
  readonly reference: string;
  readonly artifact: PreparedPrDescription["artifact"];
  readonly expiresAt: number;
  readonly now: number;
}
function finishPreparation({
  options,
  context,
  previous,
  input,
  reference,
  artifact,
  expiresAt,
  now,
}: FinishPreparationInput): PreparedPrDescription {
  const region = preparedRegion(options, previous, artifact);
  const binding = bindingFor(context, previous, artifact, region);
  const proposalId = randomUUID();
  const completeness = artifact.outcome === "complete" ? "complete" : artifact.outcome;
  const status = applicationStatus(
    binding,
    completeness === "failed" ? "fallback" : completeness,
    "approval-required",
    "none",
    now,
  );
  return {
    context,
    captureInput: input,
    snapshotReference: reference,
    artifact,
    previous,
    review: {
      proposalId,
      expiresAt: new Date(expiresAt).toISOString(),
      status,
      finalBody: region.finalBody,
      managedRegion: artifact.markdown,
      concurrencyLimitation: PR_DESCRIPTION_CONCURRENCY_LIMITATION,
    },
    approvalBinding: {
      projectId: binding.repositoryId,
      operation: "pr-description-apply",
      command: { kind: "pr-description-apply", binding },
      proposalId,
      envelopeDigest: context.authorityDigest,
      ...(context.runId === undefined ? {} : { runId: context.runId }),
    },
  };
}

function validReadBody(body: GitPrBody, context: PrDescriptionContext): boolean {
  return (
    isGitPullRequestIdentity(body.identity) &&
    body.identity.number === context.prNumber &&
    body.identity.repository.toLowerCase() === context.repository.toLowerCase() &&
    typeof body.updatedAt === "string" &&
    Number.isFinite(Date.parse(body.updatedAt))
  );
}

function previewRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function preparedRegion(
  options: PrDescriptionServiceOptions,
  previous: GitPrBody,
  artifact: PreparedPrDescription["artifact"],
): ReturnType<typeof reconcilePrDescriptionRegion> {
  if (
    sha256Hex(canonicalise(prDescriptionArtifactDigestFields(artifact))) !== artifact.artifactDigest
  )
    throw new PrDescriptionFailure("unsafe-content");
  assertSafeDescriptionBody(options, artifact.markdown);
  let region: ReturnType<typeof reconcilePrDescriptionRegion>;
  try {
    region = reconcilePrDescriptionRegion(previous.body, artifact.markdown);
  } catch (error) {
    throw new PrDescriptionFailure("malformed-region", { cause: error });
  }
  assertSafeDescriptionBody(options, region.finalBody);
  return region;
}
