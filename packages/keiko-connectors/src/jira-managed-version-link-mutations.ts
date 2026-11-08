import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import {
  readReleaseContext,
  reviewedReleaseEntity,
  type ReleaseContext,
} from "./jira-release-mutation-values.js";
import {
  JIRA_VERSION_LINK_MUTATIONS,
  parseVersionLinkInput,
  readVersionLinkSet,
  sameVersionLinks,
  versionLinkRefusal,
  VERSION_LINK_MALFORMED,
  VERSION_LINK_RECEIPT_BYTES_MAX,
  type JiraVersionLinkMutation,
  type JiraVersionLinkAttempt,
  type JiraVersionLinkReceipt,
  type VersionLinkInput,
  type VersionLinkObservation,
} from "./jira-version-link-mutation-values.js";

export function isJiraVersionLinkMutation(name: string): name is JiraVersionLinkMutation {
  return (JIRA_VERSION_LINK_MUTATIONS as readonly string[]).includes(name);
}
async function parent(
  request: JiraMutationRequest,
  input: VersionLinkInput,
): Promise<VersionLinkObservation<ReleaseContext>> {
  const context = await readReleaseContext(request, input.selected);
  if (!context.ok) return context;
  const version = await reviewedReleaseEntity(
    request,
    "version",
    input.selected.id,
    input.selected.snapshot,
    context.value,
  );
  return version.ok ? context : version;
}
function receiptFor(input: VersionLinkInput, context: ReleaseContext): JiraVersionLinkReceipt {
  return {
    ...context,
    versionId: input.selected.id,
    linkPresent: input.value !== undefined,
    ...(input.globalId === undefined
      ? { globalIds: input.expected.map(({ globalId }) => globalId) }
      : { globalId: input.globalId }),
  };
}
function resource(input: VersionLinkInput): string {
  const collection = `version/${input.selected.id}/remotelink`;
  if (
    input.operation === "jira.upsert-version-remote-link" ||
    input.operation === "jira.delete-version-remote-links"
  )
    return collection;
  if (input.globalId === undefined)
    throw new TypeError("A parsed selected version link must have a global ID");
  return `${collection}/${encodeURIComponent(input.globalId)}`;
}
async function confirm(
  request: JiraMutationRequest,
  input: VersionLinkInput,
  before: ReleaseContext,
  receipt: JiraVersionLinkReceipt,
): Promise<JiraVersionLinkAttempt> {
  try {
    const current = await parent(request, input);
    if (!current.ok)
      return {
        ...current,
        receipt,
        detail: {
          messages: [
            "Jira acknowledged this version-link mutation, but the actor/project/version could not be independently rebound. Keep the known context and do not replay.",
          ],
        },
      };
    if (current.value.projectKey !== before.projectKey || current.value.userKey !== before.userKey)
      return versionLinkRefusal(
        "The native project or actor changed after acknowledgement. Do not replay this mutation.",
        "conflict",
        receipt,
      );
    const observed = await readVersionLinkSet(request, input.selected.id, input.desired);
    if (!observed.ok)
      return {
        ...observed,
        receipt,
        detail: {
          messages: [
            "Jira acknowledged the mutation, but the complete same-version link set is unavailable or differs from the requested state. A missing or forbidden resource is not proof of absence. Do not repeat the write.",
          ],
        },
      };
    return sameVersionLinks(observed.value, input.desired)
      ? { ok: true, receipt }
      : versionLinkRefusal(
          "The complete independently read link values do not match the desired set. Retain the exact version/global IDs; do not replay.",
          "conflict",
          receipt,
        );
  } catch (error) {
    throw new JiraAcknowledgedMutationError(error, receipt);
  }
}
/** VersionResource/RemoteVersionLinkService 11.3.3 accept the raw JSON link value.
 * A collection POST takes globalId from that value; explicit-path POST selects it by path.
 * Neither changes issue fields, fixVersions, version metadata or formal issue relations.
 * https://docs.atlassian.com/software/jira/docs/api/11.3.3/com/atlassian/jira/bc/project/version/remotelink/RemoteVersionLinkService.html
 */
export async function executeJiraVersionLinkMutation(
  operation: JiraVersionLinkMutation,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  check = false,
): Promise<JiraVersionLinkAttempt> {
  const parsed = parseVersionLinkInput(operation, args);
  if (!parsed.ok) return parsed;
  const input = parsed.value;
  const context = await parent(request, input);
  if (!context.ok) return context;
  const current = await readVersionLinkSet(request, input.selected.id, input.expected);
  if (!current.ok) return current;
  if (!sameVersionLinks(current.value, input.expected))
    return versionLinkRefusal(
      "The complete native link values changed after review. Read the links again before requesting this mutation; nothing was written.",
      "conflict",
    );
  const receipt = receiptFor(input, context.value);
  if (Buffer.byteLength(JSON.stringify(receipt), "utf8") > VERSION_LINK_RECEIPT_BYTES_MAX)
    return versionLinkRefusal(
      "The complete reviewed identity set exceeds the existing receipt budget. Nothing was written; use separately reviewed selected-link operations.",
      "bounds-exceeded",
    );
  if (sameVersionLinks(current.value, input.desired))
    return {
      ...versionLinkRefusal(
        "The complete reviewed link set already matches the requested state. Nothing was written.",
        "conflict",
        receipt,
      ),
      detail: { unchanged: true },
    };
  if (check) return { ok: true, receipt: {} };
  const response = await request(
    resource(input),
    input.value === undefined ? "DELETE" : "POST",
    input.value,
    "none",
  );
  if (!response.ok) return { ...dispatchFailure(response), receipt };
  if (response.status < 200 || response.status >= 300)
    return { ...VERSION_LINK_MALFORMED, receipt };
  // ACK Location is not followed or used to infer a generated or different identity.
  return confirm(request, input, context.value, receipt);
}
