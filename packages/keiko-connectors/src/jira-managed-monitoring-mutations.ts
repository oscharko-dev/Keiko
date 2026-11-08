import type {
  JiraMutationAttempt,
  JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";

const DEFINITIONS = {
  "jira.set-app-monitoring": { read: "monitoring/app", write: "monitoring/app", shape: "object" },
  "jira.set-ipd-monitoring": { read: "monitoring/ipd", write: "monitoring/ipd", shape: "object" },
  "jira.start-jmx-metrics": {
    read: "monitoring/jmx/areMetricsExposed",
    write: "monitoring/jmx/startExposing",
    shape: "scalar",
  },
  "jira.stop-jmx-metrics": {
    read: "monitoring/jmx/areMetricsExposed",
    write: "monitoring/jmx/stopExposing",
    shape: "scalar",
  },
} as const;
type MonitoringWrite = keyof typeof DEFINITIONS;
type Definition = (typeof DEFINITIONS)[MonitoringWrite];
interface MonitoringReceipt extends JiraMutationReceipt {
  readonly monitoringEnabled?: boolean;
  readonly jmxMetricsExposed?: boolean;
}
type Failure = Omit<Extract<JiraMutationAttempt, { readonly ok: false }>, "receipt"> & {
  readonly receipt?: MonitoringReceipt;
};
export type JiraMonitoringMutationAttempt =
  Failure | { readonly ok: true; readonly receipt: MonitoringReceipt };
interface Input {
  readonly expectedEnabled: boolean;
  readonly enabled: boolean;
}
const OBJECT_ARGS = new Set(["expectedEnabled", "enabled"]);
const SCALAR_ARGS = new Set(["expectedEnabled"]);
const MALFORMED: Failure = { ok: false, reason: "malformed-payload" };
const INVALID: Failure = {
  ok: false,
  reason: "field-validation",
  detail: {
    validation: "invalid-field",
    messages: [
      "Read and review the current boolean monitoring state first, then supply expectedEnabled. App and IPD changes also need the desired enabled value. Nothing was changed.",
    ],
  },
};
function input(operation: MonitoringWrite, args: CatalogJsonObject): Input | undefined {
  const scalar = DEFINITIONS[operation].shape === "scalar";
  const allowed = scalar ? SCALAR_ARGS : OBJECT_ARGS;
  if (
    Object.keys(args).some((key) => !allowed.has(key)) ||
    typeof args.expectedEnabled !== "boolean"
  )
    return undefined;
  const enabled = scalar ? operation === "jira.start-jmx-metrics" : args.enabled;
  return typeof enabled === "boolean"
    ? { expectedEnabled: args.expectedEnabled, enabled }
    : undefined;
}
function receipt(definition: Definition, enabled: boolean): MonitoringReceipt {
  return definition.shape === "scalar"
    ? { jmxMetricsExposed: enabled }
    : { monitoringEnabled: enabled };
}
async function readState(
  request: JiraMutationRequest,
  definition: Definition,
): Promise<Failure | { readonly ok: true; readonly enabled: boolean }> {
  const response = await request(
    definition.read,
    "GET",
    undefined,
    definition.shape === "scalar" ? "json-scalar" : "json",
  );
  if (!response.ok) return dispatchFailure(response);
  if (response.status !== 200) return MALFORMED;
  const enabled = definition.shape === "scalar" ? response.scalar : response.body?.enabled;
  return typeof enabled === "boolean" ? { ok: true, enabled } : MALFORMED;
}
function observedConflict(
  definition: Definition,
  actual: boolean,
  selected: Input,
): Failure | undefined {
  if (actual !== selected.expectedEnabled)
    return {
      ok: false,
      reason: "conflict",
      detail: {
        messages: [
          "The monitoring state changed after review. Read its current value before requesting this change. Nothing was written.",
        ],
      },
    };
  if (actual !== selected.enabled) return undefined;
  return {
    ok: false,
    reason: "conflict",
    receipt: receipt(definition, actual),
    detail: {
      unchanged: true,
      messages: ["Monitoring already has the requested state. Nothing was written."],
    },
  };
}
async function confirm(
  request: JiraMutationRequest,
  definition: Definition,
  enabled: boolean,
  acknowledged: MonitoringReceipt,
): Promise<JiraMonitoringMutationAttempt> {
  try {
    const current = await readState(request, definition);
    if (!current.ok) return { ...current, receipt: acknowledged };
    return current.enabled === enabled
      ? { ok: true, receipt: acknowledged }
      : { ok: false, reason: "conflict", receipt: acknowledged };
  } catch (error) {
    throw new JiraAcknowledgedMutationError(error, acknowledged);
  }
}
export function isJiraMonitoringMutation(name: string): name is MonitoringWrite {
  return Object.hasOwn(DEFINITIONS, name);
}
/** The existing authority/journal path owns execution; observing this source never starts monitoring. */
export async function executeJiraMonitoringMutation(
  operation: MonitoringWrite,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  check = false,
): Promise<JiraMonitoringMutationAttempt> {
  const selected = input(operation, args);
  if (selected === undefined) return INVALID;
  const definition = DEFINITIONS[operation];
  const current = await readState(request, definition);
  if (!current.ok) return current;
  const refusal = observedConflict(definition, current.enabled, selected);
  if (refusal !== undefined) return refusal;
  if (check) return { ok: true, receipt: {} };
  const known = receipt(definition, selected.enabled);
  const body = definition.shape === "object" ? { enabled: selected.enabled } : undefined;
  const response = await request(definition.write, "POST", body, "none");
  if (!response.ok) return { ...dispatchFailure(response), receipt: known };
  if (response.status < 200 || response.status >= 300) return { ...MALFORMED, receipt: known };
  return confirm(request, definition, selected.enabled, known);
}
