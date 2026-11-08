import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import { jiraNativeDeclaration, jiraNativeWriteResult, type JiraNativeDefinition } from "./jiraProjectStructureDescriptors.js";

const ID = { ...text(16), minLength: 1, pattern: String.raw`^[1-9]\d{0,15}$`,
  description: "Canonical positive decimal ID within the existing Agile safe-integer projection." };
const NAME = { ...text(255), minLength: 1 };
const BOOL = { type: "boolean" };
const CONTEXT = { boardId: ID, expectedActorKey: NAME, expectedBoardName: NAME,
  expectedBoardType: { type: "string", enum: ["scrum", "kanban"] }, expectedFilterId: ID };
const REQUIRED = ["boardId", "expectedActorKey", "expectedBoardName", "expectedBoardType", "expectedFilterId"];
const RECEIPT = { boardId: ID, filterId: ID, userKey: NAME };
function definition(description: string, input: CatalogJsonObject, receipt: CatalogJsonObject): JiraNativeDefinition {
  return { description, input, result: jiraNativeWriteResult(receipt), risk: "write", maxResultCount: 1 };
}
export const JIRA_BOARD_CONFIGURATION_WRITE_DEFINITIONS = {
  "jira.delete-board": definition(
    "Delete exactly one reviewed native board after binding its connected actor, ID, name, type and filter against current native configuration. This does not delete its filter or explicitly change issues. Native deletion has no independently readable parent collection: selected404 and visible-board omission also mean permission loss. After acknowledgement retain known IDs and report unconfirmed; boardPresent:false is only the requested target. Send no second DELETE and do not infer all instance boards were visible.",
    object(CONTEXT, REQUIRED), { ...RECEIPT, boardPresent: BOOL }),
  "jira.set-board-refined-velocity": definition(
    "Set only the selected board's documented refined-velocity boolean after reviewing its native configuration and exact current boolean. This setting does not supply historical velocity measurements or estimation units. Match expectedValue, send one fixed PUT with native BooleanSettingBean and independently rebind the actor/configuration before reading the resulting boolean. Equal value reports unchanged. Jira supplies no atomic compare-and-set; concurrent changes remain possible. Missing readback, access loss or lost acknowledgement never permits replay.",
    object({ ...CONTEXT, expectedValue: BOOL, value: BOOL }, [...REQUIRED, "expectedValue", "value"]),
    { ...RECEIPT, refinedVelocityEnabled: BOOL }),
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;
export function jiraBoardConfigurationMutationDeclarationForTool(name: string): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> = JIRA_BOARD_CONFIGURATION_WRITE_DEFINITIONS;
  const definition = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return definition === undefined ? undefined : jiraNativeDeclaration(name, definition);
}
