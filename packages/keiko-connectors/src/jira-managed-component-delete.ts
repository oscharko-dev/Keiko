import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  gateJiraBulkReferenceChange,
  type JiraIssueTemplateSource,
} from "./jira-managed-template-gate.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { jiraNativeId } from "./jira-native-values.js";
import {
  readReleaseContext,
  reviewedReleaseEntity,
  readReleaseCollection,
  releaseSelection,
  releaseSnapshot,
  releaseExactFields,
  releaseInvalid,
  releaseReceipt,
  releaseSnapshotMatches,
  releaseUnconfirmed,
  RELEASE_MALFORMED,
  type ReleaseSelection,
  type ReleaseContext,
  type JiraReleaseMutationAttempt,
  type JiraReleaseMutationReceipt,
} from "./jira-release-mutation-values.js";

interface Input {
  readonly selected: ReleaseSelection;
  readonly replacement?: { readonly id: string; readonly snapshot: CatalogJsonObject };
}
const FIELDS = new Set([
  "componentId",
  "expectedProjectId",
  "expectedActorKey",
  "expectedComponentSnapshot",
  "moveIssuesTo",
  "expectedReplacementSnapshot",
]);
function input(args: CatalogJsonObject): Input | undefined {
  const selected = releaseSelection("component", args);
  if (selected === undefined || !releaseExactFields(args, FIELDS)) return undefined;
  if (args.moveIssuesTo === null)
    return Object.hasOwn(args, "expectedReplacementSnapshot") ? undefined : { selected };
  const snapshot = releaseSnapshot("component", args.expectedReplacementSnapshot);
  return !jiraNativeId(args.moveIssuesTo) ||
    args.moveIssuesTo === selected.id ||
    snapshot === undefined
    ? undefined
    : { selected, replacement: { id: args.moveIssuesTo, snapshot } };
}
async function confirm(
  request: JiraMutationRequest,
  selected: Input,
  receipt: JiraReleaseMutationReceipt,
): Promise<JiraReleaseMutationAttempt> {
  try {
    const rebound = await readReleaseContext(request, selected.selected);
    if (!rebound.ok) return { ...rebound, receipt };
    const current = await readReleaseCollection(request, "component", rebound.value);
    if (!current.ok) return { ...current, receipt };
    if (current.value.some((component) => component.id === selected.selected.id))
      return releaseUnconfirmed(
        "The reviewed component remains visible in the complete same-project collection. Deletion is not confirmed; retain the known ID and do not replay.",
        receipt,
      );
    const replacement = selected.replacement;
    if (
      replacement !== undefined &&
      !current.value.some(
        (component) =>
          component.id === replacement.id &&
          releaseSnapshotMatches(component.snapshot, replacement.snapshot),
      )
    )
      return releaseUnconfirmed(
        "The replacement component could not be independently matched in its complete project collection. Do not replay the deletion or infer issue reassignment.",
        receipt,
      );
    return releaseUnconfirmed(
      "The component is absent from the independently read same-project collection. This does not prove every related issue was cleared or reassigned. The deletion and issue-reference effects remain unconfirmed; do not replay.",
      receipt,
    );
  } catch (error) {
    throw new JiraAcknowledgedMutationError(error, receipt);
  }
}
async function reviewed(
  request: JiraMutationRequest,
  selected: Input,
  context: ReleaseContext,
): Promise<JiraReleaseMutationAttempt | undefined> {
  const source = await reviewedReleaseEntity(
    request,
    "component",
    selected.selected.id,
    selected.selected.snapshot,
    context,
  );
  if (!source.ok) return source;
  if (selected.replacement === undefined) return undefined;
  const target = await reviewedReleaseEntity(
    request,
    "component",
    selected.replacement.id,
    selected.replacement.snapshot,
    context,
  );
  return target.ok ? undefined : target;
}
type ComponentSelection = NonNullable<ReturnType<typeof input>>;
function deletionReceipt(
  selected: ComponentSelection,
  context: Parameters<typeof releaseReceipt>[2],
): ReturnType<typeof releaseReceipt> & { readonly replacementComponentId?: string } {
  return {
    ...releaseReceipt("component", selected.selected, context),
    ...(selected.replacement === undefined
      ? {}
      : { replacementComponentId: selected.replacement.id }),
  };
}
async function sendDelete(
  request: JiraMutationRequest,
  selected: ComponentSelection,
  receipt: ReturnType<typeof deletionReceipt>,
): Promise<JiraReleaseMutationAttempt> {
  const query =
    selected.replacement === undefined
      ? ""
      : `?${new URLSearchParams({ moveIssuesTo: selected.replacement.id }).toString()}`;
  const response = await request(
    `component/${selected.selected.id}${query}`,
    "DELETE",
    undefined,
    "none",
  );
  if (!response.ok) return { ...dispatchFailure(response), receipt };
  if (response.status < 200 || response.status >= 300) return { ...RELEASE_MALFORMED, receipt };
  return confirm(request, selected, receipt);
}
export function isJiraComponentDelete(name: string): name is "jira.delete-component" {
  return name === "jira.delete-component";
}
/** ComponentResource.delete (11.3.3): null moveIssuesTo explicitly removes related issue references.
 * https://docs.atlassian.com/software/jira/docs/api/11.3.3/com/atlassian/jira/rest/v2/issue/ComponentResource.html
 */
export async function executeJiraComponentDelete(
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  check = false,
  templates?: JiraIssueTemplateSource,
): Promise<JiraReleaseMutationAttempt> {
  const selected = input(args);
  if (selected === undefined)
    return releaseInvalid(
      "Review the connected actor, exact component/project and complete component metadata. Explicit moveIssuesTo:null removes references; a replacement needs a different same-project component ID and its reviewed metadata. Nothing was written.",
    );
  const context = await readReleaseContext(request, selected.selected);
  if (!context.ok) return context;
  const refusal = await reviewed(request, selected, context.value);
  if (refusal !== undefined) return refusal;
  const gate = await gateJiraBulkReferenceChange({
    request,
    source: templates,
    projectKey: context.value.projectKey,
    kind: "component",
  });
  if (!gate.ok)
    return {
      ...gate,
      detail: {
        messages: [
          "The complete effect of this bulk component change on saved formal issue rules cannot be established. Nothing was written. Correct affected references through governed jira.edit; this bulk operation remains unavailable while matching formal rules require those fields. Repair unreadable rules before continuing.",
        ],
      },
    };
  if (check) return { ok: true, receipt: {} };
  const receipt = deletionReceipt(selected, context.value);
  return sendDelete(request, selected, receipt);
}
