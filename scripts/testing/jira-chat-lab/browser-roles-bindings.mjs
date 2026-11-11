// @ts-check
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isChatJiraPodId } from "@oscharko-dev/keiko-contracts/bff-wire";
import { isAtlassianConnectorAuthRef } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";

/** @typedef {"projectLead" | "developer" | "techLead"} BrowserRole */
/** @typedef {{key: string, name: string, tokenFile: string}} RoleActor */
/** @typedef {{actors: Record<BrowserRole, RoleActor>}} RoleFixture */
/** @typedef {Pick<import("@oscharko-dev/keiko-contracts/bff-wire").Chat, "id" | "status" | "jiraPodBinding" | "jiraBindingGeneration">} BindingChat */
/** @typedef {import("@oscharko-dev/keiko-contracts/runtime/atlassian-connectors").AtlassianCredentialPublicMetadata} PublicCredential */
/** @typedef {{chat: BindingChat, credential: PublicCredential, expectedChatId: string, expectedLabel: string}} RoleObservation */
/** @typedef {{chatId: string, podId: string, principalDigest: string, patFileDigest: string, authRefDigest: string, bindingGeneration: number, authenticationGeneration: number, verificationRevision: number}} RoleBinding */
/** @typedef {{schemaVersion: 1, roles: Readonly<Record<BrowserRole, Readonly<RoleBinding>>>}} BindingSnapshot */

const ROLES = /** @type {const} */ (["projectLead", "developer", "techLead"]);

/** @param {unknown} condition @returns {asserts condition} */
function requireBinding(condition) {
  if (!condition) throw new TypeError("Role authentication binding is unavailable or changed");
}

/** @param {unknown} value @returns {value is string} */
function identityText(value) {
  return typeof value === "string" && value.length > 0 && !/\p{Cc}/u.test(value);
}

/** @param {unknown} value @returns {value is number} */
function generation(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** @param {string} value */
function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Both the seed owner and later metadata checks require three distinct native actors/PAT files.
 * @param {Record<BrowserRole, RoleActor>} actors
 */
export function assertDistinctBrowserRoleActors(actors) {
  requireBinding(actors !== null && typeof actors === "object");
  for (const key of /** @type {const} */ (["key", "name", "tokenFile"])) {
    const values = ROLES.map((role) => actors[role]?.[key]);
    requireBinding(values.every(identityText) && new Set(values).size === ROLES.length);
  }
  requireBinding(ROLES.every((role) => isAbsolute(actors[role].tokenFile)));
}

/** @param {PublicCredential} credential @param {string} label */
function readyPod(credential, label) {
  requireBinding(credential?.provider === "jira" && credential.authScheme === "bearer-pat");
  requireBinding(credential.deployment === "data-center" && credential.displayName === label);
  requireBinding(isAtlassianConnectorAuthRef(credential.authRef));
  const pod = credential.livePod;
  requireBinding(pod?.kind === "jira-live" && isChatJiraPodId(pod.podId));
  requireBinding(pod.verificationStatus === "ok" && pod.verificationInProgress === false);
  requireBinding(generation(pod.verificationRevision));
  requireBinding(Array.isArray(pod.capabilities) && pod.capabilities.length === 2);
  requireBinding(pod.capabilities.includes("live-read") && pod.capabilities.includes("live-write"));
  requireBinding(generation(credential.generation));
  requireBinding(credential.generation === pod.authenticationGeneration);
  return { credential, pod };
}

/** @param {RoleActor} actor @param {RoleObservation} observation @returns {Readonly<RoleBinding>} */
function roleBinding(actor, observation) {
  requireBinding(observation !== null && typeof observation === "object");
  requireBinding(
    identityText(observation.expectedChatId) && identityText(observation.expectedLabel),
  );
  const { chat } = observation;
  requireBinding(chat?.id === observation.expectedChatId && chat.status !== "closed");
  const { credential, pod } = readyPod(observation.credential, observation.expectedLabel);
  const binding = chat.jiraPodBinding;
  requireBinding(binding?.podId === pod.podId);
  requireBinding(generation(binding.bindingGeneration));
  requireBinding(binding.bindingGeneration === chat.jiraBindingGeneration);
  requireBinding(binding.authenticationGeneration === credential.generation);
  return Object.freeze({
    chatId: chat.id,
    podId: pod.podId,
    // Public metadata deliberately omits custody ownerDigest. Native seed identity stays hashed.
    principalDigest: digest(JSON.stringify([actor.key, actor.name])),
    patFileDigest: digest(actor.tokenFile),
    authRefDigest: digest(credential.authRef),
    bindingGeneration: binding.bindingGeneration,
    authenticationGeneration: binding.authenticationGeneration,
    verificationRevision: pod.verificationRevision,
  });
}

/** @param {Readonly<Record<BrowserRole, Readonly<RoleBinding>>>} roles */
function distinctBindings(roles) {
  for (const key of /** @type {const} */ (["chatId", "podId", "authRefDigest"]))
    requireBinding(new Set(ROLES.map((role) => roles[role][key])).size === ROLES.length);
}

/**
 * Check actual currentChat/credential GET projections after opening all roles and again before
 * PL8. expectedLabel names the Pod, not the generic browser Chat title. No network or writes.
 * @param {RoleFixture} fixture
 * @param {Record<BrowserRole, RoleObservation>} observations
 * @param {BindingSnapshot} [previous]
 * @returns {Readonly<BindingSnapshot>}
 */
export function verifyBrowserRoleBindings(fixture, observations, previous) {
  assertDistinctBrowserRoleActors(fixture?.actors);
  requireBinding(observations !== null && typeof observations === "object");
  requireBinding(Object.keys(observations).length === ROLES.length);
  const roles = Object.freeze({
    projectLead: roleBinding(fixture.actors.projectLead, observations.projectLead),
    developer: roleBinding(fixture.actors.developer, observations.developer),
    techLead: roleBinding(fixture.actors.techLead, observations.techLead),
  });
  distinctBindings(roles);
  const snapshot = Object.freeze({ schemaVersion: /** @type {const} */ (1), roles });
  if (previous !== undefined) requireBinding(isDeepStrictEqual(snapshot, previous));
  return snapshot;
}
