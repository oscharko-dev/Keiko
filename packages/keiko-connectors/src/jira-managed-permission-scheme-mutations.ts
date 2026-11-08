import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { jiraNativeNumericId } from "./jira-native-values.js";
import { readSavedActor } from "./jira-saved-configuration-values.js";
import {
  readPermissionSchemeSnapshot, readPermissionSchemeIndex, readPermissionSchemeAttribute,
  admitPermissionSchemeSnapshot, samePermissionSchemeMetadata, samePermissionSchemeSnapshot,
} from "./jira-permission-scheme-observations.js";
import {
  parsePermissionSchemeInput, permissionSchemeRefusal, samePermissionGrant, samePermissionSet,
  PERMISSION_SCHEME_MALFORMED, type JiraPermissionSchemeMutation, type PermissionSchemeInput,
  type PermissionSchemeAttempt, type PermissionSchemeFailure, type PermissionSchemeReceipt,
  type PermissionSchemeSnapshot, type PermissionGrantSnapshot,
  type PermissionSchemeTarget,
} from "./jira-permission-scheme-mutation-values.js";
export { JIRA_PERMISSION_SCHEME_MUTATIONS, isJiraPermissionSchemeMutation, type JiraPermissionSchemeMutation } from "./jira-permission-scheme-mutation-values.js";

