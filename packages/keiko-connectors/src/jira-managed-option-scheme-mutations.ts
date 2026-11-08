import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { jiraNativeNumericId } from "./jira-native-values.js";
import { readSavedActor } from "./jira-saved-configuration-values.js";
import { bindSchemeOptions, bindSchemeProjects, readOptionScheme, readSchemeProjects } from "./jira-option-scheme-observations.js";
import { parseSchemeMutation, sameScheme, sameSchemeIds, sameSchemeProjects, schemePath, schemeRefusal, SCHEME_MALFORMED,
  type SchemeAttempt, type SchemeFailure, type SchemeReceipt, type SchemeSelection, type SchemeProject, type SchemeSnapshot } from "./jira-option-scheme-values.js";
export { JIRA_OPTION_SCHEME_MUTATIONS, isJiraOptionSchemeMutation } from "./jira-option-scheme-values.js";

function receipt(input: SchemeSelection, id = input.expected?.id): SchemeReceipt {
  const projects = input.change === "clear" ? input.expectedProjects : input.projects;
  return { userKey: input.actor, schemePresent: !input.operation.startsWith("jira.delete-"),
    ...(id === undefined ? {} : { schemeId: id }),
    ...(input.change === undefined ? {} : { associationChange: input.change }),
    ...(projects === undefined ? {} : { projectIds: projects.map((project) => project.id), projectKeys: projects.map((project) => project.key) }) };
}
function desiredScheme(input: SchemeSelection, id: string): SchemeSnapshot | undefined {
  const target = input.target;
  return target === undefined ? undefined : { ...target, id,
    ...(input.expected?.defaultScheme === undefined ? {} : { defaultScheme: input.expected.defaultScheme }) };
}
function desiredProjects(input: SchemeSelection): readonly SchemeProject[] {
  const current = input.expectedProjects ?? []; const selected = input.projects ?? [];
  if (input.change === "clear") return [];
  if (input.change === "replace") return selected;
  if (input.change === "remove") return current.filter((project) => !selected.some((other) => project.id === other.id));
  return [...current, ...selected.filter((project) => !current.some((other) => project.id === other.id))];
}
async function admitAssociations(request: JiraMutationRequest, input: SchemeSelection): Promise<SchemeFailure | undefined> {
  if (input.change === undefined || input.expected === undefined || input.expectedProjects === undefined) return undefined;
  const current = await readSchemeProjects(request, input.expected.id);
  if (!current.ok) return current;
  if (!sameSchemeProjects(current.value, input.expectedProjects)) return schemeRefusal("The native scheme's complete project association configuration changed. Review it again.", "conflict");
  const projects = [...input.expectedProjects, ...(input.projects ?? [])];
  const bound = await bindSchemeProjects(request, projects);
  if (bound !== undefined) return bound;
  if (input.change === "remove" && !current.value.some((project) => project.id === input.projects?.[0]?.id))
    return schemeRefusal("The selected project is not associated with this reviewed scheme.", "conflict");
  return sameSchemeProjects(current.value, desiredProjects(input))
    ? { ...schemeRefusal("The reviewed association configuration is already current.", "conflict", receipt(input)), detail: { unchanged: true } } : undefined;
}
async function admitExisting(request: JiraMutationRequest, input: SchemeSelection, expected: SchemeSnapshot): Promise<SchemeFailure | undefined> {
  const current = await readOptionScheme(request, input.kind, expected.id);
  if (!current.ok) return current;
  if (!sameScheme(current.value, expected)) return schemeRefusal("The scheme identity, metadata, option order or default changed. Reread the native configuration before approving it.", "conflict");
  if (input.operation === "jira.delete-priority-scheme" && current.value.defaultScheme === true)
    return schemeRefusal("Jira's global default priority scheme cannot be deleted.", "conflict");
  const desired = desiredScheme(input, expected.id);
  return desired !== undefined && sameScheme(current.value, desired)
    ? { ...schemeRefusal("The reviewed scheme is already current.", "conflict", receipt(input)), detail: { unchanged: true } } : undefined;
}
async function admit(request: JiraMutationRequest, input: SchemeSelection): Promise<SchemeFailure | undefined> {
  const actor = await readSavedActor(request, input.actor);
  if (!actor.ok) return actor;
  if (input.expected !== undefined) { const current = await admitExisting(request, input, input.expected); if (current !== undefined) return current; }
  if (input.target !== undefined) { const options = await bindSchemeOptions(request, input.kind, input.target); if (options !== undefined) return options; }
  return admitAssociations(request, input);
}
interface SchemeEffect { readonly path: string; readonly method: "POST" | "PUT" | "DELETE"; readonly body?: CatalogJsonObject; readonly expect: "json" | "none" }
function configurationEffect(input: SchemeSelection): SchemeEffect | undefined {
  const target = input.target;
  if (target === undefined) return undefined;
  const base = schemePath(input.kind); const id = input.expected?.id;
  const body = { name: target.name, description: target.description,
    ...(input.kind === "issue-type" ? { defaultIssueTypeId: target.defaultId, issueTypeIds: target.ids }
      : { defaultOptionId: target.defaultId, optionIds: target.ids }) };
  return id === undefined ? { path: base, method: "POST", body, expect: "json" }
    : { path: `${base}/${id}`, method: "PUT", body, expect: "none" };
}
function effect(input: SchemeSelection): SchemeEffect | undefined {
  if (input.target !== undefined) return configurationEffect(input);
  const id = input.expected?.id;
  if (id === undefined) return undefined;
  const base = `${schemePath(input.kind)}/${id}`;
  if (input.change === undefined) return { path: base, method: "DELETE", expect: "none" };
  const path = `${base}/associations`;
  if (input.change === "remove") { const project = input.projects?.[0]; return project === undefined ? undefined : { path: `${path}/${project.id}`, method: "DELETE", expect: "none" }; }
  if (input.change === "clear") return { path, method: "DELETE", expect: "none" };
  return { path, method: input.change === "add" ? "POST" : "PUT", body: { idsOrKeys: (input.projects ?? []).map((project) => project.id) }, expect: "none" };
}
function unconfirmed(known: SchemeReceipt, message: string): SchemeFailure {
  return schemeRefusal(`${message} Jira acknowledged the request. Keep the known IDs; do not automatically repeat it.`, "unavailable", known);
}
function matchesTarget(input: SchemeSelection, actual: SchemeSnapshot): boolean {
  const target = input.target;
  if (target === undefined) return false;
  return actual.name === target.name && actual.description === target.description && actual.defaultId === target.defaultId && sameSchemeIds(actual.ids, target.ids);
}
async function confirmAssociations(request: JiraMutationRequest, input: SchemeSelection, known: SchemeReceipt, id: string): Promise<SchemeAttempt> {
  const associations = await readSchemeProjects(request, id);
  if (!associations.ok) return { ...associations, receipt: known };
  const bound = await bindSchemeProjects(request, [...(input.expectedProjects ?? []), ...(input.projects ?? [])]);
  if (bound !== undefined) return { ...bound, receipt: known };
  return unconfirmed(known, sameSchemeProjects(associations.value, desiredProjects(input))
    ? "The selected scheme's native associations match, but default-scheme and project-population consequences are not independently proven."
    : "The selected scheme's native associations do not match the complete intended configuration.");
}
async function confirmConfiguration(request: JiraMutationRequest, input: SchemeSelection, known: SchemeReceipt, id: string): Promise<SchemeAttempt> {
  const current = await readOptionScheme(request, input.kind, id);
  if (!current.ok) return { ...current, receipt: known };
  if (input.target !== undefined) {
    const defaultChanged = input.expected !== undefined && current.value.defaultScheme !== input.expected.defaultScheme;
    if (!matchesTarget(input, current.value) || defaultChanged) return unconfirmed(known, "The independently reread scheme does not match every reviewed target fact.");
    return { ok: true, receipt: known };
  }
  if (input.expected === undefined || !sameScheme(current.value, input.expected)) return unconfirmed(known, "The scheme changed during the association operation.");
  return confirmAssociations(request, input, known, id);
}
async function confirm(request: JiraMutationRequest, input: SchemeSelection, known: SchemeReceipt, id: string): Promise<SchemeAttempt> {
  try {
    const actor = await readSavedActor(request, input.actor);
    if (!actor.ok) return { ...actor, receipt: known };
    if (input.operation.startsWith("jira.delete-")) {
      const selected = await request(`${schemePath(input.kind)}/${id}`);
      if (!selected.ok && selected.reason !== "not-found") return { ...dispatchFailure(selected), receipt: known };
      return unconfirmed(known, "A 404 for the selected resource or a visible-list omission cannot prove all deletion/default-association consequences.");
    }
    return await confirmConfiguration(request, input, known, id);
  } catch (error) { throw new JiraAcknowledgedMutationError(error, known); }
}
/** Native IssueTypeSchemeResource and priority updates reject required issue migrations.
 * These endpoints change configuration, not governed issue fields. Future issue writes still
 * resolve current metadata and formal rules in their existing owners; never infer a migration
 * or blanket-refuse unrelated active rules. Default/association consequences remain unconfirmed. */
export async function executeJiraOptionSchemeMutation(operation: string, args: CatalogJsonObject, request: JiraMutationRequest, check = false): Promise<SchemeAttempt> {
  const input = parseSchemeMutation(operation, args);
  if (input === undefined) return schemeRefusal("Review the native actor, complete scheme metadata, ordered issue-type/priority IDs and explicit default. Association writes require complete reviewed project IDs/keys/names and explicit unverified-consequence acceptance. No URLs, implicit defaults, unknown-as-empty collections or migrations are supported.");
  const refusal = await admit(request, input);
  if (refusal !== undefined) return refusal;
  if (check) return { ok: true, receipt: {} };
  const selected = effect(input);
  if (selected === undefined) return SCHEME_MALFORMED;
  const known = receipt(input);
  const response = await request(selected.path, selected.method, selected.body, selected.expect);
  if (!response.ok) return { ...dispatchFailure(response), receipt: known };
  const id = input.expected?.id ?? jiraNativeNumericId(response.body?.id);
  if (id === undefined) return { ...SCHEME_MALFORMED, receipt: known };
  return confirm(request, input, receipt(input, id), id);
}
