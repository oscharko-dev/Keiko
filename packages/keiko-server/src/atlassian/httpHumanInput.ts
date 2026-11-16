import {
  AtlassianCredentialCustodyError,
  JiraHumanInputCustodyError,
  copyHumanInputBinding,
  jiraPrivateCookie,
  humanInputView,
  parseHumanInputValues,
  parseJsonObjectOrArray,
  type AtlassianHttpBodyRequest,
  type JiraHumanInputHttpRequest,
  type JiraHumanInputValues,
  type JiraPrivateCookie,
  type AtlassianCredentialExecutionResolver,
} from "@oscharko-dev/keiko-connectors";
import {
  JIRA_HUMAN_INPUT_PURPOSES,
  type JiraHumanInputPurpose,
  type JiraHumanInputView,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";

const FIELDS: Readonly<Record<JiraHumanInputPurpose, readonly string[]>> = {
  "update-myself": ["displayName"],
  "update-my-password": [],
  "update-user-password": ["userKey"],
  "validate-create-user-password": ["username", "displayName", "emailAddress"],
  "validate-update-user-password": ["username"],
  "validate-license": [],
  login: [],
  "unlock-user-anonymization": [],
};
const PATHS: Readonly<Record<JiraHumanInputPurpose, string>> = {
  "update-myself": "/rest/api/2/myself",
  "update-my-password": "/rest/api/2/myself/password",
  "update-user-password": "/rest/api/2/user/password",
  "validate-create-user-password": "/rest/api/2/password/policy/createUser",
  "validate-update-user-password": "/rest/api/2/password/policy/updateUser",
  "validate-license": "/rest/api/2/licenseValidator",
  login: "/rest/auth/1/session",
  "unlock-user-anonymization": "/rest/api/2/user/anonymization/unlock",
};
function refuse(): never {
  throw new AtlassianCredentialCustodyError("invalid-input", [
    "Invalid private Jira input request",
  ]);
}
function nativeFieldText(key: string, value: unknown): value is string {
  return !(
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > (key === "emailAddress" ? 254 : 255) ||
    /[\p{Cc}\p{Surrogate}]/u.test(value)
  );
}
function nativeFields(purpose: JiraHumanInputPurpose, value: unknown): CatalogJsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return refuse();
  const expected = FIELDS[purpose];
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== "string" || !expected.includes(key))
  )
    return refuse();
  const fields: Record<string, string> = {};
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    const text: unknown = descriptor?.value;
    if (!nativeFieldText(key, text)) return refuse();
    fields[key] = text;
  }
  return Object.freeze(fields);
}
function passwordUserQuery(value: unknown): string {
  return `?${new URLSearchParams({ key: String(value) }).toString()}`;
}
function humanInputMethod(purpose: JiraHumanInputPurpose): "POST" | "PUT" | "DELETE" {
  if (purpose === "unlock-user-anonymization") return "DELETE";
  return purpose.startsWith("update-") ? "PUT" : "POST";
}
export function humanInputRoute(
  purpose: JiraHumanInputPurpose,
  fields: CatalogJsonObject,
): { readonly path: string; readonly method: "POST" | "PUT" | "DELETE" } {
  const query = purpose === "update-user-password" ? passwordUserQuery(fields.userKey) : "";
  return {
    path: `${PATHS[purpose]}${query}`,
    method: humanInputMethod(purpose),
  };
}
function selectedBinding(
  selection: JiraHumanInputHttpRequest["selection"] | undefined,
): ReturnType<typeof copyHumanInputBinding> {
  return copyHumanInputBinding(selection?.binding);
}
export function ownedHumanInput(value: JiraHumanInputHttpRequest): JiraHumanInputHttpRequest {
  const binding = selectedBinding(value.selection);
  if (binding === undefined) return refuse();
  const purpose = JIRA_HUMAN_INPUT_PURPOSES.find(
    (candidate) => `jira.${candidate}` === binding.operation,
  );
  if (
    purpose === undefined ||
    !/^jhi_[a-f0-9]{64}$/u.test(value.selection.requestId) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value.selection.revision,
    )
  )
    return refuse();
  return Object.freeze({
    selection: Object.freeze({
      binding,
      requestId: value.selection.requestId,
      revision: value.selection.revision,
    }),
    fields: nativeFields(purpose, value.fields),
  });
}
export function humanInputPurpose(
  request: AtlassianHttpBodyRequest,
): JiraHumanInputPurpose | undefined {
  const operation = request.jiraHumanInput?.selection.binding.operation;
  if (operation === undefined) return undefined;
  return JIRA_HUMAN_INPUT_PURPOSES.find((purpose) => `jira.${purpose}` === operation);
}
function compatibleHumanInput(request: AtlassianHttpBodyRequest): boolean {
  return !(
    request.bodyJson !== undefined ||
    request.upload !== undefined ||
    request.jiraExperimental !== undefined ||
    request.jiraPermissionAttribute !== undefined ||
    request.jiraEmailTemplateArchive !== undefined ||
    request.jiraApplicationRole !== undefined ||
    request.jiraUserApplication !== undefined ||
    request.jiraUserColumns !== undefined ||
    request.jiraIdentityExperimental !== undefined ||
    request.jiraProjectPriority !== undefined
  );
}
export function assertHumanInputTarget(
  base: URL,
  request: AtlassianHttpBodyRequest,
  authRef: string,
): void {
  if (request.jiraHumanInput === undefined) return;
  if (!compatibleHumanInput(request)) return refuse();
  const owned = ownedHumanInput(request.jiraHumanInput);
  const purpose = humanInputPurpose({ ...request, jiraHumanInput: owned });
  if (purpose === undefined || owned.selection.binding.authRef !== authRef) return refuse();
  const route = humanInputRoute(purpose, owned.fields);
  if (
    request.method !== route.method ||
    request.url !== `${base.origin}${base.pathname.replace(/\/$/u, "")}${route.path}`
  )
    return refuse();
}
function oldPasswordField(values: JiraHumanInputValues): { readonly oldPassword?: string } {
  return values.oldPassword === undefined ? {} : { oldPassword: values.oldPassword };
}
export function privateHumanBody(
  request: JiraHumanInputHttpRequest,
  values: JiraHumanInputValues,
): string {
  const fields = request.fields;
  switch (request.selection.binding.operation) {
    case "jira.update-myself":
      return JSON.stringify({ displayName: fields.displayName, password: values.password });
    case "jira.update-my-password":
      return JSON.stringify({ currentPassword: values.currentPassword, password: values.password });
    case "jira.update-user-password":
      return JSON.stringify({ password: values.password });
    case "jira.validate-create-user-password":
      return JSON.stringify({ ...fields, password: values.password });
    case "jira.validate-update-user-password":
      return JSON.stringify({
        ...fields,
        newPassword: values.newPassword,
        ...oldPasswordField(values),
      });
    case "jira.validate-license":
      return typeof values.license === "string" ? JSON.stringify(values.license) : refuse();
    case "jira.login":
      return JSON.stringify({
        username: request.selection.binding.actorUsername,
        password: values.password,
      });
    case "jira.unlock-user-anonymization":
      return refuse();
  }
}
export function claimHttpHumanInput(
  credentials: AtlassianCredentialExecutionResolver,
  input: JiraHumanInputHttpRequest,
  consumed?: (view: JiraHumanInputView) => void,
): JiraHumanInputValues {
  const privateInputs = credentials.humanInputs;
  if (privateInputs === undefined) throw new JiraHumanInputCustodyError("not-ready");
  const { requestId, binding, revision } = input.selection;
  const values = privateInputs.claim(requestId, binding, revision);
  consumed?.(
    humanInputView({
      schemaVersion: 1,
      kind: "jira-operation-input",
      requestId,
      binding,
      revision,
      state: "consumed",
    }),
  );
  return parseHumanInputValues(binding.operation, values) ?? refuse();
}
function passwordPolicyResponse(items: readonly unknown[] | undefined): string {
  return items !== undefined &&
    items.length <= TOOL_CATALOG_LIMITS.maxArrayItems &&
    items.every((item) => typeof item === "string")
    ? JSON.stringify({ accepted: items.length === 0, violationCount: items.length })
    : "";
}
function licenseValidationResponse(value: unknown): string {
  if (
    value === null ||
    typeof value !== "object" ||
    !("errors" in value) ||
    value.errors === null ||
    typeof value.errors !== "object" ||
    Array.isArray(value.errors)
  )
    return "";
  const errors = Object.values(value.errors);
  return errors.length <= TOOL_CATALOG_LIMITS.maxArrayItems &&
    errors.every((item) => typeof item === "string")
    ? JSON.stringify({ accepted: errors.length === 0, violationCount: errors.length })
    : "";
}
function captureLoginCookie(
  value: unknown,
  status: number,
  onLoginCookie: ((cookie: JiraPrivateCookie) => void) | undefined,
): void {
  if (status === 200 && value !== null && typeof value === "object" && "session" in value) {
    const cookie = jiraPrivateCookie(value.session);
    if (cookie !== undefined) onLoginCookie?.(cookie);
  }
}
/** Native diagnostics may reflect the submitted password/license. Never return that raw body. */
export function privateHumanResponse(
  purpose: JiraHumanInputPurpose,
  status: number,
  text: string,
  truncated: boolean,
  onLoginCookie?: (cookie: JiraPrivateCookie) => void,
): string {
  if (status < 200 || status >= 300 || truncated) return "";
  const parsed = parseJsonObjectOrArray(text);
  if (parsed === undefined) return "";
  if (purpose === "validate-create-user-password" || purpose === "validate-update-user-password")
    return passwordPolicyResponse(parsed.items);
  const value = parsed.body;
  if (purpose === "validate-license") return licenseValidationResponse(value);
  if (purpose === "login") captureLoginCookie(value, status, onLoginCookie);
  return "";
}
