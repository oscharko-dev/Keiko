import {
  expectedFinalOutcome,
  FINAL_EXPECTED_OUTCOMES,
} from "../../../../tests/support/jira-managed-final-scenarios.js";
import { privateNativeTransportController } from "../../../../tests/support/jira-private-native-transport-fixture.js";
import { privateNativeComposition } from "../../../../tests/support/jira-private-native-composition.js";
import {
  PRIVATE_NATIVE_COOKIE,
  PRIVATE_NATIVE_PASSWORD,
  PRIVATE_NATIVE_LICENSE,
} from "../../../../tests/support/jira-private-native-cases.js";
import { PRIVATE_ACCOUNT_READ_CASES } from "../../../../tests/support/jira-private-account-fixture.js";
import { privateNativeCase } from "../../../../tests/support/jira-private-native-cases.js";
import {
  expectedSystemAdministrationOutcome,
  SYSTEM_ADMINISTRATION_EXPECTED_OUTCOMES,
} from "../../../../tests/support/jira-managed-system-administration-scenarios.js";
import {
  expectedSchemeSettingOutcome,
  SCHEME_SETTING_EXPECTED_OUTCOMES,
} from "../../../../tests/support/jira-managed-scheme-setting-scenarios.js";
import { emailTemplateFixtureAdmission } from "../../../../tests/support/jira-email-template-transport-fixture.js";
import {
  expectedPermissionRoleOutcome,
  PERMISSION_ROLE_EXPECTED_OUTCOMES,
} from "../../../../tests/support/jira-managed-permission-role-scenarios.js";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createServerLogger, setServerLogger } from "../observability/index.js";
import { TEMPLATE_NOTICE_GUIDANCE } from "./jiraMutationResult.js";
import { resetServerLogger } from "../../../../tests/support/activity-log-test-support.js";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import { createGatewayToolCatalogBridge } from "@oscharko-dev/keiko-model-gateway";
import {
  JIRA_MUTATION_OPERATIONS,
  jiraOperationInReleaseScope,
  parseJiraIssueTemplate,
  type JiraIssueTemplate,
  jiraRequiredConnectorScope,
  type JiraMutationOperation,
  type JiraLivePodMetadata,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CodingWorkbenchConnectorScope } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  jiraTemplateViolationGuidance,
  type AtlassianCredentialMetadata,
  type AtlassianHttpBodyPort,
  type JiraAttachmentSource,
  type JiraManagedMutationExecutor,
} from "@oscharko-dev/keiko-connectors";
import {
  field,
  fixtureRead,
  fixtureWrite,
  FIELDS,
  response,
} from "../../../../tests/support/jira-managed-remote.js";
import {
  ARGUMENTS,
  ATTACHED,
  REMOTE_STATE,
  SUCCESS_RECEIPTS,
  mutationRemoteState,
  nativeRead,
  nativeParticipationWrite,
  nativeDeletionWrite,
  nativeWrite,
  type MutationRemoteState,
  type SingleMutation,
} from "../../../../tests/support/jira-managed-mutation-scenarios.js";
import { jiraMutationToolId } from "./jiraMutationToolId.js";
import { nativeAdministrationWrite } from "../../../../tests/support/jira-managed-administration-scenarios.js";
import {
  expectedSavedConfigurationOutcome,
  nativeSavedConfigurationWrite,
  prepareSavedConfiguration,
} from "../../../../tests/support/jira-managed-saved-configuration-scenarios.js";
import {
  expectedLifecycleOutcome,
  lifecycleRemoteFixture,
  LIFECYCLE_EXPECTED_OUTCOMES,
} from "../../../../tests/support/jira-managed-lifecycle-scenarios.js";
import {
  expectedConfigurationOutcome,
  CONFIGURATION_EXPECTED_OUTCOMES,
} from "../../../../tests/support/jira-managed-configuration-scenarios.js";
import {
  expectedPlanningOutcome,
  PLANNING_EXPECTED_OUTCOMES,
} from "../../../../tests/support/jira-managed-planning-scenarios.js";
import { jiraChatCatalogRoutes } from "./jiraChatCatalogConsumer.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  expectRegisteredActivityLogLine,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { buildUiStoreOverDatabase } from "../store/index.js";
import { runMigrations } from "../store/schema.js";
import { createChatToolMutationStore } from "../store/chatToolMutations.js";
import { createManagedProviderCatalog } from "../tool-catalog/managedProviderCatalog.js";
import type {
  CatalogHandlerContext,
  CatalogHandlerResult,
  CatalogToolDispatchOutcome,
} from "../tool-catalog/catalogToolPorts.js";
import {
  createConversationConsumerFixture,
  type ConversationConsumer,
  type ConversationAction,
} from "../tool-catalog/__fixtures__/conversationConsumer.js";
import { createJiraProviderForCatalog } from "./jiraManagedProvider.js";
import { executeJiraChatMutation } from "./jiraChatMutation.js";
import { executeJiraChatDraft, jiraDraftChildIntent } from "./jiraChatDraft.js";
import type { AtlassianHttpLifecycleOptions } from "./httpRequestLifecycle.js";
import { buildAtlassianConnectorCredentialDeps } from "./wiring.js";
import { verifyStoredCredential } from "./credentialVerification.js";
import type { AtlassianConnectorCredentialDeps } from "./credentialRoutes.js";
import type { JiraChatToolMutationIntent as ChatToolMutationIntent } from "../store/chatToolMutationTypes.js";
import { jiraChatMutationOutcome } from "./jiraChatMutationOutcome.js";
import {
  permissiveJiraTemplates,
  SYNTHETIC_ISSUE_TYPES,
} from "../../../../tests/support/jira-test-templates.js";

