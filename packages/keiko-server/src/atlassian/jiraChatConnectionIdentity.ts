import { connectionFingerprint } from "@oscharko-dev/keiko-connectors";
import { currentJiraChatCredential, type JiraChatAuthorityDeps } from "./jiraChatAuthority.js";
import type { JiraLivePodCredential } from "./jiraPodAccess.js";

/**
 * The one definition of a Jira connection's identity inside Chat: the credential and its
 * generation, never the credential itself. Everything that binds work to a connection (the
 * managed connection a tool runs on, the fingerprint a staged draft is stored under) reads it here.
 */
export function jiraConnectionIdentity(
  credential: Pick<JiraLivePodCredential, "authRef" | "generation">,
): string {
  return `${credential.authRef}:${String(credential.generation)}`;
}

/** The fingerprint a draft is stored under and must be resolved under. */
export function jiraChatConnectionFingerprint(
  credential: Pick<JiraLivePodCredential, "baseUrl" | "authRef" | "generation">,
): string {
  return connectionFingerprint({
    baseUrl: credential.baseUrl,
    identity: jiraConnectionIdentity(credential),
  });
}

/** The Chat's connection now, by its Pod binding; undefined when it has no ready Jira Pod. */
export function currentJiraChatConnectionFingerprint(
  deps: JiraChatAuthorityDeps,
  chatId: string,
): string | undefined {
  const credential = currentJiraChatCredential(deps, chatId);
  return credential === undefined ? undefined : jiraChatConnectionFingerprint(credential);
}
