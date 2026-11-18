// Git's null-delimited configuration output preserves empty resets and helper order. Only the
// direct protected system/global scopes are trusted here. In particular, an include pointing into
// a downloaded repository must never promote that repository's helper to executable authority.
export const HOST_CREDENTIAL_CONFIG_QUERY: readonly string[] = [
  "config",
  "--null",
  "--show-scope",
  "--no-includes",
  "--get-regexp",
  String.raw`^credential(\..*)?\.helper$`,
];

const HOST_SCOPES: ReadonlySet<string> = new Set(["system", "global"]);
const HELPER_KEY = /^credential(?:\.[^\r\n\0=]+)?\.helper$/u;
const MAX_HELPER_ENTRIES = 128;

function hostHelperArgument(entry: string): string | undefined {
  const separator = entry.indexOf("\n");
  const key = entry.slice(0, separator);
  if (separator < 0 || !HELPER_KEY.test(key)) return undefined;
  return `${key}=${entry.slice(separator + 1)}`;
}

export function hostCredentialConfigArgs(listing: string): readonly string[] | undefined {
  if (listing === "") return [];
  const fields = listing.split("\0");
  if (fields.pop() !== "" || fields.length % 2 !== 0) return undefined;
  if (fields.length > MAX_HELPER_ENTRIES * 2) return undefined;
  const args: string[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const scope = fields[index] ?? "";
    if (!HOST_SCOPES.has(scope)) continue;
    const entry = fields[index + 1] ?? "";
    const argument = hostHelperArgument(entry);
    if (argument === undefined) return undefined;
    // This is one argv value; its contents cannot add an option or change the fixed key. Git, not
    // Keiko, interprets the account owner's helper syntax and credential-URL matching.
    args.push("-c", argument);
  }
  return args;
}