const cleanup: (() => void | Promise<void>)[] = [];
const BASE_URL = "https://203.0.113.10/context";
afterEach(async () => {
  resetServerLogger();
  for (const close of cleanup.splice(0).reverse()) await close();
});
// The attachment operations are switched off for Release 1 (#4354); their mechanics are proved
// at the connector with the switch forced on, and the refusal is pinned where the switch lives.
const SINGLE_MUTATIONS = JIRA_MUTATION_OPERATIONS.filter(
  (operation): operation is SingleMutation =>
    operation !== "jira.draft" && jiraOperationInReleaseScope(operation),
);
const ADMIN_MUTATIONS = SINGLE_MUTATIONS.filter(
  (operation) => jiraRequiredConnectorScope(operation) === "issue-tracker.admin",
);
interface FixtureAuthoritySelection {
  readonly adminScope?: true;
}
function reviewedAuthority(operation: JiraMutationOperation): FixtureAuthoritySelection {
  return jiraRequiredConnectorScope(operation) === "issue-tracker.admin"
    ? { adminScope: true }
    : {};
}
function database(): {
  store: ReturnType<typeof buildUiStoreOverDatabase>;
  journal: ReturnType<typeof createChatToolMutationStore>;
  chatId: string;
  userMessageId: string;
  turnRef: string;
  logs: ReturnType<typeof createBufferedServerLogSink>;
} {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  const store = buildUiStoreOverDatabase(db);
  cleanup.push(() => {
    store.close();
  });
  const chat = store.createChat(store.createProject(process.cwd()).path, "Synthetic", "model");
  const turn = store.admitChatTurn("synthetic-sdk-turn", {
    chatId: chat.id,
    role: "user",
    content: "synthetic",
    timestamp: 1000,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
  if (turn.kind !== "admitted" || turn.userMessage.canonicalTurnRef === undefined)
    throw new Error("Expected admitted synthetic turn");
  const logs = createBufferedServerLogSink();
  return {
    store,
    journal: createChatToolMutationStore(db, () => 1000, logs),
    chatId: chat.id,
    userMessageId: turn.userMessage.id,
    turnRef: turn.userMessage.canonicalTurnRef,
    logs,
  };
}
type RemoteMode =
  | "confirmed"
  | "readback-denied"
  | "issue-gone-after-write"
  | "lost-response"
  | "jira-error-document"
  | "html-error-page"
  | "server-error"
  | "voting-disabled"
  | "time-tracking-disabled"
  | "transition-moved-404"
  | "transition-moved-400"
  | "transition-moved-empty"
  | "transition-moved-html"
  | "transition-moved-truncated"
  | "parent-offered"
  | "epic-link-unknown";
/** The value this synthetic Jira refuses, as Data Center does for a bad option. */
const REJECTED_VALUE = "Rot";
const JIRA_FIELD_ERROR = "Option 'Rot' is not valid.";
const JIRA_ERROR_DOCUMENT = JSON.stringify({
  errorMessages: [],
  errors: { customfield_10000: JIRA_FIELD_ERROR },
});
const REFUSALS: Readonly<Record<string, { readonly status: number; readonly body: string }>> = {
  // Jira validated the whole request and said why (#4176): nothing was applied.
  "jira-error-document": { status: 400, body: JIRA_ERROR_DOCUMENT },
  // A proxy's page is no Jira error document: whether the write was applied is unknown.
  "html-error-page": { status: 400, body: "<html><body>Bad Request</body></html>" },
  "server-error": { status: 503, body: JIRA_ERROR_DOCUMENT },
};
/** The workflow moved between the listing and the write: Jira refuses the listed transition (KEIKO-0814). */
const MOVED_TRANSITION: Readonly<
  Record<string, { readonly status: number; readonly body: string }>
> = {
  "transition-moved-404": {
    status: 404,
    body: JSON.stringify({ errorMessages: ["Issue Does Not Exist"], errors: {} }),
  },
  "transition-moved-400": {
    status: 400,
    body: JSON.stringify({
      errorMessages: ["Transition id '31' is not valid for this issue."],
      errors: {},
    }),
  },
  // No Jira error document: a proxy or a cut connection may have answered, not Jira.
  "transition-moved-empty": { status: 404, body: "" },
  "transition-moved-html": { status: 400, body: "<html><body>Bad Request</body></html>" },
  "transition-moved-truncated": { status: 400, body: '{"errorMessages":["Transition id' },
};
function movedTransitionRefusal(mode: RemoteMode, request: Request): Response | undefined {
  const moved = MOVED_TRANSITION[mode];
  if (moved === undefined || request.method !== "POST") return undefined;
  if (!new URL(request.url).pathname.endsWith("/transitions")) return undefined;
  return new Response(moved.body, {
    status: moved.status,
    headers: { "content-type": "application/json" },
  });
}
async function scriptedRefusal(mode: RemoteMode, request: Request): Promise<Response | undefined> {
  const native = nativeOperationRefusal(mode, request);
  if (native !== undefined) return native;
  const moved = movedTransitionRefusal(mode, request);
  if (moved !== undefined) return moved;
  const refusal = REFUSALS[mode];
  if (refusal === undefined || !(await request.clone().text()).includes(REJECTED_VALUE))
    return undefined;
  return new Response(refusal.body, {
    status: refusal.status,
    headers: { "content-type": "application/json" },
  });
}
const NATIVE_REFUSALS = {
  "voting-disabled": {
    resource: "/votes",
    status: 404,
    message: "Voting is disabled, or you are the reporter of this issue.",
  },
  "time-tracking-disabled": {
    resource: "/worklog",
    status: 400,
    message: "Time tracking is disabled. Ask a Jira administrator to enable it.",
  },
} as const;
function nativeOperationRefusal(mode: RemoteMode, request: Request): Response | undefined {
  if (mode !== "voting-disabled" && mode !== "time-tracking-disabled") return undefined;
  const refusal = NATIVE_REFUSALS[mode];
  if (request.method !== "POST" || !new URL(request.url).pathname.endsWith(refusal.resource))
    return undefined;
  return new Response(JSON.stringify({ errorMessages: [refusal.message], errors: {} }), {
    status: refusal.status,
    headers: { "content-type": "application/json" },
  });
}
/** The same bounded Data Center probes production verification consumes, with no DNS or socket. */
function verificationProbe(path: string): ReturnType<typeof response> | undefined {
  if (path.endsWith("/serverInfo")) {
    return response({
      version: "10.3.26",
      versionNumbers: [10, 3, 26],
      deploymentType: "Data Center",
    });
  }
  if (path.endsWith("/myself")) {
    return response({ name: "synthetic-user", key: "synthetic-key", active: true });
  }
  return undefined;
}
/**
 * A template gate learns which project and type an issue is by asking for those two fields by name
 * (#4354). Whatever the operation's own fixture answers for that issue is kept, and the two fields
 * are added to it, so every other read of the same issue is unchanged.
 */
function withIssueIdentity(
  url: string,
  path: string,
  answer: ReturnType<typeof fixtureRead>,
): ReturnType<typeof fixtureRead> {
  // An issue is read by key or, from a worklog, by its numeric id.
  const match = /^\/context\/rest\/api\/2\/issue\/(?:SYN-(\d{1,3})|1000(\d))$/u.exec(path);
  const number = match?.[1] ?? match?.[2];
  const requested = new URL(url).searchParams.get("fields")?.split(",") ?? [];
  if (number === undefined || !requested.includes("issuetype")) return answer;
  const base =
    answer.kind === "response" && answer.status === 200
      ? (JSON.parse(answer.bodyText) as { fields?: Record<string, unknown> })
      : {};
  return response({
    id: String(10000 + Number(number)),
    key: `SYN-${number}`,
    ...base,
    fields: {
      ...base.fields,
      project: { id: "10000", key: "SYN" },
      issuetype: { id: "3", name: "Task" },
    },
  });
}
/**
 * A create screen that offers the parent field, as a Sub-task's does, and an edit screen that offers
 * the parent and the description (the two refusals of the parent rule are proven through them).
 */
function parentOfferedRead(
  mode: RemoteMode,
  path: string,
  state: MutationRemoteState,
): ReturnType<typeof fixtureRead> | undefined {
  if (mode === "epic-link-unknown") return epicLinkUnknownRead(path, state);
  if (mode !== "parent-offered") return undefined;
  if (path.includes("createmeta")) {
    const values = [...FIELDS, field("parent", "issuelink")];
    return response({ values, start: 0, size: 100, last: true, total: values.length });
  }
  if (!path.endsWith("editmeta")) return undefined;
  const answered = fixtureRead(path, state);
  const body = JSON.parse(answered.kind === "response" ? answered.bodyText : "{}") as {
    fields?: Record<string, unknown>;
  };
  return response({
    fields: {
      ...body.fields,
      parent: field("parent", "issuelink"),
      customfield_10109: {
        ...field("customfield_10109", "any"),
        name: "Epic Link",
        schema: { type: "any", custom: "com.pyxis.greenhopper.jira:gh-epic-link" },
      },
      description: {
        ...field("description", "string"),
        schema: { type: "string", system: "description" },
      },
    },
  });
}
const EPIC_LINK_FIELD = {
  ...field("customfield_10109", "any"),
  name: "Epic Link",
  schema: { type: "any", custom: "com.pyxis.greenhopper.jira:gh-epic-link" },
};
/**
 * A Jira whose create and edit screens offer the Epic Link and whose agile endpoint knows no epic
 * under the key the write names: the instance's own "no such epic" answer.
 */
function epicLinkUnknownRead(
  path: string,
  state: MutationRemoteState,
): ReturnType<typeof fixtureRead> | undefined {
  if (path.includes("/rest/agile/1.0/epic/"))
    return response({ errorMessages: ["Epic does not exist"], errors: {} }, 404);
  if (path.endsWith("/rest/api/2/field"))
    return response([
      { id: "summary", name: "Summary", schema: { type: "string", system: "summary" } },
      { id: "customfield_10109", name: "Epic Link", schema: EPIC_LINK_FIELD.schema },
    ]);
  if (path.includes("createmeta")) {
    const values = [...FIELDS, EPIC_LINK_FIELD];
    return response({ values, start: 0, size: 100, last: true, total: values.length });
  }
  if (!path.endsWith("editmeta")) return undefined;
  const answered = fixtureRead(path, state);
  const body = JSON.parse(answered.kind === "response" ? answered.bodyText : "{}") as {
    fields?: Record<string, unknown>;
  };
  return response({ fields: { ...body.fields, customfield_10109: EPIC_LINK_FIELD } });
}
async function fixtureReadResult(
  mode: RemoteMode,
  url: string,
  state: MutationRemoteState,
  writes: number,
  lifecycle: ReturnType<typeof lifecycleRemoteFixture>,
  operation: JiraMutationOperation | undefined,
): Promise<ReturnType<typeof fixtureRead>> {
  if (mode === "readback-denied" && writes > 0) return response({}, 403);
  const path = new URL(url).pathname;
  // The deleted issue: after the DELETE, a read of any issue is a 404, as Jira answers for a gone one.
  if (mode === "issue-gone-after-write" && writes > 0 && path.includes("/rest/api/2/issue/"))
    return response({ errorMessages: ["Issue Does Not Exist"], errors: {} }, 404);
  if (operation === "jira.set-instance-base-url" && path.endsWith("/serverInfo")) {
    const observed = await lifecycle.read(url);
    if (observed === undefined)
      throw new TypeError("Missing independent configured URL observation");
    return observed;
  }
  const answer = await fixtureOperationRead(url, path, state, lifecycle, mode);
  // Only the gate's read before the write is given an identity; a readback shows what was written.
  return writes === 0 ? withIssueIdentity(url, path, answer) : answer;
}
async function fixtureOperationRead(
  url: string,
  path: string,
  state: MutationRemoteState,
  lifecycle: ReturnType<typeof lifecycleRemoteFixture>,
  mode: RemoteMode,
): Promise<ReturnType<typeof fixtureRead>> {
  return (
    parentOfferedRead(mode, path, state) ??
    verificationProbe(path) ??
    (await lifecycle.read(url)) ??
    nativeRead(path, state) ??
    fixtureRead(path, state)
  );
}
async function assertNativeRequestHeaders(request: Request, path: string): Promise<void> {
  expect(request.headers.get("authorization")).toBe(["Bearer", "synthetic-test-pat"].join(" "));
  const experimental =
    (request.method === "PUT" &&
      new Set([
        "/context/rest/agile/1.0/sprint/unmap",
        "/context/rest/agile/1.0/sprint/unmap-all",
      ]).has(path)) ||
    (new Set(["POST", "DELETE"]).has(request.method) &&
      path === "/context/rest/api/2/user/application") ||
    /^\/context\/rest\/api\/2\/project\/[1-9][0-9]*\/priorityscheme(?:\/[1-9][0-9]*)?$/u.test(path);
  expect(request.headers.get("x-experimentalapi")).toBe(experimental ? "true" : null);
  if (path === "/context/rest/api/2/email-templates") {
    // Live Jira 10.3 refuses the raw ZIP POST with a 403 XSRF failure without the opt-out
    // (AC7 laboratory evidence, 2026-11-09); the read carries no token.
    if (request.method === "GET") {
      expect(request.headers.get("x-atlassian-token")).toBeNull();
      expect(request.headers.get("accept")).toBe("application/zip");
    } else {
      expect(request.headers.get("x-atlassian-token")).toBe("no-check");
      expect(request.headers.get("content-type")).toBe("application/zip");
    }
  }
  await assertDirectoryRequestHeaders(request, path);
  const attribute =
    request.method === "PUT" &&
    path ===
      "/context/rest/api/2/permissionscheme/7/attribute/ADMINISTER_PROJECTS.extended.enabled";
  if (!attribute) {
    expect(request.headers.get("content-type")).not.toBe("text/plain");
    return;
  }
  expect(request.headers.get("content-type")).toBe("text/plain");
  expect(await request.clone().text()).toBe("false");
}
async function assertDirectoryRequestHeaders(request: Request, path: string): Promise<void> {
  const role =
    request.method === "PUT" &&
    (path === "/context/rest/api/2/applicationrole" ||
      path === "/context/rest/api/2/applicationrole/jira-software");
  expect(request.headers.get("if-match")).toBe(role ? '"native-role-version"' : null);
  if (role) expect(request.headers.get("content-type")).toBe("application/json");
  if (path === "/context/rest/api/2/user/application" && request.method !== "GET") {
    expect(await request.clone().text()).toBe("");
    expect(request.headers.get("content-type")).toBeNull();
  }
  if (request.method === "PUT" && path === "/context/rest/api/2/user/columns") {
    expect(request.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(await request.clone().text()).toBe(
      "username=Target+User&columns=status&columns=summary&columns=status",
    );
  }
}
function remote(
  mode: RemoteMode,
  beforeWrite: () => void,
  initialOperation: JiraMutationOperation | undefined,
): {
  fetch: typeof fetch;
  state: MutationRemoteState;
  writes: () => number;
} {
  const state = mutationRemoteState();
  // The issue hangs under an Epic, as the lab's Story REQ-448 did.
  if (mode === "parent-offered") state.fields.customfield_10109 = "SYN-9";
  const lifecycle = lifecycleRemoteFixture(initialOperation);
  const privateNative = privateNativeTransportController(initialOperation);
  state.lifecycle = lifecycle.snapshot();
  state.isWatching = initialOperation === "jira.unwatch";
  state.hasVoted = initialOperation === "jira.unvote";
  state.administration.jmxExposed = initialOperation === "jira.stop-jmx-metrics";
  prepareSavedConfiguration(state.savedConfiguration, initialOperation);
  if (
    initialOperation === "jira.set-comment-property" ||
    initialOperation === "jira.delete-comment-property"
  )
    state.comment = "Original";
  if (initialOperation === "jira.delete-comment") state.comment = "Original";
  if (initialOperation === "jira.delete-attachment")
    state.fields.attachment = [{ id: "10300", filename: "report.txt", size: ATTACHED.length }];
  if (initialOperation === "jira.delete-worklog") {
    state.fields.timespent = 3600;
    state.fields.timetracking = {
      originalEstimateSeconds: 7200,
      remainingEstimateSeconds: 3600,
      timeSpentSeconds: 3600,
    };
  }
  let writes = 0;
  async function privateResponse(
    native: NonNullable<ReturnType<typeof privateNativeTransportController>>,
    request: Request,
  ): Promise<Response> {
    if (request.method === "GET" && mode === "readback-denied" && writes > 0)
      return Response.json({}, { status: 403 });
    const result = await native.handle(request);
    state.lifecycle = native.snapshot();
    if (request.method !== "GET" && mode === "lost-response")
      throw new TypeError("Synthetic connection loss after commit");
    return result;
  }
  function fixtureResponse(result: Awaited<ReturnType<typeof fixtureReadResult>>): Response {
    if (result.kind !== "response") throw new Error("Expected synthetic HTTP response");
    return new Response(result.status === 204 ? null : (result.archiveBytes ?? result.bodyText), {
      status: result.status,
      headers: {
        "content-type": result.archiveBytes === undefined ? "application/json" : "application/zip",
        ...(result.applicationRoleVersion === undefined
          ? {}
          : { etag: result.applicationRoleVersion }),
      },
    });
  }
  return {
    state,
    writes: () => writes,
    fetch: async (input, init): Promise<Response> => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (privateNative === undefined) await assertNativeRequestHeaders(request, path);
      if (request.method !== "GET") {
        beforeWrite();
        writes += 1;
      }
      const refusal = await scriptedRefusal(mode, request);
      if (refusal !== undefined) return refusal;
      if (privateNative !== undefined) return privateResponse(privateNative, request);
      const result =
        request.method === "GET"
          ? await fixtureReadResult(mode, request.url, state, writes, lifecycle, initialOperation)
          : await fixtureWriteResult(request, path, state, lifecycle);
      if (request.method !== "GET" && mode === "lost-response")
        throw new TypeError("Synthetic connection loss after commit");
      return fixtureResponse(result);
    },
  };
}
/** A governed upload reaches Jira as one multipart POST that carries the XSRF opt-out header. */
async function fixtureWriteResult(
  request: Request,
  path: string,
  state: MutationRemoteState,
  lifecycle: ReturnType<typeof lifecycleRemoteFixture>,
): Promise<ReturnType<typeof fixtureWrite>> {
  const nativeLifecycle = await lifecycle.write(request);
  if (nativeLifecycle !== undefined) {
    state.lifecycle = lifecycle.snapshot();
    return nativeLifecycle;
  }
  const writers = [
    (): ReturnType<typeof nativeSavedConfigurationWrite> =>
      nativeSavedConfigurationWrite(request, state.savedConfiguration),
    (): ReturnType<typeof nativeAdministrationWrite> =>
      nativeAdministrationWrite(request, state.administration),
    (): ReturnType<typeof nativeDeletionWrite> => nativeDeletionWrite(request, state),
    (): ReturnType<typeof nativeParticipationWrite> => nativeParticipationWrite(request, state),
  ];
  for (const write of writers) {
    const result = await write();
    if (result !== undefined) return result;
  }
  if (
    path.includes("/worklog") &&
    new URL(request.url).searchParams.get("adjustEstimate") !== "leave"
  )
    throw new TypeError("Worklogs must retain the existing remaining estimate");
  if (!request.headers.get("content-type")?.startsWith("multipart/form-data; boundary=keiko-")) {
    const text = await request.text();
    return nativeWrite(path, text, state) ?? fixtureWrite(path, text, state);
  }
  expect(request.headers.get("x-atlassian-token")).toBe("no-check");
  expect(request.method).toBe("POST");
  return fixtureWrite(path, undefined, state, {
    bytes: new Uint8Array(await request.arrayBuffer()),
  });
}
async function mutationCredentials(
  fetchImpl: typeof fetch,
  activityLog: ReturnType<typeof createBufferedServerLogSink>,
  verifyConnection = true,
): Promise<{
  credentials: AtlassianConnectorCredentialDeps;
  metadata: AtlassianCredentialMetadata;
}> {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "keiko-jira-mutation-custody-"));
  cleanup.push(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const credentials = buildAtlassianConnectorCredentialDeps({
    configPath: join(directory, "gateway.json"),
    env: { KEIKO_ATLASSIAN_CONNECTOR_CREDENTIALS_KEY: randomBytes(32).toString("base64") },
    egress: () => undefined,
    fetchImpl,
    activityLog,
  });
  const metadata = credentials.custody.create(
    {
      provider: "jira",
      deployment: "data-center",
      authScheme: "bearer-pat",
      displayName: "Synthetic mutation Jira",
      baseUrl: BASE_URL,
      apiToken: ["synthetic", "test", "pat"].join("-"),
      livePodCreationRequestId: randomUUID(),
    },
    "a".repeat(64),
  );
  if (!verifyConnection) return { credentials, metadata };
  expect(await verifyStoredCredential(credentials, metadata, "mutation-fixture-verification")).toBe(
    "ok",
  );
  const verified = credentials.custody.getMetadata(metadata.authRef);
  if (verified === undefined) throw new Error("Expected verified synthetic Jira metadata");
  expect(verified).toMatchObject({ livePod: { verificationStatus: "ok" } });
  return { credentials, metadata: verified };
}
function privateFixturePod(metadata: AtlassianCredentialMetadata): JiraLivePodMetadata {
  if (metadata.deployment !== "data-center" || metadata.livePod === undefined)
    throw new TypeError("Missing real private Pod binding");
  return metadata.livePod;
}
/**
 * Every write is judged against a template of its type (#4354), so the fixture holds a rule-free
 * template for each synthetic issue type. Deleting an issue type that a template names is refused
 * on purpose (a saved rule would change meaning), so that one case holds a template of a type the
 * deletion does not touch.
 */
function integrationTemplates(
  operation: JiraMutationOperation | undefined,
): ReturnType<typeof permissiveJiraTemplates> {
  return operation === "jira.delete-issue-type"
    ? permissiveJiraTemplates(["SYN"], ["Epic"])
    : permissiveJiraTemplates(["SYN"], SYNTHETIC_ISSUE_TYPES);
}
async function fixture(
  mode: RemoteMode = "confirmed",
  afterAcknowledgement?: "binding-revoked" | "cancelled",
  initialOperation?: JiraMutationOperation,
  authoritySelection: FixtureAuthoritySelection = {},
  templates?: () => ReturnType<typeof integrationTemplates>,
): Promise<{
  invoke: (
    operation: JiraMutationOperation,
    args?: CatalogJsonObject,
  ) => Promise<CatalogToolDispatchOutcome>;
  intent: () => ChatToolMutationIntent;
  journal: ReturnType<typeof createChatToolMutationStore>;
  writes: () => number;
  state: MutationRemoteState;
  logs: ReturnType<typeof createBufferedServerLogSink>;
  offered: unknown;
  privatePrerequisites:
    { sessionAvailable: boolean; sourceAvailable: boolean; inputAvailable: boolean } | undefined;
}> {
  const db = database();
  // Explicit fixture authority mirrors the independent human opt-in; mode and custody add no admin.
  const connectorScopes = new Set<CodingWorkbenchConnectorScope>([
    "issue-tracker.read",
    "issue-tracker.write",
    ...(authoritySelection.adminScope === true ? ["issue-tracker.admin" as const] : []),
  ]);
  let activeInvocation = "";
  let activeIntent: ChatToolMutationIntent | undefined;
  // Binder cancellation can settle first; the fixture also joins the durable mutation owner.
  const executions = new Map<string, ReturnType<typeof executeJiraChatMutation>>();
  let invalidate = (): void => undefined;
  const jira = remote(
    mode,
    () => {
      expect(db.journal.find(activeInvocation)?.phase).toBe("dispatched");
    },
    initialOperation,
  );
  const privateComposition = privateNativeComposition(
    initialOperation,
    BASE_URL,
    jira.fetch,
    db.logs,
    { store: db.store, chatId: db.chatId },
  );
  if (privateComposition !== undefined) cleanup.push(privateComposition.close);
  const credentialOwner = privateComposition ?? (await mutationCredentials(jira.fetch, db.logs));
  const metadata: unknown = credentialOwner.metadata;
  if (metadata === undefined) throw new TypeError("Missing native fixture credentials");
  function httpPort(
    lifecycle: AtlassianHttpLifecycleOptions,
    correlationId: string,
  ): AtlassianHttpBodyPort {
    if (privateComposition !== undefined) return privateComposition.http(lifecycle);
    if (!("credentials" in credentialOwner))
      throw new TypeError("Missing ordinary native fixture credentials");
    return credentialOwner.credentials.httpBodyPortFactory(
      credentialOwner.metadata,
      correlationId,
      lifecycle,
    );
  }
  function observedLifecycle(
    lifecycle: AtlassianHttpLifecycleOptions,
  ): AtlassianHttpLifecycleOptions {
    return {
      ...lifecycle,
      onResponse: (request, status): boolean => {
        const observed = lifecycle.onResponse?.(request, status) === true;
        if (request.method !== "GET" && observed) invalidate();
        return observed;
      },
    };
  }
  const executeMutation: JiraManagedMutationExecutor<
    CatalogHandlerContext<ConversationConsumer>
  > = (operation, args, context, execute) => {
    activeInvocation = context.invocationId;
    activeIntent = Object.freeze({
      invocationId: context.invocationId,
      chatId: context.chatId,
      userMessageId: db.userMessageId,
      turnRef: db.turnRef,
      actorId: context.actorId,
      podId:
        privateComposition === undefined
          ? "synthetic-pod"
          : privateFixturePod(privateComposition.metadata).podId,
      bindingGeneration: context.binding.generation,
      credentialGeneration: 1,
      authorityDigest: sha256Hex(
        canonicalise({ authority: context.authority, connectorScopes: [...connectorScopes] }),
      ),
      actionDigest: sha256Hex(canonicalise({ operation, args })),
      operation,
      correlationId: context.correlationId,
    });
    const shared = {
      journal: db.journal,
      intent: activeIntent,
      httpPortFactory: (lifecycle: AtlassianHttpLifecycleOptions): AtlassianHttpBodyPort =>
        httpPort(observedLifecycle(lifecycle), context.correlationId),
      beforeEffect: (): boolean =>
        context.beforeEffect() && connectorScopes.has(jiraRequiredConnectorScope(operation)),
      beforeMutation: (): boolean =>
        context.beforeEffect() && connectorScopes.has(jiraRequiredConnectorScope(operation)),
    };
    if (operation !== "jira.draft") {
      const execution = executeJiraChatMutation({
        ...shared,
        execute: async (http, lifecycle) => {
          if (privateComposition === undefined) return execute(http);
          const livePod = privateFixturePod(privateComposition.metadata);
          const ports = await privateComposition.ports(
            context,
            args,
            observedLifecycle(lifecycle),
            {
              context: {
                kind: "chat",
                chatId: context.chatId,
                messageId: db.userMessageId,
                callId: context.invocationId,
                podId: livePod.podId,
                bindingGeneration: context.binding.generation,
              },
              authority: { runId: db.turnRef, envelopeDigest: shared.intent.authorityDigest },
            },
          );
          return execute(http, undefined, ports);
        },
      });
      executions.set(context.invocationId, execution);
      return execution;
    }
    // The draft itself is never journaled; its one synthetic item is what reaches Jira.
    activeInvocation = jiraDraftChildIntent(activeIntent, "one").invocationId;
    return executeJiraChatDraft({
      ...shared,
      arguments: args,
      deselected: [],
      context,
      connection: {
        deployment: "data-center",
        baseUrl: BASE_URL,
        issueTemplates: (): ReturnType<typeof integrationTemplates> =>
          templates?.() ?? integrationTemplates(initialOperation),
      },
    });
  };
  // A case offers its actual operation and the explicit next write used to prove that an
  // uncertain effect blocks the turn. The complete inventory remains covered by it.each below.
  const tools = [
    ...new Set<JiraMutationOperation>([initialOperation ?? "jira.create", "jira.comment"]),
  ];
  const provider = createJiraProviderForCatalog<CatalogHandlerContext<ConversationConsumer>>(
    () => ({
      deployment: "data-center",
      baseUrl: BASE_URL,
      http: vi.fn(() => {
        throw new Error("Mutation must use the journal-owned HTTP port");
      }),
      emailTemplates: emailTemplateFixtureAdmission(),
      issueTemplates: (): ReturnType<typeof integrationTemplates> =>
        templates?.() ?? integrationTemplates(initialOperation),
      attachmentSource: (): ReturnType<JiraAttachmentSource> => {
        const sha256 = createHash("sha256").update(ATTACHED).digest("hex");
        return Promise.resolve({
          ok: true,
          content: { name: "report.txt", bytes: ATTACHED, sha256 },
        });
      },
    }),
    tools,
    executeMutation,
  );
  const managed = await createManagedProviderCatalog<ConversationConsumer>({
    providers: [provider],
    profile: { id: "jira-mutation-fixture", version: 1 },
    log: { primary: db.logs, diagnostics: { record: () => undefined } },
    correlationId: "mutation-admission",
    now: () => 1000,
    routes: jiraChatCatalogRoutes(tools).map(({ name, alias }) => ({
      name,
      alias,
      catalogAction: name,
      previewAction: (identity): ConversationAction => ({
        ...identity,
        action: "mutation",
        query: name,
      }),
      actionFor: (args, identity): ConversationAction => ({
        ...identity,
        action: "mutation",
        query: canonicalise({ name, args }),
      }),
      resultFor: (data): CatalogHandlerResult => ({
        data,
        page: { truncated: false, reason: "none", cursor: null },
        resultCount: 1,
      }),
    })),
  });
  cleanup.push(() => managed.close());
  const consumer = createConversationConsumerFixture(undefined, managed);
  consumer.context.chatId = db.chatId;
  invalidate = (): void => {
    if (afterAcknowledgement === "cancelled") consumer.abort();
    if (afterAcknowledgement === "binding-revoked") consumer.context.binding.generation++;
  };
  cleanup.push(consumer.dispose);
  let serial = 0;
  const gateway = createGatewayToolCatalogBridge(
    {
      modelId: "synthetic-model",
      messages: [],
      toolCatalog: {
        kind: "bound",
        catalog: managed.catalog,
        projection: managed.projection,
        offered: consumer.binder.offer(),
      },
    },
    () => 1000,
    db.logs,
  );
  return {
    intent: (): ChatToolMutationIntent => {
      if (activeIntent === undefined) throw new Error("Expected mutation intent");
      return activeIntent;
    },
    journal: db.journal,
    writes: jira.writes,
    state: jira.state,
    logs: db.logs,
    offered: gateway.tools,
    privatePrerequisites: privateComposition?.controls,
    invoke: async (operation, args = ARGUMENTS[operation]): Promise<CatalogToolDispatchOutcome> => {
      const id = `model-call-${String(++serial)}`;
      const projected = managed.projection.tools.find(
        (tool) => tool.toolRef.canonicalId === jiraMutationToolId(operation),
      );
      if (projected === undefined) throw new TypeError("Expected offered mutation identity");
      const call = gateway.bind({ id, name: projected.alias, arguments: args });
      const outcome = await consumer.binder.dispatch(call.invocation, {
        actionId: id,
        idempotencyKey: id,
      });
      await executions.get(outcome.receipt.invocationId);
      executions.delete(outcome.receipt.invocationId);
      return outcome;
    },
  };
}

it.each(["binding-revoked", "cancelled"] as const)(
  "preserves the durable effect after %s interrupts the actual SDK/binder call",
  async (interruption) => {
    const f = await fixture("confirmed", interruption);
    const outcome = await f.invoke("jira.create");
    if (outcome.kind !== "settled") throw new Error("Expected settled invocation");
    expect(outcome.result).toMatchObject({
      status: interruption === "cancelled" ? "cancelled" : "invalid",
      data: null,
    });
    const expected = f.intent();
    expect(
      jiraChatMutationOutcome({
        result: outcome.result,
        record: f.journal.find(expected.invocationId),
        expected,
      }),
    ).toBe("succeeded-unconfirmed");
    expect(outcome.receipt).toMatchObject({ effectStarted: true, budgetDisposition: "committed" });
    expect(f.writes()).toBe(1);
    expect(f.state).toMatchObject(REMOTE_STATE["jira.create"]);
  },
);

it.each(["jira.login", "jira.upload-project-avatar"] as const)(
  "retains %s native acknowledgement before cancelled private proof/cleanup",
  async (operation) => {
    const f = await fixture("confirmed", "cancelled", operation, reviewedAuthority(operation));
    const outcome = await f.invoke(operation);
    expect(outcome).toMatchObject({ kind: "settled", result: { status: "cancelled", data: null } });
    expect(f.journal.find(f.intent().invocationId)).toMatchObject({
      phase: "settled",
      outcome: "succeeded-unconfirmed",
    });
    expect(f.writes()).toBe(1);
    await f.invoke(operation);
    expect(f.writes()).toBe(1);
  },
);

it.each([
  { operation: "jira.upload-project-avatar", missing: "sessionAvailable" },
  { operation: "jira.upload-project-avatar", missing: "sourceAvailable" },
  { operation: "jira.login", missing: "inputAvailable" },
  { operation: "jira.unlock-user-anonymization", missing: "inputAvailable" },
] as const)(
  "refuses $operation before native effects when real $missing is unavailable",
  async ({ operation, missing }) => {
    const f = await fixture("confirmed", undefined, operation, reviewedAuthority(operation));
    if (f.privatePrerequisites === undefined)
      throw new TypeError("Missing actual private corpus composition");
    f.privatePrerequisites[missing] = false;
    const outcome = await f.invoke(operation);
    expect(outcome).toMatchObject({
      kind: "settled",
      result: { status: "failed", data: { outcome: "not-dispatched" } },
    });
    expect(f.writes()).toBe(0);
    expect(f.journal.find(f.intent().invocationId)?.phase).not.toBe("acknowledged");
  },
);

it.each(PRIVATE_ACCOUNT_READ_CASES)(
  "keeps $name a native POST read through the actual catalog and private custody",
  async (item) => {
    const selected = privateNativeCase(item.name);
    const native = privateNativeTransportController(item.name);
    if (selected === undefined || native === undefined)
      throw new TypeError("Missing independent validator fixture");
    const db = database();
    let invocation = "";
    const composition = privateNativeComposition(
      item.name,
      BASE_URL,
      async (input, init) => native.handle(new Request(input, init)),
      db.logs,
      { store: db.store, chatId: db.chatId },
    );
    if (composition === undefined)
      throw new TypeError("Missing actual private validator composition");
    cleanup.push(composition.close);
    const mutation = vi.fn<
      JiraManagedMutationExecutor<CatalogHandlerContext<ConversationConsumer>>
    >(() =>
      Promise.reject(new TypeError("Read validation must never enter the mutation executor")),
    );
    const provider = createJiraProviderForCatalog<CatalogHandlerContext<ConversationConsumer>>(
      async (context) => {
        invocation = context.invocationId;
        const pod = privateFixturePod(composition.metadata);
        const ports = await composition.ports(
          context,
          selected.args,
          {},
          {
            context: {
              kind: "chat",
              chatId: context.chatId,
              messageId: db.userMessageId,
              callId: context.invocationId,
              podId: pod.podId,
              bindingGeneration: context.binding.generation,
            },
            authority: { runId: context.runId, envelopeDigest: sha256Hex(context.authority) },
          },
        );
        return { deployment: "data-center", baseUrl: BASE_URL, http: composition.http(), ...ports };
      },
      [item.name],
      mutation,
    );
    const managed = await createManagedProviderCatalog<ConversationConsumer>({
      providers: [provider],
      profile: { id: "jira-private-validator-fixture", version: 1 },
      log: { primary: db.logs, diagnostics: { record: () => undefined } },
      correlationId: "private-validator",
      now: () => 1000,
      routes: jiraChatCatalogRoutes([item.name]).map(({ name, alias }) => ({
        name,
        alias,
        catalogAction: name,
        previewAction: (identity): ConversationAction => ({
          ...identity,
          action: "lookup",
          query: name,
        }),
        actionFor: (args, identity): ConversationAction => ({
          ...identity,
          action: "lookup",
          query: canonicalise({ name, args }),
        }),
        resultFor: (data): CatalogHandlerResult => ({
          data,
          page: { truncated: false, reason: "none", cursor: null },
          resultCount: 1,
        }),
      })),
    });
    cleanup.push(() => managed.close());
    const consumer = createConversationConsumerFixture(undefined, managed);
    consumer.context.chatId = db.chatId;
    cleanup.push(consumer.dispose);
    const gateway = createGatewayToolCatalogBridge(
      {
        modelId: "synthetic-model",
        messages: [],
        toolCatalog: {
          kind: "bound",
          catalog: managed.catalog,
          projection: managed.projection,
          offered: consumer.binder.offer(),
        },
      },
      () => 1000,
      db.logs,
    );
    const projected = managed.projection.tools[0];
    if (projected === undefined) throw new TypeError("Missing actual validator descriptor");
    const call = gateway.bind({
      id: "private-validation-call",
      name: projected.alias,
      arguments: selected.args,
    });
    const result = await consumer.binder.dispatch(call.invocation, {
      actionId: "private-validation-call",
      idempotencyKey: "private-validation-call",
    });
    expect(result).toMatchObject({
      kind: "settled",
      result: {
        status: "completed",
        data: {
          outcome: "succeeded",
          accepted: true,
          violationCount: 0,
          validationScope: item.scope,
        },
      },
    });
    expect(native.snapshot()).toEqual({ validations: 1 });
    expect(mutation).not.toHaveBeenCalled();
    expect(db.journal.find(invocation)).toBeUndefined();
    for (const secret of [
      PRIVATE_NATIVE_PASSWORD,
      PRIVATE_NATIVE_LICENSE,
      PRIVATE_NATIVE_COOKIE.value,
    ]) {
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(db.logs.lines().join()).not.toContain(secret);
    }
  },
);

it.each(SINGLE_MUTATIONS)(
  "executes %s through the real gateway/binder/SDK and durable journal",
  async (operation) => {
    const f = await fixture("confirmed", undefined, operation, reviewedAuthority(operation));
    const expectedOutcome =
      [
        expectedFinalOutcome,
        expectedSystemAdministrationOutcome,
        expectedSchemeSettingOutcome,
        expectedPermissionRoleOutcome,
        expectedPlanningOutcome,
        expectedConfigurationOutcome,
        expectedLifecycleOutcome,
        expectedSavedConfigurationOutcome,
      ].reduce<string | undefined>(
        (outcome, resolve): string | undefined => outcome ?? resolve(operation),
        undefined,
      ) ?? "succeeded";
    expect(await f.invoke(operation)).toMatchObject({
      kind: "settled",
      result: {
        status: expectedOutcome === "succeeded" ? "completed" : "failed",
        data: {
          outcome: expectedOutcome,
          ...SUCCESS_RECEIPTS[operation],
        },
      },
    });
    expect(f.writes()).toBe(1);
    expect(f.state).toMatchObject(REMOTE_STATE[operation]);
    expect(await f.invoke(operation)).toMatchObject({
      kind: "settled",
      result: { data: { outcome: expectedOutcome, replayed: true } },
    });
    expect(f.writes()).toBe(1);
    expect(JSON.stringify(f.offered)).not.toMatch(
      /synthetic-test-pat|203\.0\.113\.10|synthetic-ref/u,
    );
    expect(f.logs.lines().join()).not.toMatch(
      /synthetic-test-pat|203\.0\.113\.10|Synthetic comment|SYN-1/u,
    );
    for (const secret of [
      PRIVATE_NATIVE_PASSWORD,
      PRIVATE_NATIVE_LICENSE,
      PRIVATE_NATIVE_COOKIE.value,
    ]) {
      expect(JSON.stringify(f.offered)).not.toContain(secret);
      expect(f.logs.lines().join()).not.toContain(secret);
    }
  },
);
// #4354, owner decision 2026-11-13: a 404 read-back of the issue after Jira accepted this very
// DELETE is the deletion confirmed; the lab session saw it settle as "may not have been applied".
it("settles an accepted jira.delete-issue as succeeded when the read-back finds the issue gone", async () => {
  const operation = "jira.delete-issue";
  const f = await fixture(
    "issue-gone-after-write",
    undefined,
    operation,
    reviewedAuthority(operation),
  );
  expect(await f.invoke(operation)).toMatchObject({
    kind: "settled",
    result: { status: "completed", data: { outcome: "succeeded" } },
  });
});
// #4354 (AC7): an edit is judged by what it touches. The synthetic issue SYN-1 already breaks the
// summary rule of its type; an edit that does not touch the summary goes through, the model is told
// in the result, and the log has the notice, all from the one real executor run.
function brokenSummaryRule(): ReturnType<typeof integrationTemplates> {
  const parsed = parseJiraIssueTemplate(
    [
      "---",
      "keiko: jira-issue-template",
      "version: 1",
      "project: SYN",
      "issueType: Task",
      "activateOn: [edit]",
      "summaryMinLength: 40",
      "---",
      "# Task",
    ].join("\n"),
  );
  if (!parsed.ok) throw new TypeError("Expected a parseable template");
  return { templates: [parsed.template], unreadable: 0 };
}
const NOTICE = { ruleId: "summary-too-short", template: "SYN/Task" } as const;
it.each([
  ["jira.edit", { issueKey: "SYN-1", fields: { labels: ["noted"] } }],
  [
    "jira.transition",
    { issueKey: "SYN-1", transitionId: "31", fields: { customfield_10000: "Required" } },
  ],
] as const)(
  "names the rule an untouched field already broke as a notice on %s, in the result and the log",
  async (operation, args) => {
    // The template line goes through the process logger, not the fixture's journal sink.
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    const f = await fixture("confirmed", undefined, operation, {}, brokenSummaryRule);
    const outcome = await f.invoke(operation, args);
    expect(f.writes()).toBe(1);
    expect(outcome).toMatchObject({
      kind: "settled",
      result: { data: { outcome: "succeeded", templateNotices: [NOTICE] } },
    });
    expect(JSON.stringify(outcome)).toContain(TEMPLATE_NOTICE_GUIDANCE);
    const notices = sink.events.filter(
      (event) => event.op === "jira.template.admission" && event.extra?.stage === "notice",
    );
    expect(notices).toHaveLength(1);
    const line = expectRegisteredActivityLogLine(
      "jira.template.admission",
      formatActivityLogProofLine(notices[0] ?? {}),
    );
    expect(line).toMatchObject({ stage: "notice" });
    expect(sink.lines().join()).not.toMatch(/Original|SYN-1|noted/u);
  },
);
it("sends an edit of a conforming issue without any notice", async () => {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "debug" }));
  const f = await fixture("confirmed", undefined, "jira.edit");
  const outcome = await f.invoke("jira.edit", { issueKey: "SYN-1", fields: { labels: ["noted"] } });
  expect(outcome).toMatchObject({ kind: "settled", result: { data: { outcome: "succeeded" } } });
  expect(JSON.stringify(outcome)).not.toContain("templateNotices");
  expect(
    sink.events.some(
      (event) => event.op === "jira.template.admission" && event.extra?.stage === "notice",
    ),
  ).toBe(false);
});
it.each(SINGLE_MUTATIONS)(
  "keeps %s unconfirmed when readback is denied and blocks further writes",
  async (operation) => {
    const f = await fixture("readback-denied", undefined, operation, reviewedAuthority(operation));
    expect(await f.invoke(operation)).toMatchObject({
      kind: "settled",
      result: { status: "failed", data: { outcome: "succeeded-unconfirmed" } },
    });
    expect(await f.invoke(operation)).toMatchObject({
      kind: "settled",
      result: { data: { outcome: "succeeded-unconfirmed", replayed: true } },
    });
    expect(
      await f.invoke("jira.comment", { issueKey: "SYN-1", body: "Different action" }),
    ).toMatchObject({
      kind: "settled",
      result: { data: { outcome: "not-dispatched", reason: "conflict" } },
    });
    expect(f.writes()).toBe(1);
  },
);
it.each(SINGLE_MUTATIONS)(
  "never repeats %s after losing the response to an applied mutation",
  async (operation) => {
    const f = await fixture("lost-response", undefined, operation, reviewedAuthority(operation));
    expect(await f.invoke(operation)).toMatchObject({
      kind: "settled",
      result: { data: { outcome: "unknown" } },
    });
    expect(await f.invoke(operation)).toMatchObject({
      kind: "settled",
      result: { data: { outcome: "unknown", replayed: true } },
    });
    expect(f.writes()).toBe(1);
    expect(f.state).toMatchObject(REMOTE_STATE[operation]);
  },
);
it.each([
  { operation: "jira.vote", mode: "voting-disabled" },
  { operation: "jira.create-worklog", mode: "time-tracking-disabled" },
] as const)(
  "returns an actionable rejection for $mode without an uncertain write",
  async ({ operation, mode }) => {
    const f = await fixture(mode, undefined, operation);
    const before = structuredClone(f.state);
    expect(await f.invoke(operation)).toMatchObject({
      kind: "settled",
      result: { data: { outcome: "rejected", messages: [NATIVE_REFUSALS[mode].message] } },
    });
    expect(f.journal.find(f.intent().invocationId)).toMatchObject({
      outcome: "rejected",
      httpStatus: NATIVE_REFUSALS[mode].status,
    });
    expect(f.state).toEqual(before);
    expect(await f.invoke(operation)).toMatchObject({
      kind: "settled",
      result: { data: { outcome: "rejected", replayed: true } },
    });
    expect(f.writes()).toBe(1);
  },
);

