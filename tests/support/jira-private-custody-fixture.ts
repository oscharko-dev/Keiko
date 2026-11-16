import {
  createAtlassianCredentialCustody,
  type AtlassianCredentialMetadata,
  type AtlassianCredentialVaultPort,
  type CreatedAtlassianCredentialCustody,
} from "../../packages/keiko-connectors/src/atlassian-credential-custody.js";
import type { JiraHumanInputBinding } from "../../packages/keiko-connectors/src/jira-human-input-values.js";
import type { JiraDataCenterCompatibilityFacts } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";

type PrivateFixtureVault = {
  -readonly [Key in keyof AtlassianCredentialVaultPort]-?: NonNullable<
    AtlassianCredentialVaultPort[Key]
  >;
};
export interface PrivateJiraCustodyFixture extends CreatedAtlassianCredentialCustody {
  readonly inputs: NonNullable<CreatedAtlassianCredentialCustody["custody"]["humanInputs"]>;
  readonly privateInputs: NonNullable<
    CreatedAtlassianCredentialCustody["executionResolver"]["humanInputs"]
  >;
  readonly sessions: NonNullable<
    CreatedAtlassianCredentialCustody["executionResolver"]["sessions"]
  >;
  readonly binding: JiraHumanInputBinding;
  readonly sealedPortEntries: Map<string, string>;
  readonly vault: PrivateFixtureVault;
  readonly fork: () => CreatedAtlassianCredentialCustody;
  readonly clearedPhases: ("cancelled" | "expired")[];
  readonly advance: (milliseconds: number) => void;
}

interface CustodyOptions {
  readonly baseUrl?: string;
  readonly actorKey?: string;
  readonly actorUsername?: string;
  readonly compatibility?: JiraDataCenterCompatibilityFacts;
}
type CustodyMetadataStore = Parameters<typeof createAtlassianCredentialCustody>[0]["metadataStore"];
function acquireCustodyLease(
  leases: Set<string>,
  id: string,
  scope = "record",
): (() => void) | undefined {
  const key = `${scope}:${id}`;
  if (leases.has(key)) return undefined;
  leases.add(key);
  let held = true;
  return (): void => {
    if (held) {
      held = false;
      leases.delete(key);
    }
  };
}
function custodyVault(entries: Map<string, string>): PrivateFixtureVault {
  const leases = new Set<string>();
  return {
    list: (): string[] => [...entries.keys()],
    get: (id: string): string | undefined => entries.get(id),
    set: (id: string, value: string): void => {
      entries.set(id, value);
    },
    delete: (id: string): void => {
      entries.delete(id);
    },
    compareAndSet: (
      id: string,
      expected: string | undefined,
      next: string | undefined,
    ): boolean => {
      if (entries.get(id) !== expected) return false;
      if (next === undefined) entries.delete(id);
      else entries.set(id, next);
      return true;
    },
    acquireLease: (id: string, scope?: string) => acquireCustodyLease(leases, id, scope),
  };
}
function custodyMetadataStore(
  metadata: Map<string, AtlassianCredentialMetadata>,
): CustodyMetadataStore {
  return {
    get: (id: string): AtlassianCredentialMetadata | undefined => metadata.get(id),
    list: (): AtlassianCredentialMetadata[] => [...metadata.values()],
    insert: (value: AtlassianCredentialMetadata): void => {
      metadata.set(value.authRef, value);
    },
    delete: (id: string): boolean => metadata.delete(id),
  };
}
function verifiedCustodyPod(
  { custody }: CreatedAtlassianCredentialCustody,
  principal: string,
  options: CustodyOptions,
): { authRef: string; podId: string; revision: number } {
  const created = custody.create(
    {
      provider: "jira",
      deployment: "data-center",
      displayName: "Synthetic Jira",
      baseUrl: options.baseUrl ?? "https://jira.example.invalid/context",
      authScheme: "bearer-pat",
      apiToken: ["synthetic", "private", "pat"].join("-"),
      livePodCreationRequestId: "7765d9e4-fc9a-46d5-aea4-24880fec5e1e",
    },
    principal,
  );
  const verification = custody.beginVerification(created.authRef, 1);
  if (
    verification === undefined ||
    created.deployment !== "data-center" ||
    created.livePod === undefined
  )
    throw new TypeError("Missing synthetic Pod verification");
  custody.finishVerification(
    created.authRef,
    1,
    verification.revision,
    "ok",
    undefined,
    options.compatibility,
  );
  return {
    authRef: created.authRef,
    podId: created.livePod.podId,
    revision: verification.revision,
  };
}
function custodyBinding(input: {
  readonly operation: JiraHumanInputBinding["operation"];
  readonly principal: string;
  readonly options: CustodyOptions;
  readonly pod: { authRef: string; podId: string; revision: number };
  readonly expiresAt: number;
}): JiraHumanInputBinding {
  const { operation, principal, options, pod, expiresAt } = input;
  return {
    context: {
      kind: "chat",
      chatId: "chat-1",
      messageId: "message-1",
      callId: "call-1",
      podId: pod.podId,
      bindingGeneration: 1,
    },
    authority: { runId: "authority-run-1", envelopeDigest: "d".repeat(64) },
    principalDigest: principal,
    authRef: pod.authRef,
    authenticationGeneration: 1,
    verificationRevision: pod.revision,
    operation,
    argumentsDigest: "b".repeat(64),
    actorUserKey: options.actorKey ?? "actor-key",
    actorUsername: options.actorUsername ?? "Native Actor",
    expiresAt,
  };
}
/** Private synthetic custody over one shared port; production kernel guards have separate sources. */
export function privateJiraCustodyFixture(
  operation: JiraHumanInputBinding["operation"] = "jira.update-my-password",
  principal = "a".repeat(64),
  options: CustodyOptions = {},
): PrivateJiraCustodyFixture {
  let now = 1_800_000_000_000;
  const clearedPhases: ("cancelled" | "expired")[] = [];
  const entries = new Map<string, string>();
  const vault = custodyVault(entries);
  const metadataStore = custodyMetadataStore(new Map<string, AtlassianCredentialMetadata>());
  const fork = (): CreatedAtlassianCredentialCustody =>
    createAtlassianCredentialCustody({
      now: () => now,
      vault,
      metadataStore,
      onHumanInputCleared: (_correlationId, phase) => {
        clearedPhases.push(phase);
      },
    });
  const forked = fork();
  const { custody, executionResolver } = forked;
  const pod = verifiedCustodyPod(forked, principal, options);
  const inputs = custody.humanInputs;
  const privateInputs = executionResolver.humanInputs;
  const sessions = executionResolver.sessions;
  if (inputs === undefined || privateInputs === undefined || sessions === undefined)
    throw new TypeError("Missing real private custody facets");
  const binding = custodyBinding({ operation, principal, options, pod, expiresAt: now + 60_000 });
  return {
    custody,
    executionResolver,
    inputs,
    privateInputs,
    sessions,
    binding,
    sealedPortEntries: entries,
    vault,
    fork,
    clearedPhases,
    advance: (milliseconds: number): void => {
      now += milliseconds;
    },
  };
}
