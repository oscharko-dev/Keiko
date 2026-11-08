import { OPTION_SCHEME_MUTATION_CASES, optionSchemeFixture } from "./jira-option-scheme-fixture.js";
import { WORKFLOW_SCHEME_MUTATION_FIXTURE_CASES, workflowSchemeMutationFixture } from "./jira-workflow-scheme-mutation-fixture.js";
import { INSTANCE_SETTING_FIXTURE_CASES, instanceSettingMutationFixture } from "./jira-instance-setting-mutation-fixture.js";
import { reviewedPlatformTransportFixture } from "./jira-reviewed-platform-transport-fixture.js";

const ROOT = "/context/rest/api/2";
const OPTION_READS = new Set([
  "myself", "issuetype", "priority", "issuetypescheme/7", "issuetypescheme/9007199254740993",
  "priorityschemes/9", "priorityschemes/9007199254740993", "issuetypescheme/7/associations",
  "project/10000", "project/10001",
]);
const WORKFLOW_READS = new Set([
  "myself", "workflowscheme/37", "workflowscheme/37?returnDraftIfExists=true",
  "workflowscheme/37?returnDraftIfExists=false", "workflowscheme/37/draft",
  "workflowscheme/9223372036854775807", "issuetype/1", "issuetype/2",
  "workflow?workflowName=Default", "workflow?workflowName=Flow",
  "workflow?workflowName=Second", "workflow?workflowName=Next",
]);
const INSTANCE_READS = new Set([
  "myself", "application-properties?key=jira.option.voting", "settings/columns", "field", "serverInfo", "readonly-mode",
]);
/** Independent fixed native targets and states; no route derives from the production registry. */
export function schemeSettingTransportController(operation: string | undefined, actorKey = "synthetic-actor") {
  const option = OPTION_SCHEME_MUTATION_CASES.find((item) => item.tool === operation);
  if (option !== undefined) {
    const native = optionSchemeFixture(); native.actor.key = actorKey;
    return reviewedPlatformTransportFixture(ROOT, { ...option,
      acknowledgement: option.tool === "jira.create-issue-type-scheme" || option.tool === "jira.create-priority-scheme" ? "json" : "none",
    }, native.request, (path) => OPTION_READS.has(path), native.snapshot);
  }
  const workflow = WORKFLOW_SCHEME_MUTATION_FIXTURE_CASES.find((item) => item.name === operation);
  if (workflow !== undefined) {
    const native = workflowSchemeMutationFixture(workflow.draft); native.actor.key = actorKey;
    return reviewedPlatformTransportFixture(ROOT, { ...workflow,
      acknowledgement: workflow.name === "jira.create-workflow-scheme" || workflow.name === "jira.create-workflow-scheme-draft" ? "json" : "none",
    }, native.request, (path) => WORKFLOW_READS.has(path), native.snapshot);
  }
  const instance = INSTANCE_SETTING_FIXTURE_CASES.find((item) => item.name === operation);
  if (instance === undefined) return undefined;
  const native = instanceSettingMutationFixture(); native.actor.key = actorKey;
  return reviewedPlatformTransportFixture(ROOT, { ...instance, method: "PUT", acknowledgement: "none" },
    native.request, (path) => INSTANCE_READS.has(path), native.snapshot);
}