function create(value: string): CatalogJsonObject {
  return {
    projectId: "10000",
    issueTypeId: "10001",
    fields: { summary: "Changed", customfield_10000: value },
  };
}
it("returns Jira's field error and lets the corrected retry succeed in the same turn (#4176)", async () => {
  const f = await fixture("jira-error-document");

  const refused = await f.invoke("jira.create", create(REJECTED_VALUE));

  // Data Center validates a whole request before applying anything: its error document is a
  // definitive rejection, so the outcome is `rejected` and Jira's field id and message reach the model.
  expect(refused).toMatchObject({
    kind: "settled",
    result: {
      status: "failed",
      data: {
        outcome: "rejected",
        reason: "field-validation",
        fieldErrors: [{ fieldId: "customfield_10000", message: JIRA_FIELD_ERROR }],
      },
    },
  });
  expect(f.writes()).toBe(1);
  expect(f.state.fields).not.toMatchObject({ customfield_10000: REJECTED_VALUE });
  expect(f.journal.find(f.intent().invocationId)).toMatchObject({
    phase: "settled",
    outcome: "rejected",
    httpStatus: 400,
  });

  const corrected = await f.invoke("jira.create", create("Required"));

  expect(corrected).toMatchObject({
    kind: "settled",
    result: { status: "completed", data: { outcome: "succeeded", issueKey: "SYN-1" } },
  });
  expect(f.writes()).toBe(2);
  expect(f.state).toMatchObject(REMOTE_STATE["jira.create"]);
  expect(f.logs.lines().join()).not.toContain(JIRA_FIELD_ERROR);
});
// A transition Jira listed and then refused because the workflow moved: it settles `rejected` with
// the typed invalid-transition reason and Jira's own words, and a later write of the turn is not
// blocked. Without the error document it would settle `unknown` and block the turn (#4354).
it.each(["transition-moved-404", "transition-moved-400"] as const)(
  "settles a moved-away transition as rejected, not unknown, and does not block the turn (%s)",
  async (mode) => {
    const f = await fixture(mode, undefined, "jira.transition");

    const refused = await f.invoke("jira.transition", {
      issueKey: "SYN-1",
      transitionId: "31",
      fields: { customfield_10000: "Required" },
    });

    expect(refused).toMatchObject({
      kind: "settled",
      result: { status: "failed", data: { outcome: "rejected", reason: "invalid-transition" } },
    });
    expect(f.journal.find(f.intent().invocationId)).toMatchObject({
      phase: "settled",
      outcome: "rejected",
    });
    expect(f.writes()).toBe(1);
    expect(await f.invoke("jira.comment", { issueKey: "SYN-1", body: "Moving on" })).toMatchObject({
      kind: "settled",
      result: { data: { outcome: "succeeded" } },
    });
    expect(f.writes()).toBe(2);
  },
);
// The no-replay rule (#2953): a moved-away transition answered WITHOUT Jira's error document (an
// empty, HTML or truncated body) is still told to the model as invalid-transition, but the journal
// cannot say that Jira, and not a proxy, refused it, so the write stays uncertain and the turn's
// later writes are blocked. Only the error document settles it rejected (the test above).
it.each(["transition-moved-empty", "transition-moved-html", "transition-moved-truncated"] as const)(
  "keeps a moved-away transition answered without Jira's error document uncertain under the no-replay rule (%s)",
  async (mode) => {
    const f = await fixture(mode, undefined, "jira.transition");

    const refused = await f.invoke("jira.transition", {
      issueKey: "SYN-1",
      transitionId: "31",
      fields: { customfield_10000: "Required" },
    });

    expect(refused).toMatchObject({
      kind: "settled",
      result: { status: "failed", data: { outcome: "unknown" } },
    });
    expect(await f.invoke("jira.comment", { issueKey: "SYN-1", body: "Moving on" })).toMatchObject({
      kind: "settled",
      result: { data: { outcome: "not-dispatched", reason: "conflict" } },
    });
    expect(f.writes()).toBe(1);
  },
);
// #4354 (live Gemma composer run): a Sub-task asked under a Story is refused by the template's parent
// rule, and the model must RECEIVE that refusal: a valid, explained result naming the rule and the
// type the parent actually has. The refusal's guidance once exceeded the result schema of jira.create
// and the catalog rejected the whole result (`result-contract-failed`, data null).
it("settles a create refused by the template's parent rule as a valid, explained result", async () => {
  const parsed = parseJiraIssueTemplate(
    [
      "---",
      "keiko: jira-issue-template",
      "version: 1",
      "project: SYN",
      "issueType: Story",
      "activateOn: [create]",
      'parentField: "parent"',
      "parentIssueTypes: [Epic]",
      "---",
      "# Story",
    ].join("\n"),
  );
  if (!parsed.ok) throw new TypeError("Expected a parseable template");
  const f = await fixture("parent-offered", undefined, "jira.create", {}, () => ({
    templates: [parsed.template],
    unreadable: 0,
  }));

  const refused = await f.invoke("jira.create", {
    projectId: "10000",
    issueTypeId: "10001",
    fields: { summary: "A story under a task", customfield_10000: "Required", parent: "SYN-1" },
  });

  // SYN-1 is a Task in this synthetic Jira, the template wants a Story parent: nothing is written.
  expect(f.writes()).toBe(0);
  expect(refused).toMatchObject({
    kind: "settled",
    result: {
      status: "failed",
      data: {
        outcome: "rejected",
        reason: "field-validation",
        violations: [{ ruleId: "parent-type-mismatch", template: "SYN/Story" }],
      },
    },
  });
  expect(JSON.stringify(refused)).toContain("found: Task");
  if (refused.kind !== "settled") throw new TypeError("Expected a settled outcome");
  const { data } = refused.result;
  if (typeof data !== "object" || data === null || Array.isArray(data))
    throw new TypeError("Expected a result object");
  expect(Reflect.get(data, "guidance")).toBe(
    jiraTemplateViolationGuidance([
      { ruleId: "parent-type-mismatch", subject: "parent", template: "SYN/Story" },
    ]),
  );
});
// The same proof for an EDIT (#4354): refused by the template's parent rule alone, and by the parent
// rule together with a missing section, the longest guidance the gate writes. Each settles as a
// valid, explained result through the catalog's own result validation.
function parentTemplate(...extra: readonly string[]): ReturnType<typeof integrationTemplates> {
  const parsed = parseJiraIssueTemplate(
    [
      "---",
      "keiko: jira-issue-template",
      "version: 1",
      "project: SYN",
      "issueType: Task",
      "activateOn: [edit]",
      'parentField: "parent"',
      "parentIssueTypes: [Story]",
      "---",
      "# Task",
      ...extra,
    ].join("\n"),
  );
  if (!parsed.ok) throw new TypeError("Expected a parseable template");
  return { templates: [parsed.template], unreadable: 0 };
}
it.each([
  ["the parent rule", [], { parent: "SYN-2" }, [{ ruleId: "parent-type-mismatch" }]],
  [
    "the parent rule together with a missing section",
    ["## Acceptance criteria"],
    { parent: "SYN-2", description: "No such section here." },
    [{ ruleId: "section-missing" }, { ruleId: "parent-type-mismatch" }],
  ],
] as const)(
  "settles an edit refused by %s as a valid, explained result",
  async (_name, sections, fields, violations) => {
    const f = await fixture("parent-offered", undefined, "jira.edit", {}, () =>
      parentTemplate(...sections),
    );

    const refused = await f.invoke("jira.edit", { issueKey: "SYN-1", fields });

    expect(f.writes()).toBe(0);
    expect(refused).toMatchObject({
      kind: "settled",
      result: {
        status: "failed",
        data: { outcome: "rejected", reason: "field-validation", violations },
      },
    });
    if (refused.kind !== "settled") throw new TypeError("Expected a settled outcome");
    const { data } = refused.result;
    if (typeof data !== "object" || data === null || Array.isArray(data))
      throw new TypeError("Expected a result object");
    expect(Reflect.get(data, "guidance")).toBe(
      jiraTemplateViolationGuidance(
        violations.map(({ ruleId }) => ({ ruleId, subject: "x", template: "SYN/Task" })),
      ),
    );
  },
);
// The live Gemma run "remove the Epic assignment" (REQ-448): clearing the Epic Link a Story template
// requires is refused by the template's parent rule, and every such edit ended with
// `result-contract-failed` and data null. The refusal must reach the model as a valid, explained result.
it("settles the removal of an Epic Link that the template requires as a valid, explained result", async () => {
  const parsed = parseJiraIssueTemplate(
    [
      "---",
      "keiko: jira-issue-template",
      "version: 1",
      "project: SYN",
      "issueType: Task",
      "activateOn: [edit]",
      'parentField: "customfield_10109"',
      "---",
      "# Task",
    ].join("\n"),
  );
  if (!parsed.ok) throw new TypeError("Expected a parseable template");
  const f = await fixture("parent-offered", undefined, "jira.edit", {}, () => ({
    templates: [parsed.template],
    unreadable: 0,
  }));

  const refused = await f.invoke("jira.edit", {
    issueKey: "SYN-1",
    fields: { customfield_10109: null },
  });

  expect(f.writes()).toBe(0);
  expect(refused).toMatchObject({
    kind: "settled",
    result: {
      status: "failed",
      data: {
        outcome: "rejected",
        reason: "field-validation",
        violations: [{ ruleId: "parent-missing", template: "SYN/Task" }],
      },
    },
  });
  if (refused.kind !== "settled") throw new TypeError("Expected a settled outcome");
  const { data } = refused.result;
  if (typeof data !== "object" || data === null || Array.isArray(data))
    throw new TypeError("Expected a result object");
  expect(Reflect.get(data, "guidance")).toBe(
    jiraTemplateViolationGuidance([
      { ruleId: "parent-missing", subject: "customfield_10109", template: "SYN/Task" },
    ]),
  );
});
it.each(["html-error-page", "server-error"] as const)(
  "keeps the turn blocked after %s: the write may have been applied (#2953)",
  async (mode) => {
    const f = await fixture(mode);

    const refused = await f.invoke("jira.create", create(REJECTED_VALUE));

    expect(refused).toMatchObject({
      kind: "settled",
      result: { status: "failed", data: { outcome: "unknown" } },
    });
    expect(await f.invoke("jira.create", create("Required"))).toMatchObject({
      kind: "settled",
      result: { data: { outcome: "not-dispatched", reason: "conflict" } },
    });
    expect(f.writes()).toBe(1);
  },
);

