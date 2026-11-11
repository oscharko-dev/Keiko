import { OPTION_SCHEME_MUTATION_CASES, optionSchemeFixture } from "./jira-option-scheme-fixture.js";
import {
  WORKFLOW_SCHEME_MUTATION_FIXTURE_CASES,
  workflowSchemeMutationFixture,
} from "./jira-workflow-scheme-mutation-fixture.js";
import {
  INSTANCE_SETTING_FIXTURE_CASES,
  instanceSettingMutationFixture,
} from "./jira-instance-setting-mutation-fixture.js";
import { reviewedPlatformTransportFixture } from "./jira-reviewed-platform-transport-fixture.js";

const ROOT = "/context/rest/api/2";
const OPTION_READS = new Set([
  "myself",
  "issuetype",
  "priority",
  "issuetypescheme/7",
  "issuetypescheme/9007199254740993",
  "priorityschemes/9",
  "priorityschemes/9007199254740993",
  "issuetypescheme/7/associations",
  "project/10000",
  "project/10001",
]);
const WORKFLOW_READS = new Set([
  "myself",
  "workflowscheme/37",
  "workflowscheme/37?returnDraftIfExists=true",
  "workflowscheme/37?returnDraftIfExists=false",
  "workflowscheme/37/draft",
  "workflowscheme/9223372036854775807",
  "workflowscheme/9223372036854775807?returnDraftIfExists=false",
  "workflowscheme/9223372036854775807?returnDraftIfExists=true",
  "issuetype/1",
  "issuetype/2",
  "workflowscheme/9223372036854775807?returnDraftIfExists=true",
  "workflow?workflowName=Default",
  "workflow?workflowName=Flow",
  "workflow?workflowName=Second",
  "workflow?workflowName=Next",
]);
const INSTANCE_READS = new Set([
  "myself",
  "application-properties?key=jira.option.voting",
  "settings/columns",
  "field",
  "serverInfo",
  "readonly-mode",
]);
type TransportFixture = ReturnType<typeof reviewedPlatformTransportFixture>;

type NativeFixture = Parameters<typeof reviewedPlatformTransportFixture>[2] extends infer R
  ? {
      actor: { key: string };
      request: R;
      snapshot: Parameters<typeof reviewedPlatformTransportFixture>[4];
    }
  : never;

function nativeTransport(
  spec: Parameters<typeof reviewedPlatformTransportFixture>[1],
  native: NativeFixture,
  actorKey: string,
  reads: ReadonlySet<string>,
): TransportFixture {
  native.actor.key = actorKey;
  return reviewedPlatformTransportFixture(
    ROOT,
    spec,
    native.request,
    (path) => reads.has(path),
    native.snapshot,
  );
}

function optionTransportController(
  operation: string | undefined,
  actorKey: string,
): TransportFixture | undefined {
  const option = OPTION_SCHEME_MUTATION_CASES.find((item) => item.tool === operation);
  if (option === undefined) return undefined;
  const creates =
    option.tool === "jira.create-issue-type-scheme" ||
    option.tool === "jira.create-priority-scheme";
  return nativeTransport(
    { ...option, acknowledgement: creates ? "json" : "none" },
    optionSchemeFixture(),
    actorKey,
    OPTION_READS,
  );
}

function workflowTransportController(
  operation: string | undefined,
  actorKey: string,
): TransportFixture | undefined {
  const workflow = WORKFLOW_SCHEME_MUTATION_FIXTURE_CASES.find((item) => item.name === operation);
  if (workflow === undefined) return undefined;
  const creates =
    workflow.name === "jira.create-workflow-scheme" ||
    workflow.name === "jira.create-workflow-scheme-draft";
  return nativeTransport(
    { ...workflow, acknowledgement: creates ? "json" : "none" },
    workflowSchemeMutationFixture(workflow.draft),
    actorKey,
    WORKFLOW_READS,
  );
}

function instanceTransportController(
  operation: string | undefined,
  actorKey: string,
): TransportFixture | undefined {
  const instance = INSTANCE_SETTING_FIXTURE_CASES.find((item) => item.name === operation);
  if (instance === undefined) return undefined;
  return nativeTransport(
    { ...instance, method: "PUT", acknowledgement: "none" },
    instanceSettingMutationFixture(),
    actorKey,
    INSTANCE_READS,
  );
}

/** Independent fixed native targets and states; no route derives from the production registry. */
export function schemeSettingTransportController(
  operation: string | undefined,
  actorKey = "synthetic-actor",
): TransportFixture | undefined {
  return (
    optionTransportController(operation, actorKey) ??
    workflowTransportController(operation, actorKey) ??
    instanceTransportController(operation, actorKey)
  );
}
