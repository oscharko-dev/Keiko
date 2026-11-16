import type { AtlassianCredentialMetadata } from "@oscharko-dev/keiko-contracts";

export type JiraLivePod = NonNullable<
  Extract<AtlassianCredentialMetadata, { deployment: "data-center" }>["livePod"]
>;

export interface JiraLivePodBinding {
  readonly authRef: string;
  readonly authenticationGeneration: number;
  readonly verificationRevision: number;
  readonly principalDigest: string;
}

/** Returns the verified live pod the binding still names, or `undefined` once it changed. */
export function boundLivePod(
  metadata: (authRef: string) => AtlassianCredentialMetadata | undefined,
  binding: JiraLivePodBinding,
): JiraLivePod | undefined {
  const credential = metadata(binding.authRef);
  if (
    credential?.deployment !== "data-center" ||
    credential.generation !== binding.authenticationGeneration
  )
    return undefined;
  const pod = credential.livePod;
  if (
    pod?.verificationRevision !== binding.verificationRevision ||
    pod.ownerDigest !== binding.principalDigest ||
    pod.verificationStatus !== "ok" ||
    pod.verificationInProgress ||
    pod.credentialOperation !== undefined
  )
    return undefined;
  return pod;
}