it("requires explicit clearing and rejects ambiguous assignment through the SDK path", async () => {
  const f = await fixture("confirmed", undefined, "jira.assign");
  expect(
    await f.invoke("jira.assign", {
      issueKey: "SYN-1",
      assigneeName: "synthetic-user",
      clearAssignee: true,
    }),
  ).toMatchObject({
    kind: "settled",
    result: { data: { outcome: "rejected", reason: "field-validation" } },
  });
  expect(f.writes()).toBe(0);
  expect(await f.invoke("jira.assign", { issueKey: "SYN-1", clearAssignee: true })).toMatchObject({
    kind: "settled",
    result: { data: { outcome: "succeeded" } },
  });
  expect(f.state.fields.assignee).toBeNull();
  expect(f.writes()).toBe(1);
});

/** The registered settled line of the one mutation a fixture ran. */
function settledMutationLine(
  logs: ReturnType<typeof createBufferedServerLogSink>,
): Record<string, unknown> {
  const settled = logs.events.filter(
    (event) => event.op === "chat.tool-mutation" && event.extra?.event === "settled",
  );
  expect(settled).toHaveLength(1);
  return expectRegisteredActivityLogLine(
    "chat.tool-mutation",
    formatActivityLogProofLine(settled[0] ?? {}),
  );
}
// #4173: a write Keiko refuses before dispatch settles `rejected` with no HTTP status. Its settled
// line must name Keiko's closed reason, or the log cannot say why the model's write failed.
it("names Keiko's closed reason on the settled line of a write refused before dispatch", async () => {
  const f = await fixture("confirmed", undefined, "jira.assign");

  await f.invoke("jira.assign", {
    issueKey: "SYN-1",
    assigneeName: "synthetic-user",
    clearAssignee: true,
  });

  expect(f.writes()).toBe(0);
  const line = settledMutationLine(f.logs);
  // The refusal now names its argument (#4173); the line keeps only the closed class, never the
  // argument's name or the sentence the model reads.
  expect(line).toMatchObject({
    outcome: "rejected",
    refusalReason: "field-validation",
    fieldValidation: "required-field",
  });
  expect(line).not.toHaveProperty("rejection");
  expect(f.logs.lines().join()).not.toMatch(
    /synthetic-user|SYN-1|assigneeName|Nothing was changed/u,
  );
});
it("names the closed field-validation class of a field Keiko refused before dispatch", async () => {
  const f = await fixture();

  await f.invoke("jira.create", {
    projectId: "10000",
    issueTypeId: "10001",
    fields: { summary: "Changed", customfield_99999: "synthetic-value" },
  });

  expect(f.writes()).toBe(0);
  expect(settledMutationLine(f.logs)).toMatchObject({
    outcome: "rejected",
    refusalReason: "field-validation",
    fieldValidation: "invalid-field",
  });
  expect(f.logs.lines().join()).not.toMatch(/customfield_99999|synthetic-value/u);
});
it("records no local refusal reason once Jira itself answered the write", async () => {
  const f = await fixture("jira-error-document");

  await f.invoke("jira.create", create(REJECTED_VALUE));

  const line = settledMutationLine(f.logs);
  expect(line).toMatchObject({ outcome: "rejected", rejection: "jira-error-document" });
  expect(line).not.toHaveProperty("refusalReason");
  expect(line).not.toHaveProperty("fieldValidation");
});
it("runs a backlog draft through the real gateway/binder/SDK as journaled item creates (#4178)", async () => {
  const f = await fixture("confirmed", undefined, "jira.draft");
  expect(await f.invoke("jira.draft")).toMatchObject({
    kind: "settled",
    result: {
      status: "completed",
      data: {
        outcome: "succeeded",
        createdCount: 1,
        items: [
          {
            ref: "one",
            state: "created",
            issueKey: "SYN-1",
            browseUrl: `${BASE_URL}/browse/SYN-1`,
          },
        ],
      },
    },
  });
  expect(f.writes()).toBe(1);
  expect(f.state).toMatchObject(REMOTE_STATE["jira.create"]);
  const child = jiraDraftChildIntent(f.intent(), "one");
  expect(f.journal.find(child.invocationId)).toMatchObject({
    operation: "jira.create",
    outcome: "succeeded",
  });
  expect(f.journal.find(f.intent().invocationId)).toBeUndefined();
  expect(await f.invoke("jira.draft")).toMatchObject({
    kind: "settled",
    result: { data: { outcome: "succeeded", items: [{ ref: "one", state: "created" }] } },
  });
  expect(f.writes()).toBe(1);
  expect(f.logs.lines().join()).not.toMatch(/synthetic-test-pat|203\.0\.113\.10|SYN-1/u);
});

