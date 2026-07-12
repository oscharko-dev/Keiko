import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  FeedbackPublicationApproveCommandV1,
  FeedbackPublicationCancelCommandV1,
  FeedbackPublicationPrepareCommandV1,
} from "@oscharko-dev/keiko-contracts/feedback-publication";
import type {
  FeedbackPublicationCommandContext,
  PostgresFeedbackPublicationQuery,
} from "./feedback-publication-query.js";
import type { PostgresFeedbackPublicationRepository } from "./feedback-publication-store.js";
import { isCanonicalFeedbackReviewId } from "./feedback-review-identifier.js";
import { readMaintainerBody } from "./maintainer-http-body.js";
import { fail, json } from "./maintainer-http-response.js";
import {
  maintainerPublicationActor,
  parseMaintainerPublicationRequest,
  type MaintainerPublicationRequest,
} from "./maintainer-publication-action.js";

export interface MaintainerPublicationService {
  readonly query: Pick<PostgresFeedbackPublicationQuery, "commandContext" | "preview" | "status">;
  readonly repository: Pick<
    PostgresFeedbackPublicationRepository,
    "prepare" | "approve" | "cancelAndRoutePrivate"
  >;
}

export interface MaintainerPublicationIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly permissionPolicyVersion: string;
  readonly permissions: readonly string[];
}

const PATH =
  /^\/v1\/maintainer\/reviews\/([^/]+)\/publication\/(prepare|preview|approve|cancel-route-private|status)$/u;

export async function handleMaintainerPublication(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  service: MaintainerPublicationService | undefined,
  identity: MaintainerPublicationIdentity,
  validMutation: () => boolean,
): Promise<boolean> {
  const match = PATH.exec(url.pathname);
  if (match === null) return false;
  const itemId = match[1];
  const operation = match[2];
  if (itemId === undefined || operation === undefined || !isCanonicalFeedbackReviewId(itemId)) {
    fail(res, 404);
    return true;
  }
  if (service === undefined) {
    fail(res, 404);
    return true;
  }
  if (
    !identity.permissions.includes("feedback.review") ||
    !identity.permissions.includes("feedback.publish")
  ) {
    fail(res, 403);
    return true;
  }
  if (operation === "preview" || operation === "status") {
    await handleRead(res, url, req.method, itemId, operation, service, identity);
    return true;
  }
  await handleMutation(req, res, itemId, operation, service, identity, validMutation);
  return true;
}

async function handleRead(
  res: ServerResponse,
  url: URL,
  method: string | undefined,
  itemId: string,
  operation: "preview" | "status",
  service: MaintainerPublicationService,
  identity: MaintainerPublicationIdentity,
): Promise<void> {
  if (method !== "GET") {
    fail(res, 405);
    return;
  }
  const preparationId = preparationQuery(url, operation === "status");
  if (preparationId === null) {
    fail(res, 400);
    return;
  }
  const includePrivate = identity.permissions.includes("feedback.security");
  const value =
    operation === "preview"
      ? await service.query.preview(itemId, preparationId ?? "", includePrivate)
      : await service.query.status(itemId, preparationId, includePrivate);
  if (value === undefined) fail(res, 404);
  else json(res, 200, value);
}

function preparationQuery(url: URL, optional: boolean): string | undefined | null {
  const entries = [...url.searchParams.entries()];
  if (entries.length === 0) return optional ? undefined : null;
  if (entries.length !== 1 || entries[0]?.[0] !== "preparationId") return null;
  const value = entries[0][1];
  return isCanonicalFeedbackReviewId(value) ? value : null;
}

async function handleMutation(
  req: IncomingMessage,
  res: ServerResponse,
  itemId: string,
  operation: string,
  service: MaintainerPublicationService,
  identity: MaintainerPublicationIdentity,
  validMutation: () => boolean,
): Promise<void> {
  if (req.method !== "POST") {
    fail(res, 405);
    return;
  }
  if (!validMutation()) {
    fail(res, 403);
    return;
  }
  const parsed = parseMaintainerPublicationRequest(await readMaintainerBody(req));
  if (parsed === undefined || routeAction(operation) !== parsed.action) {
    fail(res, 400);
    return;
  }
  const context = await service.query.commandContext(
    itemId,
    parsed.action === "prepare-publication" ? undefined : parsed.preparationId,
    identity.permissions.includes("feedback.security"),
    parsed.action === "prepare-publication" ? undefined : parsed.action,
    parsed.action === "prepare-publication" ? undefined : parsed.idempotencyKey,
  );
  if (context === undefined) {
    fail(res, 404);
    return;
  }
  json(res, 200, await execute(service, parsed, itemId, context, identity));
}

function routeAction(operation: string): MaintainerPublicationRequest["action"] | undefined {
  if (operation === "prepare") return "prepare-publication";
  if (operation === "approve") return "approve-publication";
  if (operation === "cancel-route-private") return "cancel-publication-route-private";
  return undefined;
}

function execute(
  service: MaintainerPublicationService,
  request: MaintainerPublicationRequest,
  itemId: string,
  context: FeedbackPublicationCommandContext,
  identity: MaintainerPublicationIdentity,
) {
  const actor = maintainerPublicationActor(identity);
  if (request.action === "prepare-publication") {
    const command: FeedbackPublicationPrepareCommandV1 = {
      ...request,
      itemId,
      expectedPayloadDigest: context.payloadDigest,
      actor,
    };
    return service.repository.prepare(command);
  }
  const shared = {
    ...request,
    itemId,
    expectedVersion: context.version,
    expectedPayloadDigest: context.payloadDigest,
    actor,
  };
  if (request.action === "approve-publication") {
    return service.repository.approve(shared as FeedbackPublicationApproveCommandV1);
  }
  return service.repository.cancelAndRoutePrivate(shared as FeedbackPublicationCancelCommandV1);
}
