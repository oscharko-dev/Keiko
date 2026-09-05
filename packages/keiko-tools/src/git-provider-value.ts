import {
  gitDeliveryObservationFailure,
  type GitDeliveryObservationFailure,
} from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import {
  classifyGitProviderReadFailure,
  type GitProviderReadRunner,
} from "./git-provider-observation.js";

export type GitProviderValueResult =
  | { readonly status: "observed"; readonly value: unknown }
  | { readonly status: "unavailable"; readonly failure: GitDeliveryObservationFailure };
interface Input {
  readonly run: GitProviderReadRunner;
  readonly argv: readonly string[];
  readonly signal?: AbortSignal;
}
function cancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

// The ONE owner of the GitHub REST read-argv envelope (`gh api --hostname github.com --method GET
// <endpoint> --jq <projection>`) — every governed GET read in this package builds its argv through
// this function so the envelope shape (host pin, method, no --paginate/--input) can never drift
// between call sites (#3384 audit F32).
export function buildGitHubApiGetArgv(endpoint: string, projection: string): readonly string[] {
  return ["api", "--hostname", "github.com", "--method", "GET", endpoint, "--jq", projection];
}

/** Bounded transient JSON projection over the existing governed command result. */
export async function readGitProviderValue(request: Input): Promise<GitProviderValueResult> {
  const input = Object.freeze({ ...request });
  if (cancelled(input.signal))
    return { status: "unavailable", failure: gitDeliveryObservationFailure("cancelled") };
  let result;
  try {
    result = await input.run(Object.freeze([...input.argv]));
  } catch (error) {
    result = error instanceof Error ? error : new Error("Provider read failed");
  }
  if (cancelled(input.signal))
    return { status: "unavailable", failure: gitDeliveryObservationFailure("cancelled") };
  const failure = classifyGitProviderReadFailure(result);
  if (failure !== undefined) return { status: "unavailable", failure };
  if (result instanceof Error)
    return {
      status: "unavailable",
      failure: gitDeliveryObservationFailure("provider-unavailable"),
    };
  if (Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8") > 262_144)
    return { status: "unavailable", failure: gitDeliveryObservationFailure("output-truncated") };
  try {
    return { status: "observed", value: JSON.parse(result.stdout) as unknown };
  } catch {
    return { status: "unavailable", failure: gitDeliveryObservationFailure("malformed-response") };
  }
}