it("requires saved target admission before the SDK fixture can dispatch any HTTP", async () => {
  const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({})));
  const logs = createBufferedServerLogSink();
  const { credentials, metadata } = await mutationCredentials(fetchImpl, logs, false);
  expect(
    await credentials.httpBodyPortFactory(
      metadata,
      "mutation-missing-admission",
    )({
      method: "GET",
      url: `${BASE_URL}/rest/api/2/myself`,
      timeoutMs: 1000,
      maxBodyBytes: 4096,
    }),
  ).toEqual({ kind: "network-error" });
  expect(fetchImpl).not.toHaveBeenCalled();
  const admission = logs.events.filter((event) => event.op === "atlassian.target.admission");
  expect(admission).toHaveLength(1);
  for (const event of admission) {
    const line = formatActivityLogProofLine(event);
    expect(expectRegisteredActivityLogLine("atlassian.target.admission", line)).toMatchObject({
      source: "saved-data-center",
      outcome: "blocked",
    });
    expect(line).not.toMatch(/203\.0\.113\.10|synthetic-test-pat|Authorization|Bearer/u);
    expect(line).not.toContain(metadata.authRef);
  }
});

it("treats a draft whose items all exist already as a completed no-op, not a tool error (#4178)", async () => {
  const f = await fixture("confirmed", undefined, "jira.draft");
  expect(await f.invoke("jira.draft")).toMatchObject({
    kind: "settled",
    result: { status: "completed", data: { outcome: "succeeded", createdCount: 1 } },
  });
  expect(f.writes()).toBe(1);
  // The same backlog under another local reference is a new draft action with a fresh journal:
  // its one item is reconciled to the issue that exists, so Jira receives nothing.
  const [first] = ARGUMENTS["jira.draft"].items as readonly Record<string, unknown>[];
  const rerun = { items: [{ ...first, ref: "uno" }] } as unknown as CatalogJsonObject;
  expect(await f.invoke("jira.draft", rerun)).toMatchObject({
    kind: "settled",
    result: {
      status: "completed",
      data: {
        outcome: "not-dispatched",
        existingCount: 1,
        createdCount: 0,
        failedCount: 0,
        items: [{ ref: "uno", state: "existing", issueKey: "SYN-1" }],
      },
    },
  });
  expect(f.writes()).toBe(1);
});

