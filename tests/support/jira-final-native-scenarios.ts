import type { Scenario } from "./jira-operation-transport-contract.js";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { PRIVATE_NATIVE_CASES } from "./jira-private-native-cases.js";
import { PROJECT_LIFECYCLE_FIXTURE_CASES } from "./jira-project-lifecycle-fixture.js";
import { ISSUE_LIFECYCLE_FIXTURE_CASES } from "./jira-issue-lifecycle-fixture.js";
import {
  PROJECT_ISSUE_ARGUMENTS,
  PROJECT_ISSUE_RECEIPTS,
} from "./jira-project-issue-transport-fixture.js";

type PublicTool = keyof typeof PROJECT_ISSUE_ARGUMENTS;
function publicCase(tool: PublicTool, method: "POST" | "PUT" | "DELETE", path: string): Scenario {
  const receipt = PROJECT_ISSUE_RECEIPTS[tool];
  const local: CatalogJsonObject = {
    ...receipt,
    ...(typeof receipt.browseUrl === "string"
      ? {
          browseUrl: receipt.browseUrl.replace(
            "https://203.0.113.10/context",
            "https://jira.example.invalid/context",
          ),
        }
      : {}),
  };
  return {
    tool,
    args: PROJECT_ISSUE_ARGUMENTS[tool],
    expectedReceipt: local,
    expectedOutcome: "succeeded-unconfirmed",
    expectedPrimary: { method, apiRoot: "/rest/api/2", path },
  };
}
/** Method/path/body expectations come only from the independently authored native fixtures. */
export const FINAL_NATIVE_SCENARIOS: readonly Scenario[] = [
  ...PROJECT_LIFECYCLE_FIXTURE_CASES.map((item) => publicCase(item.name, item.method, item.path)),
  ...ISSUE_LIFECYCLE_FIXTURE_CASES.map((item) => publicCase(item.name, item.method, item.path)),
  publicCase("jira.create-issues", "POST", "issue/bulk"),
  publicCase("jira.create-reciprocal-remote-link", "POST", "issue/remotelink/reciprocal"),
  ...PRIVATE_NATIVE_CASES.map((item): Scenario => ({
    tool: item.tool,
    args: item.args,
    expectedPrimary: {
      method: item.method,
      apiRoot: item.apiRoot,
      path: item.path.replace(/^\//u, ""),
    },
    ...(item.receipt === undefined ? {} : { expectedReceipt: item.receipt }),
    ...(item.outcome === "succeeded-unconfirmed" ? { expectedOutcome: item.outcome } : {}),
  })),
];
