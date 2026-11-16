import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asRecord } from "./atlassian-sync-classify.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { bindIssueLifecycleIssue } from "./jira-issue-lifecycle-observations.js";
import {
  readCompleteRemoteLinks,
  type RemoteLinkSnapshot,
} from "./jira-remote-link-mutation-values.js";
import { dispatchFailure } from "./jira-mutation-failure.js";
import { readSavedActor } from "./jira-saved-configuration-values.js";
import type { JiraReciprocalConfigurationPorts } from "./jira-reciprocal-configuration-request.js";
import {
  RECIPROCAL_MALFORMED,
  jiraApplicationLinkId,
  reciprocalApplication,
  reciprocalFailure,
  reciprocalGlobalId,
  reciprocalManifest,
  reciprocalRefusal,
  sameReciprocalApplication,
  type ReciprocalApplication,
  type ReciprocalFailure,
  type ReciprocalInput,
  type ReciprocalManifest,
  type ReciprocalObservation,
} from "./jira-reciprocal-link-values.js";

function selectedConfiguration(
  list: readonly unknown[],
  selectedId: string,
): ReciprocalObservation<Record<string, unknown>> {
  const ids = new Set<string>();
  let found: Record<string, unknown> | undefined;
  for (const value of list) {
    const row = asRecord(value);
    const app = asRecord(row?.application);
    if (row === undefined || app === undefined || !jiraApplicationLinkId(app.id))
      return RECIPROCAL_MALFORMED;
    const identity = app.id.toLowerCase();
    if (ids.has(identity)) return RECIPROCAL_MALFORMED;
    ids.add(identity);
    if (app.id === selectedId) found = row;
  }
  return found === undefined
    ? reciprocalRefusal(
        "The selected configured application link is not independently available in the complete native configuration response.",
        "conflict",
      )
    : { ok: true, value: found };
}
function readyApplication(row: Record<string, unknown>): ReciprocalApplication | undefined {
  const raw = asRecord(row.application);
  if (
    raw?.typeId !== "jira" ||
    row.appLinkState !== "OK" ||
    row.hasIncomingAuthenticationProviders !== true ||
    row.hasOutgoingAuthenticationProviders !== true
  )
    return undefined;
  return reciprocalApplication(raw);
}
function configuredApplication(
  body: unknown,
  selected: ReciprocalApplication,
): ReciprocalObservation<ReciprocalApplication> {
  const list = asRecord(body)?.list;
  if (!Array.isArray(list)) return RECIPROCAL_MALFORMED;
  if (list.length > TOOL_CATALOG_LIMITS.maxArrayItems)
    return { ok: false, reason: "bounds-exceeded" };
  const found = selectedConfiguration(list, selected.id);
  if (!found.ok) return found;
  const app = readyApplication(found.value);
  if (app === undefined)
    return reciprocalRefusal(
      "The selected native Jira application link is not fully configured for reciprocal authentication. No delegation was sent; this does not infer the remote actor's identity or permission.",
      "unavailable",
    );
  return sameReciprocalApplication(app, selected)
    ? { ok: true, value: app }
    : reciprocalRefusal(
        "The configured application link name or destination changed from the review. No destination from a remote-link content field can replace configuration.",
        "conflict",
      );
}
export async function observeReciprocalConfiguration(
  ports: JiraReciprocalConfigurationPorts,
  input: ReciprocalInput,
): Promise<ReciprocalObservation<ReciprocalManifest>> {
  const local = await ports.manifest();
  if (!local.ok) return reciprocalFailure(dispatchFailure(local));
  const manifest = local.status === 200 ? reciprocalManifest(local.body) : undefined;
  if (manifest === undefined) return RECIPROCAL_MALFORMED;
  if (manifest.id.toLowerCase() === input.application.id.toLowerCase())
    return reciprocalRefusal(
      "Reciprocal delegation requires a different configured Jira application, not the local manifest identity.",
    );
  const remote = await ports.applicationLinks();
  if (!remote.ok) return reciprocalFailure(dispatchFailure(remote));
  if (remote.status !== 200) return RECIPROCAL_MALFORMED;
  const configured = configuredApplication(remote.body, input.application);
  return configured.ok ? { ok: true, value: manifest } : configured;
}
export async function observeReciprocalLinks(
  request: JiraMutationRequest,
  input: ReciprocalInput,
  beforeEffect = false,
): Promise<ReciprocalObservation<readonly RemoteLinkSnapshot[]>> {
  // Before the request a key that is not the connected user's is an argument to correct (#4357 AC3);
  // after an acknowledgement it is an identity that changed, and the old words stand.
  const actor = await readSavedActor(
    request,
    input.actor,
    beforeEffect ? { beforeEffect: true, mismatchAs: "conflict" } : {},
  );
  if (!actor.ok) return reciprocalFailure(actor);
  const issue = await bindIssueLifecycleIssue(request, input.issue);
  if (issue !== undefined) return reciprocalFailure(issue);
  const links = await readCompleteRemoteLinks(request, {
    id: input.issue.id,
    key: input.issue.key,
    fields: {},
  });
  return links.ok ? links : reciprocalFailure(links);
}
export function reciprocalAlreadyPresent(
  input: ReciprocalInput,
  links: readonly RemoteLinkSnapshot[],
): ReciprocalFailure | undefined {
  return links.some(
    (link) => link.globalId === reciprocalGlobalId(input.application.id, input.remoteId),
  )
    ? reciprocalRefusal(
        "The selected remote global ID already exists locally. A reciprocal POST could replace it; this supported create path requires reviewed local absence and never infers an unchanged remote backlink.",
        "conflict",
      )
    : undefined;
}