it.each([51, 100])(
  "rejects %s updates at the catalog boundary before journal preparation",
  async (count) => {
    const f = await fixture("confirmed", undefined, "jira.edit");
    const prepare = vi.spyOn(f.journal, "prepare");
    await expect(
      f.invoke("jira.edit", {
        issueKey: "SYN-1",
        fields: {},
        updates: Array.from({ length: count }, (_, index) => ({
          fieldId: "labels",
          operation: "add",
          value: `label-${String(index)}`,
        })),
      }),
    ).rejects.toMatchObject({ reason: "invalid-arguments" });
    expect(prepare).not.toHaveBeenCalled();
    expect(f.writes()).toBe(0);
    const rejections = f.logs.events.filter(
      (event) => event.op === "gateway.tool-catalog.rejected",
    );
    expect(rejections).toHaveLength(1);
    for (const event of rejections)
      expect(
        expectRegisteredActivityLogLine(
          "gateway.tool-catalog.rejected",
          formatActivityLogProofLine(event),
        ),
      ).toMatchObject({ reason: "invalid-arguments" });
  },
);

it("keeps an independent complete argument/state/receipt case for every registered native mutation", () => {
  expect(Object.keys(ARGUMENTS).sort()).toEqual([...JIRA_MUTATION_OPERATIONS].sort());
  const inScope = (names: readonly string[]): string[] =>
    names.filter((name) => jiraOperationInReleaseScope(name)).sort();
  expect(inScope(Object.keys(REMOTE_STATE))).toEqual([...SINGLE_MUTATIONS].sort());
  expect(inScope(Object.keys(SUCCESS_RECEIPTS))).toEqual([...SINGLE_MUTATIONS].sort());
  expect(ADMIN_MUTATIONS).toHaveLength(139);
  expect(Object.keys(FINAL_EXPECTED_OUTCOMES)).toHaveLength(42);
  expect(
    Object.entries(FINAL_EXPECTED_OUTCOMES)
      .filter(([, outcome]) => outcome === "succeeded")
      .map(([name]) => name)
      .sort(),
  ).toEqual([
    "jira.login",
    "jira.set-project-avatar",
    "jira.set-user-avatar",
    "jira.update-myself",
    "jira.update-user",
  ]);
  expect(Object.keys(SCHEME_SETTING_EXPECTED_OUTCOMES)).toHaveLength(35);
  expect(
    Object.entries(SCHEME_SETTING_EXPECTED_OUTCOMES)
      .filter(([, outcome]) => outcome === "succeeded-unconfirmed")
      .map(([name]) => name)
      .sort(),
  ).toEqual([
    "jira.add-issue-type-scheme-projects",
    "jira.apply-email-template-pack",
    "jira.clear-issue-type-scheme-projects",
    "jira.delete-issue-type-scheme",
    "jira.delete-priority-scheme",
    "jira.delete-workflow-scheme",
    "jira.delete-workflow-scheme-default",
    "jira.delete-workflow-scheme-issue-type",
    "jira.delete-workflow-scheme-workflow",
    "jira.remove-issue-type-scheme-project",
    "jira.revert-email-template-pack",
    "jira.set-instance-base-url",
    "jira.set-issue-type-scheme-projects",
    "jira.set-workflow-scheme-default",
    "jira.set-workflow-scheme-issue-type",
    "jira.set-workflow-scheme-workflow",
    "jira.upload-email-template-pack",
  ]);
  expect(
    Object.entries(PERMISSION_ROLE_EXPECTED_OUTCOMES)
      .filter(([, outcome]) => outcome === "succeeded-unconfirmed")
      .map(([name]) => name)
      .sort(),
  ).toEqual([
    "jira.add-project-role-actors",
    "jira.add-role-default-actors",
    "jira.delete-permission-scheme",
    "jira.delete-project-role-actor",
    "jira.delete-role",
    "jira.delete-role-default-actor",
    "jira.set-project-role-actors",
  ]);
  expect(
    Object.entries(PLANNING_EXPECTED_OUTCOMES)
      .filter(([, outcome]) => outcome === "succeeded-unconfirmed")
      .map(([name]) => name)
      .sort(),
  ).toEqual(["jira.delete-project-category", "jira.rank-epic", "jira.rank-issues"]);
  expect(
    Object.entries(LIFECYCLE_EXPECTED_OUTCOMES)
      .filter(([, outcome]) => outcome === "succeeded-unconfirmed")
      .map(([name]) => name)
      .sort(),
  ).toEqual(["jira.delete-component", "jira.merge-version", "jira.remove-and-swap-version"]);
  expect(
    Object.entries(CONFIGURATION_EXPECTED_OUTCOMES)
      .filter(([, outcome]) => outcome === "succeeded-unconfirmed")
      .map(([name]) => name)
      .sort(),
  ).toEqual([
    "jira.add-default-screen-field",
    "jira.delete-board",
    "jira.delete-sprint",
    "jira.swap-sprints",
    "jira.unmap-all-sprints",
  ]);
});
it.each(ADMIN_MUTATIONS)(
  "does not grant %s administration from ordinary issue scopes or verified credentials",
  async (operation) => {
    const f = await fixture("confirmed", undefined, operation);
    const before = structuredClone(f.state);
    expect(await f.invoke(operation)).toMatchObject({
      kind: "settled",
      result: { data: { outcome: "pending", reason: "permission-denied" } },
    });
    expect(f.writes()).toBe(0);
    expect(f.journal.find(f.intent().invocationId)).toBeUndefined();
    expect(f.state).toEqual(before);
  },
);

