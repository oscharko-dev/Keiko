import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import {
  JIRA_SCREEN_CONFIGURATION_MUTATIONS,
  screenConfigurationInput,
  type JiraScreenConfigurationMutation,
  type ScreenConfigurationInput,
} from "./jira-screen-configuration-inputs.js";
import {
  inspectScreenConfiguration,
  readScreenConfigurationState,
  screenConfigurationMatches,
  screenConfigurationReceipt,
  screenConfigurationUnconfirmed,
  SCREEN_CONFIGURATION_MALFORMED,
  type JiraScreenConfigurationAttempt,
  type JiraScreenConfigurationReceipt,
} from "./jira-screen-configuration-admission.js";

interface Effect {
  readonly path: string;
  readonly method: "POST" | "PUT" | "DELETE";
  readonly body?: CatalogJsonObject;
}
const OPERATIONS: ReadonlySet<string> = new Set(JIRA_SCREEN_CONFIGURATION_MUTATIONS);
function effect(input: ScreenConfigurationInput): Effect {
  if (input.kind === "default")
    return { path: `screens/addToDefault/${encodeURIComponent(input.fieldId)}`, method: "POST" };
  const tab = `screens/${input.screenId}/tabs/${input.tabId}`;
  if (input.kind === "tab-move")
    return { path: `${tab}/move/${String(input.position)}`, method: "POST" };
  if (input.kind === "add")
    return { path: `${tab}/fields`, method: "POST", body: { fieldId: input.fieldId } };
  const field = `${tab}/fields/${encodeURIComponent(input.fieldId)}`;
  if (input.kind === "remove") return { path: field, method: "DELETE" };
  return input.kind === "show"
    ? {
        path: `${field}/updateShowWhenEmptyIndicator/${String(input.showWhenEmpty)}`,
        method: "PUT",
      }
    : { path: `${field}/move`, method: "POST", body: input.body };
}
async function confirm(
  request: JiraMutationRequest,
  input: ScreenConfigurationInput,
  receipt: JiraScreenConfigurationReceipt,
): Promise<JiraScreenConfigurationAttempt> {
  if (input.kind === "default")
    return screenConfigurationUnconfirmed(
      receipt,
      "Jira acknowledged the field addition to its server-selected default screen. The API did not identify that screen or tab, so the actual layout cannot be independently confirmed. Do not infer a default screen ID or replay the write.",
    );
  try {
    const current = await readScreenConfigurationState(request, input);
    if (!current.ok)
      return {
        ...current,
        receipt,
        ...(current.reason === "conflict"
          ? {
              detail: {
                messages: [
                  "Jira acknowledged the operation, but the screen or tab identity changed during independent readback. The result remains unconfirmed. Inspect the known target IDs and do not replay the write.",
                ],
              },
            }
          : {}),
      };
    return screenConfigurationMatches(input, current.value)
      ? { ok: true, receipt }
      : screenConfigurationUnconfirmed(
          receipt,
          "The same screen and tab were read again, but the complete layout does not prove the requested result. Retain the known IDs, inspect the current layout, and do not replay this write.",
        );
  } catch (error) {
    throw new JiraAcknowledgedMutationError(error, receipt);
  }
}
export function isJiraScreenConfigurationMutation(
  name: string,
): name is JiraScreenConfigurationMutation {
  return OPERATIONS.has(name);
}
/** Fixed native ScreenResource writes. Existing admin authority, approval, dispatch budgets and
 * durable mutation journal surround this adapter. ACKs never replace independent layout evidence.
 * Native tab positions are zero-based: FieldScreenService.moveTab, official Jira 11.3 Javadoc.
 * Only the documented MoveFieldBean position enum is admitted. The published URI-typed after
 * property does not establish a usable item URI contract; no anchor URL is guessed here.
 */
export async function executeJiraScreenConfigurationMutation(
  name: JiraScreenConfigurationMutation,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  check = false,
): Promise<JiraScreenConfigurationAttempt> {
  const selected = screenConfigurationInput(name, args);
  if (selected === undefined)
    return {
      ok: false,
      reason: "field-validation",
      detail: {
        validation: "invalid-field",
        messages: [
          "Review the exact screen and complete ordered tabs and fields. Use a supported field position, an explicit show-when-empty Boolean, or a zero-based tab position. Field anchor URLs are not supported. Default-screen addition requires explicit acceptance that its native target cannot be independently identified. Nothing was written.",
        ],
      },
    };
  const refusal = await inspectScreenConfiguration(request, selected);
  if (refusal !== undefined) return refusal;
  if (check) return { ok: true, receipt: {} };
  const receipt = screenConfigurationReceipt(selected);
  const write = effect(selected);
  // All target identities were independently bound before dispatch. Even add-field uses an
  // existing field ID; an acknowledgement body cannot retarget the approved operation.
  const response = await request(write.path, write.method, write.body, "none");
  if (!response.ok) return { ...dispatchFailure(response), receipt };
  if (response.status < 200 || response.status >= 300)
    return { ...SCREEN_CONFIGURATION_MALFORMED, receipt };
  return confirm(request, selected, receipt);
}
