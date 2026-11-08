import { jiraPropertyUserText } from "@oscharko-dev/keiko-connectors";
import type {
  JiraMutationOperation,
  JiraMutationReceipt,
  JiraPrivateAccountMutation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { receiptOwnData as data, receiptFields, receiptWithinBudget } from "./jiraReceiptValues.js";

type PrivateOperation = JiraPrivateAccountMutation | "jira.unlock-user-anonymization";
const UNLOCK = ["actorUserKey", "userKey", "executingNode", "anonymizationSubmittedTime"] as const;
const USER = ["actorUserKey", "userKey", "username"] as const;
export const JIRA_PRIVATE_ACCOUNT_RECEIPTS = {
  "jira.unlock-user-anonymization": UNLOCK,
  "jira.update-myself": USER,
  "jira.update-my-password": USER,
  "jira.update-user-password": USER,
  "jira.login": [...USER, "sessionEstablished"],
  "jira.logout": USER,
  "jira.release-websudo": USER,
} as const satisfies Readonly<Record<PrivateOperation, readonly (keyof JiraMutationReceipt)[]>>;
export function isJiraPrivateAccountOperation(
  operation: JiraMutationOperation,
): operation is PrivateOperation {
  return Object.hasOwn(JIRA_PRIVATE_ACCOUNT_RECEIPTS, operation);
}
function validUnlockReceipt(receipt: JiraMutationReceipt): boolean {
  const time = data(receipt, "anonymizationSubmittedTime");
  return (
    receiptFields(receipt, UNLOCK) &&
    UNLOCK.every((key) => jiraPropertyUserText(data(receipt, key))) &&
    typeof time === "string" &&
    time.length <= 128 &&
    receiptWithinBudget(receipt)
  );
}
/** The private port supplies identity evidence, never password/license/session material. */
export function validJiraPrivateAccountReceipt(
  receipt: JiraMutationReceipt,
  operation: PrivateOperation,
): boolean {
  if (operation === "jira.unlock-user-anonymization") return validUnlockReceipt(receipt);
  const optional = operation === "jira.login" ? ["sessionEstablished"] : [];
  if (!receiptFields(receipt, USER, optional)) return false;
  if (!USER.every((key) => jiraPropertyUserText(data(receipt, key)))) return false;
  if (
    operation !== "jira.update-user-password" &&
    data(receipt, "actorUserKey") !== data(receipt, "userKey")
  )
    return false;
  if (Object.hasOwn(receipt, "sessionEstablished") && data(receipt, "sessionEstablished") !== true)
    return false;
  return receiptWithinBudget(receipt);
}
export function canConfirmJiraPrivateAccount(
  operation: JiraMutationOperation,
  receipt: JiraMutationReceipt,
): boolean {
  if (!isJiraPrivateAccountOperation(operation)) return true;
  return (
    operation === "jira.update-myself" ||
    (operation === "jira.login" && data(receipt, "sessionEstablished") === true)
  );
}
