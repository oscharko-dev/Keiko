import { settleSync } from "./jira-fixture-settle.js";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import {
  jiraSessionBindingForInput,
  type JiraHumanInputSelection,
  type JiraHumanInputBinding,
  type JiraManagedConnection,
  type AtlassianCredentialMetadata,
  type AtlassianHttpBodyPort,
} from "@oscharko-dev/keiko-connectors";
import {
  JIRA_HUMAN_INPUT_PURPOSES,
  JIRA_HUMAN_INPUT_FIELD_SETS,
  type JiraHumanInputPurpose,
  type JiraDataCenterCompatibilityFacts,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { createInMemoryUiStore } from "../../packages/keiko-server/src/store/index.js";
import { buildRedactor } from "../../packages/keiko-server/src/deps.js";
import { jiraChatAvatarComposition } from "../../packages/keiko-server/src/atlassian/jiraAvatarComposition.js";
import type { JiraChatAttachmentDeps } from "../../packages/keiko-server/src/atlassian/jiraChatAttachment.js";
import {
  createGatewayAtlassianHttpBodyPort,
  type CreateAtlassianHttpPortOptions,
} from "../../packages/keiko-server/src/atlassian/httpPort.js";
import { createJiraPrivatePorts } from "../../packages/keiko-server/src/atlassian/httpPrivateIdentity.js";
import type { AtlassianHttpLifecycleOptions } from "../../packages/keiko-server/src/atlassian/httpRequestLifecycle.js";
import { privateJiraCustodyFixture } from "./jira-private-custody-fixture.js";
import { AVATAR_MUTATION_FIXTURE_CASES } from "./jira-avatar-mutation-fixture.js";
import {
  PRIVATE_NATIVE_ACTOR as ACTOR,
  PRIVATE_NATIVE_IMAGE,
  PRIVATE_NATIVE_COOKIE,
  PRIVATE_NATIVE_TEMP,
  PRIVATE_NATIVE_PASSWORD,
  PRIVATE_NATIVE_LICENSE,
  privateNativeCase,
} from "./jira-private-native-cases.js";

interface ConnectedChat {
  readonly store: JiraChatAttachmentDeps["store"];
  readonly chatId: string;
}
type CurrentBinding = Pick<JiraHumanInputBinding, "context" | "authority">;
type PrivatePorts = Pick<JiraManagedConnection, "privateIdentity" | "avatars">;
interface Controls {
  sessionAvailable: boolean;
  sourceAvailable: boolean;
  inputAvailable: boolean;
}
interface Composition {
  readonly metadata: AtlassianCredentialMetadata;
  readonly controls: Controls;
  readonly ports: (
    context: ManagedMcpInvocationContext,
    args: CatalogJsonObject,
    lifecycle?: AtlassianHttpLifecycleOptions,
    current?: CurrentBinding,
  ) => Promise<PrivatePorts>;
  readonly http: (lifecycle?: AtlassianHttpLifecycleOptions) => AtlassianHttpBodyPort;
  readonly close: () => void;
}
interface Files {
  readonly deps: JiraChatAttachmentDeps;
  readonly chatId: string;
  readonly close: () => void;
}
interface PrivateFixture {
  readonly state: ReturnType<typeof privateJiraCustodyFixture>;
  readonly tool: string;
  readonly purpose: JiraHumanInputPurpose | undefined;
  readonly options: CreateAtlassianHttpPortOptions;
  readonly controls: Controls;
  readonly files: Files;
}
function connectedFiles(connected: ConnectedChat | undefined): Files {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-native-private-corpus-")));
  mkdirSync(join(root, "images"));
  writeFileSync(join(root, "images/avatar.png"), PRIVATE_NATIVE_IMAGE);
  const store = connected?.store ?? createInMemoryUiStore();
  store.createProject(root);
  const chatId = connected?.chatId ?? store.createChat(root, "Synthetic native image", "model").id;
  store.updateChat(chatId, {
    connectedScopes: [{ kind: "workspace-root", root, relativePaths: [], connectedAtMs: 1 }],
  });
  const deps: JiraChatAttachmentDeps = {
    store,
    redactor: buildRedactor({}),
    managedTaskWorkspaceRoot: undefined,
    env: {},
    config: undefined,
    gatewayConfig: undefined,
    egress: undefined,
  };
  return {
    deps,
    chatId,
    close: (): void => {
      if (connected === undefined) store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function avatarFiles(
  fixture: PrivateFixture,
  context: ManagedMcpInvocationContext,
): JiraManagedConnection["avatars"] {
  const composition = jiraChatAvatarComposition(fixture.files.deps, {
    chatId: fixture.files.chatId,
    correlationId: context.correlationId,
    signal: context.signal,
    review: () => ({ required: false }),
  });
  return fixture.controls.sourceAvailable
    ? composition
    : { inspectImage: composition.inspectImage };
}
function bindingFor(
  fixture: PrivateFixture,
  context: ManagedMcpInvocationContext,
  args: CatalogJsonObject,
  current: CurrentBinding | undefined,
): JiraHumanInputBinding {
  const state = fixture.state;
  const originalContext = state.binding.context;
  if (originalContext.kind !== "chat") throw new TypeError("Expected Chat fixture binding");
  return {
    ...state.binding,
    context: current?.context ?? {
      ...originalContext,
      chatId: fixture.files.chatId,
      callId: context.invocationId,
    },
    authority: current?.authority ?? state.binding.authority,
    argumentsDigest: sha256Hex(canonicalise(args)),
  };
}
async function seedSession(
  fixture: PrivateFixture,
  scope: ReturnType<typeof jiraSessionBindingForInput>,
): Promise<void> {
  const avatar = AVATAR_MUTATION_FIXTURE_CASES.find((row) => row.name === fixture.tool);
  const sessionRequired =
    avatar?.method === "POST" ||
    fixture.tool === "jira.logout" ||
    fixture.tool === "jira.release-websudo";
  if (sessionRequired && fixture.controls.sessionAvailable)
    await fixture.state.sessions.withLease(scope, (session) =>
      settleSync(() => {
        session.establish(PRIVATE_NATIVE_COOKIE);
        if (avatar !== undefined && !("upload" in avatar))
          session.rememberTemporary({
            actorKey: ACTOR.key,
            target: avatar.target,
            ...PRIVATE_NATIVE_TEMP,
          });
      }),
    );
}
function inputSelection(
  fixture: PrivateFixture,
  binding: JiraHumanInputBinding,
): JiraHumanInputSelection | undefined {
  const { state, purpose, controls } = fixture;
  if (purpose === undefined || !controls.inputAvailable) return undefined;
  const pending = state.inputs.prepare(binding);
  const fields = JIRA_HUMAN_INPUT_FIELD_SETS[purpose];
  const values: Record<string, string> = {};
  for (const field of [...fields.required, ...fields.optional])
    values[field] =
      field === "license"
        ? PRIVATE_NATIVE_LICENSE
        : field === "ownerShutdownConfirmation"
          ? "confirmed"
          : PRIVATE_NATIVE_PASSWORD;
  const ready = state.inputs.submit(pending.requestId, binding, pending.revision, values);
  return { requestId: ready.requestId, revision: ready.revision, binding };
}
function releaseOfVersion(version: readonly number[] | undefined): "10.3" | "10.4" | undefined {
  if (version?.[0] !== 10) return undefined;
  return version[1] === 3 ? "10.3" : version[1] === 4 ? "10.4" : undefined;
}
function observedLegacyRelease(fixture: PrivateFixture): "10.3" | "10.4" | undefined {
  const { binding, custody } = fixture.state;
  const metadata = custody.getMetadata(binding.authRef);
  if (
    metadata?.deployment !== "data-center" ||
    metadata.generation !== binding.authenticationGeneration
  )
    return undefined;
  const pod = metadata.livePod;
  if (pod?.verificationStatus !== "ok" || pod.verificationRevision !== binding.verificationRevision)
    return undefined;
  return releaseOfVersion(pod.compatibility?.versionNumbers);
}
function legacyCompatibility(tool: string): JiraDataCenterCompatibilityFacts | undefined {
  // Literal native fixture choices, independent of registry declarations or result projections.
  if (tool === "jira.upload-temporary-avatar")
    return {
      schemaVersion: 1,
      deploymentType: "Data Center",
      versionNumbers: [10, 3, 26],
      restApi: "v2",
      agileApi: "unverified",
    };
  if (tool === "jira.crop-temporary-avatar")
    return {
      schemaVersion: 1,
      deploymentType: "Data Center",
      versionNumbers: [10, 4, 0],
      restApi: "v2",
      agileApi: "unverified",
    };
  return undefined;
}
async function ports(
  fixture: PrivateFixture,
  context: ManagedMcpInvocationContext,
  args: CatalogJsonObject,
  lifecycle: AtlassianHttpLifecycleOptions = {},
  current?: CurrentBinding,
): Promise<PrivatePorts> {
  const binding = bindingFor(fixture, context, args, current);
  const scope = jiraSessionBindingForInput(binding);
  await seedSession(fixture, scope);
  const selection = inputSelection(fixture, binding);
  const legacyTemporaryRelease = observedLegacyRelease(fixture);
  const privatePorts = createJiraPrivatePorts(
    { ...fixture.options, ...lifecycle },
    { ...fixture.options, ...lifecycle },
    context,
    {
      ...(selection === undefined ? {} : { selection }),
      sessionScope: scope,
      ...(legacyTemporaryRelease === undefined ? {} : { legacyTemporaryRelease }),
    },
  );
  return {
    privateIdentity: privatePorts.identity,
    avatars: {
      ...avatarFiles(fixture, context),
      withSession: privatePorts.withAvatarSession,
      ...(privatePorts.legacyTemporaryRelease === undefined
        ? {}
        : { legacyTemporaryRelease: privatePorts.legacyTemporaryRelease }),
    },
  };
}
/** Real custody, HTTP/session ports and connected-file/image admission. Only the native server
 * and the Vault storage port are synthetic; no capability callback supplies an allowed result. */
export function privateNativeComposition(
  tool: string | undefined,
  baseUrl: string,
  fetchImpl: typeof fetch,
  activityLog?: ServerLogSink,
  connected?: ConnectedChat,
): Composition | undefined {
  const selected = privateNativeCase(tool);
  if (selected === undefined) return undefined;
  const purpose = JIRA_HUMAN_INPUT_PURPOSES.find((value) => selected.tool === `jira.${value}`);
  const compatibility = legacyCompatibility(selected.tool);
  const state = privateJiraCustodyFixture(
    purpose === undefined ? "jira.login" : `jira.${purpose}`,
    "a".repeat(64),
    {
      baseUrl,
      actorKey: ACTOR.key,
      actorUsername: ACTOR.name,
      ...(compatibility === undefined ? {} : { compatibility }),
    },
  );
  const metadata = state.custody.getMetadata(state.binding.authRef);
  if (metadata === undefined) throw new TypeError("Missing actual fixture credential metadata");
  const options = {
    baseUrl,
    authRef: metadata.authRef,
    credentials: state.executionResolver,
    fetchImpl,
    activityLog,
  };
  const files = connectedFiles(connected);
  const controls = { sessionAvailable: true, sourceAvailable: true, inputAvailable: true };
  const fixture: PrivateFixture = { state, tool: selected.tool, purpose, options, controls, files };
  return {
    metadata,
    controls,
    ports: (context, args, lifecycle, current) => ports(fixture, context, args, lifecycle, current),
    http: (lifecycle: AtlassianHttpLifecycleOptions = {}) =>
      createGatewayAtlassianHttpBodyPort({ ...options, ...lifecycle }),
    close: files.close,
  };
}
