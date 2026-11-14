import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";

// #4357: a person must be able to confirm which Jira they are connected to. The answer is the address
// they typed when they created the Pod, taken from the connection Keiko already holds: hostname and
// port only, never the scheme, user information, path, query or fragment, and no request is made.
const HOST_MAX_CHARS = 255;

/** The host of a connection's base URL as the person knows it, or nothing when it cannot be stated. */
export function jiraConnectionHost(baseUrl: string): string | undefined {
  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    return undefined;
  }
  return host.length > 0 && host.length <= HOST_MAX_CHARS ? host : undefined;
}

/** A successful read of the connected account also names the Jira it was read from. */
export async function withConnectionInstance(
  pending: Promise<ManagedMcpToolResult>,
  baseUrl: string,
): Promise<ManagedMcpToolResult> {
  const result = await pending;
  const host = jiraConnectionHost(baseUrl);
  if (host === undefined || result.isError === true || result.data.outcome !== "succeeded")
    return result;
  return { ...result, data: { ...result.data, instance: { host } } };
}