export interface JiraPermissionSchemePorts {
  readonly request: JiraMutationRequest;
  /** A fixed native PUT with text/plain bytes true/false. The host owns route, credentials,
   * authority, budgets and content type. Neither an arbitrary body nor headers are exposed. */
  readonly setAttribute?: (schemeId: string, attributeKey: string, enabled: boolean) => Promise<AtlassianWriteHttpOutcome>;
}
function receiptFor(input: PermissionSchemeInput, schemeId = input.expected?.id, permissionId = input.permissionId): PermissionSchemeReceipt {
  const base = { userKey: input.actor, ...(schemeId === undefined ? {} : { schemeId }) };
  if (input.attribute !== undefined) return { ...base, attributeKey: input.attribute.key, attributeEnabled: input.attribute.enabled };
  if (input.operation === "jira.add-permission-grant" || input.operation === "jira.delete-permission-grant")
    return { ...base, ...(permissionId === undefined ? {} : { permissionId }), grantPresent: input.operation === "jira.add-permission-grant" };
  return { ...base, schemePresent: input.operation !== "jira.delete-permission-scheme" };
}
function unchanged(message: string, receipt: PermissionSchemeReceipt): PermissionSchemeFailure {
  return { ...permissionSchemeRefusal(message, "conflict", receipt), detail: { unchanged: true, messages: [message] } };
}
function sameTarget(expected: PermissionSchemeSnapshot, target: PermissionSchemeTarget): boolean {
  return (target.name ?? expected.name) === expected.name && (target.description ?? expected.description) === expected.description &&
    (target.permissions === undefined || samePermissionSet(expected.permissions, target.permissions, false));
}
function unchangedScheme(input: PermissionSchemeInput): PermissionSchemeFailure | undefined {
  const expected = input.expected;
  if (expected === undefined) return undefined;
  if (input.operation === "jira.add-permission-grant") {
    const current = expected.permissions.find((grant) => input.grant !== undefined && samePermissionGrant(grant, input.grant));
    return current === undefined ? undefined : unchanged("This exact holder already has the requested permission. No grant was added.", receiptFor(input, expected.id, current.id));
  }
  const target = input.target;
  if (input.operation !== "jira.update-permission-scheme" || target === undefined) return undefined;
  return sameTarget(expected, target)
    ? unchanged("The reviewed permission scheme already has the requested metadata and grants. Nothing was written.", receiptFor(input)) : undefined;
}
async function admitNewScheme(request: JiraMutationRequest, input: PermissionSchemeInput): Promise<PermissionSchemeFailure | undefined> {
  const index = await readPermissionSchemeIndex(request);
  if (!index.ok) return index;
  return index.value.some(({ name }) => name === input.target?.name)
    ? permissionSchemeRefusal("A visible permission scheme already uses the exact proposed name. Review it instead of guessing another identity.", "conflict") : undefined;
}
async function admission(ports: JiraPermissionSchemePorts, input: PermissionSchemeInput): Promise<PermissionSchemeFailure | undefined> {
  const actor = await readSavedActor(ports.request, input.actor);
  if (!actor.ok) return actor;
  if (input.expected === undefined) return admitNewScheme(ports.request, input);
  const parent = await admitPermissionSchemeSnapshot(ports.request, input.expected);
  if (parent !== undefined) return parent;
  if (input.attribute === undefined) return unchangedScheme(input);
  const current = await readPermissionSchemeAttribute(ports.request, input.expected.id, input.attribute.key);
  if (!current.ok) return current;
  if (current.value !== input.attribute.expectedValue)
    return permissionSchemeRefusal("The permission-scheme attribute changed since review. Inspect it again before approving a write.", "conflict");
  return current.value === String(input.attribute.enabled)
    ? unchanged("The independently observed attribute already equals the requested Boolean value. Nothing was written.", receiptFor(input)) : undefined;
}
interface NativeEffect {
  readonly path: string;
  readonly method: "POST" | "PUT" | "DELETE";
  readonly body?: CatalogJsonObject;
  readonly expect: "json" | "none";
}
function effect(input: PermissionSchemeInput): NativeEffect | undefined {
  if (input.operation === "jira.create-permission-scheme") return input.target === undefined ? undefined
    : { path: "permissionscheme", method: "POST", body: input.target, expect: "json" };
  const expected = input.expected;
  if (expected === undefined) return undefined;
  const root = `permissionscheme/${expected.id}`;
  if (input.operation === "jira.update-permission-scheme") return input.target === undefined ? undefined
    : { path: root, method: "PUT", body: input.target, expect: "none" };
  if (input.operation === "jira.delete-permission-scheme") return { path: root, method: "DELETE", expect: "none" };
  if (input.operation === "jira.add-permission-grant") return input.grant === undefined ? undefined
    : { path: `${root}/permission`, method: "POST", body: input.grant, expect: "json" };
  return input.permissionId === undefined ? undefined
    : { path: `${root}/permission/${input.permissionId}`, method: "DELETE", expect: "none" };
}
function targetMetadataMatches(actual: PermissionSchemeSnapshot, input: PermissionSchemeInput): boolean {
  const target = input.target;
  if (target === undefined) return false;
  return actual.name === (target.name ?? input.expected?.name) && actual.description === (target.description ?? input.expected?.description);
}
function desiredGrantSnapshot(input: PermissionSchemeInput, receipt: PermissionSchemeReceipt): readonly PermissionGrantSnapshot[] | undefined {
  const expected = input.expected;
  if (expected === undefined) return undefined;
  if (input.operation === "jira.delete-permission-grant") return expected.permissions.filter(({ id }) => id !== input.permissionId);
  if (input.grant === undefined || receipt.permissionId === undefined) return undefined;
  return [...expected.permissions, { ...input.grant, id: receipt.permissionId }];
}
function matchesDesiredScheme(actual: PermissionSchemeSnapshot, input: PermissionSchemeInput, receipt: PermissionSchemeReceipt): boolean {
  if (input.target !== undefined) {
    const desired = input.target.permissions ?? input.expected?.permissions;
    return desired !== undefined && targetMetadataMatches(actual, input) &&
      samePermissionSet(actual.permissions, desired, input.target.permissions === undefined);
  }
  if (input.expected === undefined || !samePermissionSchemeMetadata(actual, input.expected)) return false;
  const grants = desiredGrantSnapshot(input, receipt);
  return grants !== undefined && samePermissionSet(actual.permissions, grants, true);
}
async function confirmAttribute(request: JiraMutationRequest, input: PermissionSchemeInput, actual: PermissionSchemeSnapshot): Promise<PermissionSchemeFailure | undefined> {
  if (input.attribute === undefined || input.expected === undefined || !samePermissionSchemeSnapshot(actual, input.expected))
    return permissionSchemeRefusal("Jira acknowledged the attribute write, but the independently read scheme or grants changed. Do not replay.", "conflict");
  const value = await readPermissionSchemeAttribute(request, actual.id, input.attribute.key);
  if (!value.ok) return value;
  return value.value === String(input.attribute.enabled) ? undefined
    : permissionSchemeRefusal("Jira acknowledged the attribute write, but the independent same-key value does not match. Do not replay.", "unavailable");
}
async function confirm(ports: JiraPermissionSchemePorts, input: PermissionSchemeInput, receipt: PermissionSchemeReceipt): Promise<PermissionSchemeAttempt> {
  const request = ports.request;
  const actor = await readSavedActor(request, input.actor);
  if (!actor.ok) return { ...actor, receipt };
  if (input.operation === "jira.delete-permission-scheme") {
    const index = await readPermissionSchemeIndex(request);
    if (!index.ok) return { ...index, receipt };
    return permissionSchemeRefusal("Jira acknowledged scheme deletion. A visible scheme list, including omission of this ID, cannot independently establish every affected project association or permission effect. Keep the known ID; do not replay deletion.", "unavailable", receipt);
  }
  if (receipt.schemeId === undefined) return permissionSchemeRefusal("Jira acknowledged creation but supplied no exact scheme identity. Do not guess by name or replay the POST.", "unavailable", receipt);
  const read = await readPermissionSchemeSnapshot(request, receipt.schemeId);
  if (!read.ok) return { ...read, receipt };
  if (input.attribute !== undefined) {
    const refused = await confirmAttribute(request, input, read.value);
    return refused === undefined ? { ok: true, receipt } : { ...refused, receipt };
  }
  const matches = matchesDesiredScheme(read.value, input, receipt);
  return matches ? { ok: true, receipt } : permissionSchemeRefusal("Jira acknowledged the change, but the independently bound parent and complete grant/attribute state do not prove the requested result. Retain known identities and do not replay.", "unavailable", receipt);
}
async function acknowledged(ports: JiraPermissionSchemePorts, input: PermissionSchemeInput, response: AtlassianWriteHttpOutcome): Promise<PermissionSchemeAttempt> {
  let receipt = receiptFor(input);
  if (!response.ok) return { ...dispatchFailure(response), receipt };
  if (response.status < 200 || response.status >= 300) return { ...PERMISSION_SCHEME_MALFORMED, receipt };
  if (input.operation === "jira.create-permission-scheme") receipt = receiptFor(input, jiraNativeNumericId(response.body?.id));
  if (input.operation === "jira.add-permission-grant") receipt = receiptFor(input, input.expected?.id, jiraNativeNumericId(response.body?.id));
  try { return await confirm(ports, input, receipt); }
  catch (error) { throw new JiraAcknowledgedMutationError(error, receipt); }
}
async function write(ports: JiraPermissionSchemePorts, input: PermissionSchemeInput): Promise<PermissionSchemeAttempt> {
  if (input.attribute !== undefined) {
    if (ports.setAttribute === undefined || input.expected === undefined) return PERMISSION_SCHEME_MALFORMED;
    return acknowledged(ports, input, await ports.setAttribute(input.expected.id, input.attribute.key, input.attribute.enabled));
  }
  const native = effect(input);
  return native === undefined ? PERMISSION_SCHEME_MALFORMED
    : acknowledged(ports, input, await ports.request(native.path, native.method, native.body, native.expect));
}
/** PermissionSchemeResource owns native admin validation and holder/permission semantics.
 * PUT permissions replaces the entire set; absence preserves it and [] explicitly clears it.
 * Attribute PUT is text/plain Boolean#valueOf, never a JSON string or arbitrary header surface.
 */
export async function executeJiraPermissionSchemeMutation(operation: JiraPermissionSchemeMutation, args: CatalogJsonObject, ports: JiraPermissionSchemePorts, check = false): Promise<PermissionSchemeAttempt> {
  const input = parsePermissionSchemeInput(operation, args);
  if (input === undefined) return permissionSchemeRefusal("Use exact actor and complete native scheme/grant snapshots. New grants require documented holders with their exact parameter semantics. Anonymous anyone grants are supported only for BROWSE_PROJECTS, VIEW_DEV_TOOLS and VIEW_READONLY_WORKFLOW; use an authenticated principal for other permissions; an empty permissions list explicitly clears all grants. Unknown descriptions or attributes are unavailable review facts.");
  if (input.attribute !== undefined && ports.setAttribute === undefined)
    return permissionSchemeRefusal("The host has not supplied the fixed native text/plain Boolean attribute writer. No lookup or effect was sent.", "unavailable");
  const refused = await admission(ports, input);
  if (refused !== undefined) return refused;
  return check ? { ok: true, receipt: {} } : write(ports, input);
}