it("keeps each of the 35 new administrative/issue outcomes explicit through gateway replay", () => {
  expect(Object.keys(SYSTEM_ADMINISTRATION_EXPECTED_OUTCOMES)).toHaveLength(35);
  expect(
    Object.entries(SYSTEM_ADMINISTRATION_EXPECTED_OUTCOMES)
      .filter(([, outcome]) => outcome === "succeeded-unconfirmed")
      .map(([name]) => name)
      .sort(),
  ).toEqual([
    "jira.add-group-user",
    "jira.add-user-application",
    "jira.approve-cluster-upgrade",
    "jira.cancel-cluster-upgrade",
    "jira.create-custom-field",
    "jira.create-index-snapshot",
    "jira.create-issue-type",
    "jira.delete-cluster-node",
    "jira.delete-custom-fields",
    "jira.delete-group",
    "jira.delete-issue-type",
    "jira.delete-link-type",
    "jira.mark-cluster-node-offline",
    "jira.move-link-type",
    "jira.notify-issue",
    "jira.process-reindex-requests",
    "jira.reindex-issues",
    "jira.remove-group-user",
    "jira.remove-user-application",
    "jira.request-cluster-index-snapshot",
    "jira.reset-link-type-order",
    "jira.reset-user-columns",
    "jira.retry-cluster-upgrade",
    "jira.run-upgrade",
    "jira.set-application-role",
    "jira.set-application-roles",
    "jira.start-cluster-upgrade",
    "jira.start-reindex",
  ]);
});

