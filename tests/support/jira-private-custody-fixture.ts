import { createAtlassianCredentialCustody, type AtlassianCredentialMetadata, type AtlassianCredentialVaultPort,
  type CreatedAtlassianCredentialCustody } from "../../packages/keiko-connectors/src/atlassian-credential-custody.js";
import type { JiraHumanInputBinding } from "../../packages/keiko-connectors/src/jira-human-input-values.js";
import type { JiraDataCenterCompatibilityFacts } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";

type PrivateFixtureVault = {
  -readonly [Key in keyof AtlassianCredentialVaultPort]-?: NonNullable<AtlassianCredentialVaultPort[Key]>;
};
export interface PrivateJiraCustodyFixture extends CreatedAtlassianCredentialCustody {
  readonly inputs: NonNullable<CreatedAtlassianCredentialCustody["custody"]["humanInputs"]>;
  readonly privateInputs: NonNullable<CreatedAtlassianCredentialCustody["executionResolver"]["humanInputs"]>;
  readonly sessions: NonNullable<CreatedAtlassianCredentialCustody["executionResolver"]["sessions"]>;
  readonly binding: JiraHumanInputBinding;
  readonly sealedPortEntries: Map<string, string>;
  readonly vault: PrivateFixtureVault;
  readonly fork: () => CreatedAtlassianCredentialCustody;
  readonly clearedPhases: ("cancelled" | "expired")[];
  readonly advance: (milliseconds: number) => void;
}

/** Private synthetic custody over one shared port; production kernel guards have separate sources. */
export function privateJiraCustodyFixture(operation: JiraHumanInputBinding["operation"] = "jira.update-my-password", principal = "a".repeat(64), options: {
  readonly baseUrl?: string; readonly actorKey?: string; readonly actorUsername?: string;
  readonly compatibility?: JiraDataCenterCompatibilityFacts;
} = {}): PrivateJiraCustodyFixture {
  let now = 1_800_000_000_000;
  const clearedPhases: ("cancelled" | "expired")[] = [];
  const entries = new Map<string, string>(); const leases = new Set<string>();
  const metadata = new Map<string, AtlassianCredentialMetadata>();
  const vault = {
    list: () => [...entries.keys()],
    get: (id: string) => entries.get(id), set: (id: string, value: string) => { entries.set(id, value); }, delete: (id: string) => { entries.delete(id); },
    compareAndSet: (id: string, expected: string | undefined, next: string | undefined) => {
      if (entries.get(id) !== expected) return false;
      if (next === undefined) entries.delete(id); else entries.set(id, next); return true;
    },
    acquireLease: (id: string, scope = "record") => {
      const key = `${scope}:${id}`;
      if (leases.has(key)) return undefined; leases.add(key); let held = true;
      return () => { if (held) { held = false; leases.delete(key); } };
    },
  };
  const metadataStore = { get: (id: string) => metadata.get(id), list: () => [...metadata.values()], insert: (value: AtlassianCredentialMetadata) => { metadata.set(value.authRef, value); }, delete: (id: string) => metadata.delete(id) };
  const fork = () => createAtlassianCredentialCustody({ now: () => now, vault, metadataStore,
    onHumanInputCleared: (_correlationId, phase) => { clearedPhases.push(phase); } });
  const { custody, executionResolver } = fork();
  const created = custody.create({ provider: "jira", deployment: "data-center", displayName: "Synthetic Jira", baseUrl: options.baseUrl ?? "https://jira.example.invalid/context",
    authScheme: "bearer-pat", apiToken: ["synthetic", "private", "pat"].join("-"), livePodCreationRequestId: "7765d9e4-fc9a-46d5-aea4-24880fec5e1e" }, principal);
  const verification = custody.beginVerification(created.authRef, 1);
  if (verification === undefined || created.deployment !== "data-center" || created.livePod === undefined) throw new TypeError("Missing synthetic Pod verification");
  custody.finishVerification(created.authRef, 1, verification.revision, "ok", undefined, options.compatibility);
  const inputs = custody.humanInputs; const privateInputs = executionResolver.humanInputs; const sessions = executionResolver.sessions;
  if (inputs === undefined || privateInputs === undefined || sessions === undefined) throw new TypeError("Missing real private custody facets");
  const binding: JiraHumanInputBinding = { context: { kind: "chat", chatId: "chat-1", messageId: "message-1", callId: "call-1", podId: created.livePod.podId, bindingGeneration: 1 },
    authority: { runId: "authority-run-1", envelopeDigest: "d".repeat(64) }, principalDigest: principal,
    authRef: created.authRef, authenticationGeneration: 1, verificationRevision: verification.revision, operation,
    argumentsDigest: "b".repeat(64), actorUserKey: options.actorKey ?? "actor-key", actorUsername: options.actorUsername ?? "Native Actor", expiresAt: now + 60_000 };
  return { custody, executionResolver, inputs, privateInputs, sessions, binding, sealedPortEntries: entries, vault, fork, clearedPhases, advance: (milliseconds: number) => { now += milliseconds; } };
}
