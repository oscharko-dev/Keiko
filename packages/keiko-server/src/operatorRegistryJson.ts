/**
 * The two shape checks Keiko reads an untrusted JSON document with: the operator's registries
 * (`opencodeOperatorPlugins.ts`, `opencodeRemoteSkills.ts`), an authorization server's metadata
 * (`mcpOAuthIssuer.ts`) and the runtime's credential rows (`opencodeNativeMcpCredentials.ts`). A
 * plain object, and one that carries no key beyond a closed grammar; a document that fails either
 * admits nothing.
 */
export function plainRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

export function onlyKeys(
  record: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}
