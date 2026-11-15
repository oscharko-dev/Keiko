import { describe, expect, it, vi } from "vitest";
import { jiraChatPatchFields, jiraChatUpdateOptions } from "./jiraChatBindingPatch.js";
import {
  jiraChatActorDigest,
  type JiraLivePodCredential,
  type JiraPodAccessDeps,
} from "./jiraPodAccess.js";
import type { Chat } from "../store/index.js";

const POD = "d5f5681e-ce98-4c3c-b27e-51d707c9d018";
const CHAT: Chat = {
  id: "administration-chat",
  projectPath: "/workspace",
  title: "Synthetic",
  selectedModel: "model",
  branchLabel: undefined,
  status: "open",
  connectedScope: undefined,
  localKnowledgeScope: undefined,
  createdAt: 0,
  updatedAt: 0,
  jiraBindingGeneration: 1,
  jiraPodBinding: {
    podId: POD,
    bindingGeneration: 1,
    authenticationGeneration: 1,
    connectedAtMs: 0,
  },
};

function podAccess(): { deps: JiraPodAccessDeps; credential: JiraLivePodCredential } {
  const serverPrincipal = (): string => "synthetic-local-operator";
  const ownerDigest = jiraChatActorDigest({ serverPrincipal });
  if (ownerDigest === undefined) throw new TypeError("Expected local owner");
  const credential: JiraLivePodCredential = {
    schemaVersion: "1",
    authRef: "synthetic-credential-reference",
    displayName: "Synthetic Jira",
    baseUrl: "https://jira.example.invalid",
    createdAt: 0,
    generation: 1,
    provider: "jira",
    deployment: "data-center",
    authScheme: "bearer-pat",
    livePod: {
      podId: POD,
      ownerDigest,
      creationRequestId: POD,
      verificationRevision: 1,
      verificationInProgress: false,
      verificationStatus: "ok",
    },
  };
  return {
    credential,
    deps: {
      serverPrincipal,
      atlassianConnectorCredentials: { custody: { list: () => [credential] } },
    },
  };
}

describe("explicit administration patch admission", () => {
  const identity = `gsi-v1:${"a".repeat(64)}`;

  it.each([true, false])("requires CAS for explicit selection %s", (value) => {
    const denied = vi.fn();
    expect(() =>
      jiraChatPatchFields({ jiraAdministrationEnabled: value }, undefined, denied),
    ).toThrow("current chat scope identity");
    expect(denied).toHaveBeenCalledOnce();
    expect(jiraChatPatchFields({ jiraAdministrationEnabled: value }, identity, denied)).toEqual({
      jiraAdministrationEnabled: value,
    });
  });

  it.each([null, "true", 1, [], {}])("refuses nonboolean selection %j", (value) => {
    const denied = vi.fn();
    expect(() =>
      jiraChatPatchFields({ jiraAdministrationEnabled: value }, identity, denied),
    ).toThrow("administration selection is invalid");
    expect(denied).toHaveBeenCalledOnce();
  });

  it("omission preserves the existing selection rather than granting authority", () => {
    expect(jiraChatPatchFields({}, undefined, () => undefined)).toEqual({});
  });

  it("resolves enabling through the current owned ready credential even without a Pod patch", () => {
    const { deps } = podAccess();
    expect(
      jiraChatUpdateOptions(deps, { jiraAdministrationEnabled: true }, CHAT, "admin-patch"),
    ).toEqual({ verifiedJiraPod: { podId: POD, authenticationGeneration: 1 } });
    expect(
      jiraChatUpdateOptions({}, { jiraAdministrationEnabled: false }, CHAT, "admin-patch"),
    ).toEqual({});
  });

  it.each([
    { verificationStatus: "unverified" as const },
    { verificationInProgress: true },
    { credentialOperation: "replace-token" as const },
    { ownerDigest: "0".repeat(64) },
  ])("refuses enabling with unavailable custody facts %j", (patch) => {
    const { deps, credential } = podAccess();
    const changed: JiraPodAccessDeps = {
      ...deps,
      atlassianConnectorCredentials: {
        custody: { list: () => [{ ...credential, livePod: { ...credential.livePod, ...patch } }] },
      },
    };
    expect(() =>
      jiraChatUpdateOptions(changed, { jiraAdministrationEnabled: true }, CHAT, "admin-patch"),
    ).toThrow("unavailable or requires verification");
  });

  it.each([
    [
      "unsupported-version",
      "Keiko requires Jira Data Center 10.3.0 or later: upgrade Jira or select another Pod.",
    ],
    ["auth-failed", "may have expired or been revoked"],
  ] as const)("names the remedy for a %s Pod before it is selected", (verificationStatus, text) => {
    const { deps, credential } = podAccess();
    const changed: JiraPodAccessDeps = {
      ...deps,
      atlassianConnectorCredentials: {
        custody: {
          list: () => [{ ...credential, livePod: { ...credential.livePod, verificationStatus } }],
        },
      },
    };
    expect(() => jiraChatUpdateOptions(changed, { jiraPodId: POD }, CHAT, "pod-patch")).toThrow(
      text,
    );
  });
});