// #4354 AC2 (and #4357 AC3, who refused): an Epic Link that names an issue the instance does not know
// as an Epic is refused before anything is sent. The refusal is proven at the connector; here it is
// proven once through what the model receives, for a create and for a single edit: a valid result of
// the catalog that names the rule, the field and the way out.
const epicStory = (): JiraIssueTemplate => {
  const parsed = parseJiraIssueTemplate(
    [
      "---",
      "keiko: jira-issue-template",
      "version: 1",
      "project: SYN",
      "issueType: Story",
      "activateOn: [create]",
      "summaryMinLength: 4",
      "---",
      "# Story",
    ].join("\n"),
  );
  if (!parsed.ok) throw new TypeError("Expected a parseable template");
  return parsed.template;
};
it.each([
  [
    "create",
    "jira.create",
    {
      projectId: "10000",
      issueTypeId: "10001",
      fields: {
        summary: "A story in an epic",
        customfield_10000: "Required",
        customfield_10109: "SYN-9",
      },
    },
  ],
  ["single edit", "jira.edit", { issueKey: "SYN-1", fields: { customfield_10109: "SYN-9" } }],
] as const)("settles a %s as a valid, explained refusal", async (_name, tool, args) => {
  const f = await fixture("epic-link-unknown", undefined, tool, {}, () => ({
    templates: [epicStory()],
    unreadable: 0,
  }));
  const refused = await f.invoke(tool, args);
  expect(refused).toMatchObject({
    kind: "settled",
    result: {
      status: "failed",
      data: {
        outcome: "rejected",
        reason: "field-validation",
        validation: "invalid-epic-link",
        fieldId: "customfield_10109",
      },
    },
  });
  expect(f.writes()).toBe(0);
  expect(JSON.stringify(refused)).toContain("SYN-9 is not an Epic");
});
