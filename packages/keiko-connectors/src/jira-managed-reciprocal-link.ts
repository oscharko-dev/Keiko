import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  gateJiraMutationByTemplates,
  type JiraIssueTemplateSource,
} from "./jira-managed-template-gate.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import type { JiraReciprocalConfigurationPorts } from "./jira-reciprocal-configuration-request.js";
import {
  observeReciprocalConfiguration,
  observeReciprocalLinks,
  reciprocalAlreadyPresent,
} from "./jira-reciprocal-link-observations.js";
import {
  checkReciprocalInput,
  reciprocalInputRefusal,
  reciprocalBody,
  reciprocalFailure,
  reciprocalGlobalId,
  reciprocalReceipt,
  reciprocalRefusal,
  type ReciprocalAttempt,
  type ReciprocalFailure,
  type ReciprocalInput,
  type ReciprocalManifest,
  type ReciprocalReceipt,
} from "./jira-reciprocal-link-values.js";
import { sameRemoteLinks } from "./jira-remote-link-mutation-values.js";

export function isJiraReciprocalRemoteLink(
  name: string,
): name is "jira.create-reciprocal-remote-link" {
  return name === "jira.create-reciprocal-remote-link";
}
interface Admitted {
  readonly ok: true;
  readonly body: CatalogJsonObject;
  readonly receipt: ReciprocalReceipt;
}
async function admit(
  request: JiraMutationRequest,
  ports: JiraReciprocalConfigurationPorts,
  input: ReciprocalInput,
  templates: JiraIssueTemplateSource | undefined,
): Promise<Admitted | ReciprocalFailure> {
  const configuration = await observeReciprocalConfiguration(ports, input);
  if (!configuration.ok) return configuration;
  const prior = await observeReciprocalLinks(request, input, true);
  if (!prior.ok) return prior;
  const absent = reciprocalAlreadyPresent(input, prior.value);
  if (absent !== undefined) return absent;
  const gate = await gateJiraMutationByTemplates({
    request,
    source: templates,
    operation: "edit",
    metadata: [],
    target: { issueKey: input.issue.id },
    validated: { fields: {}, update: {} },
  });
  if (!gate.ok) return reciprocalFailure(gate);
  return recheck(request, ports, input, configuration.value, prior.value);
}
async function recheck(
  request: JiraMutationRequest,
  ports: JiraReciprocalConfigurationPorts,
  input: ReciprocalInput,
  configuration: ReciprocalManifest,
  prior: Parameters<typeof sameRemoteLinks>[0],
): Promise<Admitted | ReciprocalFailure> {
  const current = await observeReciprocalLinks(request, input, true);
  if (!current.ok) return current;
  if (!sameRemoteLinks(prior, current.value))
    return reciprocalRefusal(
      "The complete local remote-link state changed during admission; no request was sent.",
      "conflict",
    );
  const currentConfiguration = await observeReciprocalConfiguration(ports, input);
  if (!currentConfiguration.ok) return currentConfiguration;
  if (!sameManifest(configuration, currentConfiguration.value))
    return reciprocalRefusal(
      "The local manifest changed during admission; no request was sent.",
      "conflict",
    );
  const body = reciprocalBody(input, currentConfiguration.value, ports.baseUrl);
  if (body === undefined)
    return reciprocalRefusal("The bound configuration cannot produce safe fixed issue references.");
  const receipt = reciprocalReceipt(input);
  return new TextEncoder().encode(JSON.stringify(receipt)).byteLength > 16_384
    ? { ok: false, reason: "bounds-exceeded" }
    : { ok: true, body, receipt };
}
function sameManifest(left: ReciprocalManifest, right: ReciprocalManifest): boolean {
  return left.id === right.id && left.name === right.name;
}
async function readAfterAcknowledgement(
  request: JiraMutationRequest,
  input: ReciprocalInput,
  receipt: ReciprocalReceipt,
): Promise<ReciprocalFailure> {
  const current = await observeReciprocalLinks(request, input);
  if (!current.ok) return { ...current, receipt };
  const local = current.value.find(
    (link) => link.globalId === reciprocalGlobalId(input.application.id, input.remoteId),
  );
  const known = local === undefined ? receipt : Object.freeze({ ...receipt, linkId: local.id });
  return {
    ...reciprocalRefusal(
      "Jira acknowledged the native delegated request. Any local link ID is independently observed local context only. The selected remote issue and remote actor were not independently read; remote authentication or one side may have failed, and neither the response pair nor local readback proves both effects. Inspect both instances and never replay this request automatically.",
      "unavailable",
    ),
    receipt: known,
  };
}
/** Jira uses its configured application-link authentication. Keiko never contacts the remote
 * host or accepts an outgoing credential/header/URL. The native action can partially complete. */
export async function executeJiraReciprocalRemoteLink(
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  ports: JiraReciprocalConfigurationPorts | undefined,
  check = false,
  templates?: JiraIssueTemplateSource,
): Promise<ReciprocalAttempt> {
  const checked = checkReciprocalInput(args);
  if (!checked.ok) return reciprocalInputRefusal(checked.cause);
  const input = checked.input;
  if (ports === undefined)
    return reciprocalRefusal(
      "Fresh same-host application-link configuration and local manifest reads are unavailable. No request was sent.",
      "unavailable",
    );
  const prepared = await admit(request, ports, input, templates);
  if (!prepared.ok) return prepared;
  if (check) return { ok: true, receipt: {} };
  const response = await request("issue/remotelink/reciprocal", "POST", prepared.body, "json");
  if (!response.ok)
    return { ...reciprocalFailure(dispatchFailure(response)), receipt: prepared.receipt };
  try {
    return await readAfterAcknowledgement(request, input, prepared.receipt);
  } catch (error) {
    throw new JiraAcknowledgedMutationError(error, prepared.receipt);
  }
}
