// The closed vocabulary, native admin call and status guard shared by every AC7 preparation step.
import { URL } from "node:url";
import { basicAuth, labSessionConnection } from "./lab-client.mjs";

export const PREPARATION_REASONS = Object.freeze([
  "native-response-unexpected",
  "sprint-not-synced",
  "sprint-sync-feature-disabled",
  "dashboard-form-unavailable",
  "dashboard-create-refused",
  "dashboard-gadget-refused",
  "dashboard-not-created",
  "security-scheme-unavailable",
  "collection-seed-not-observed",
  "step-unexpected-error",
  "dependency-failed",
  "fixture-steps-failed",
  "option-not-created",
  "attribute-not-stored",
  "email-default-unavailable",
  "fixture-manifest-invalid",
]);

export class QualificationPreparationError extends Error {
  constructor(reason, status) {
    super(`AC7 preparation refused: ${reason}`);
    this.name = "QualificationPreparationError";
    this.reason = reason;
    if (status !== undefined) this.status = status;
  }
}

/** Authenticated admin call straight to the lab; a body is JSON unless raw text is requested. */
export async function adminRequest(session, method, path, body, contentType) {
  if (!path.startsWith("/rest/")) throw new TypeError("Unexpected laboratory API path");
  const origin = labSessionConnection(session).origin;
  const response = await globalThis.fetch(new URL(path, origin), {
    method,
    redirect: "manual",
    signal: globalThis.AbortSignal.timeout(30_000),
    headers: {
      Accept: "application/json",
      Authorization: basicAuth(session, "admin"),
      "X-Atlassian-Token": "no-check",
      ...(body === undefined ? {} : { "Content-Type": contentType ?? "application/json" }),
    },
    ...(body === undefined
      ? {}
      : { body: contentType === undefined ? JSON.stringify(body) : String(body) }),
  });
  const text = (await response.text()).slice(0, 1_048_576);
  let value;
  try {
    value = text === "" ? undefined : JSON.parse(text);
  } catch {
    value = undefined;
  }
  return { status: response.status, value };
}

export async function expectNative(io, method, path, body, statuses, contentType) {
  const result = await io.request(method, path, body, contentType);
  if (!statuses.includes(result.status))
    throw new QualificationPreparationError("native-response-unexpected", result.status);
  return result.value;
}
