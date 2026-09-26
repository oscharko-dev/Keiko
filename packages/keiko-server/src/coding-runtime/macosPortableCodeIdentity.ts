const TEAM_IDENTIFIER = /^[A-Z0-9]{10}$/u;
const TEAM_IDENTIFIER_LINE = /^TeamIdentifier=([A-Z0-9]{10})$/gmu;
const MACOS_RELEASE_TEAM_IDENTIFIER = "__KEIKO_APPLE_TEAM_ID__";
// KEIKO-0788: a safe bundle-identifier charset. Apple's canonical bundle-id form is
// reverse-DNS -- letters, digits, dots, hyphens. Any character outside that (quote, backslash,
// whitespace, control byte) would be interpolated into the codesign --requirement expression
// unsanitized, so an untrusted or malformed bundleIdentifier could close the surrounding
// double-quoted identifier and inject arbitrary requirement text. Fail closed with the same
// TypeError shape the team-identifier check throws.
const BUNDLE_IDENTIFIER = /^[A-Za-z0-9.-]+$/u;

export function isMacosBundleIdentifier(value: string): boolean {
  return BUNDLE_IDENTIFIER.test(value);
}

export function isMacosTeamIdentifier(value: string): boolean {
  return TEAM_IDENTIFIER.test(value);
}

export function macosReleaseTeamIdentifier(): string | undefined {
  return isMacosTeamIdentifier(MACOS_RELEASE_TEAM_IDENTIFIER)
    ? MACOS_RELEASE_TEAM_IDENTIFIER
    : undefined;
}

export function macosTeamIdentifierFromOutput(output: string): string | undefined {
  const matches = [...output.matchAll(TEAM_IDENTIFIER_LINE)];
  if (matches.length !== 1) return undefined;
  const identifier = matches[0]?.[1];
  return identifier !== undefined && isMacosTeamIdentifier(identifier) ? identifier : undefined;
}

export function macosDeveloperIdRequirement(
  teamIdentifier: string,
  bundleIdentifier?: string,
): string {
  if (!isMacosTeamIdentifier(teamIdentifier)) {
    throw new TypeError("macOS team identifier is invalid");
  }
  // KEIKO-0788: reject any bundleIdentifier containing a character outside the safe reverse-DNS
  // charset BEFORE interpolating it into the double-quoted requirement string. A quote or
  // backslash would close the surrounding identifier and inject arbitrary requirement text.
  if (bundleIdentifier !== undefined && !isMacosBundleIdentifier(bundleIdentifier)) {
    throw new TypeError("macOS bundle identifier is invalid");
  }
  const identifier = bundleIdentifier === undefined ? "" : ` and identifier "${bundleIdentifier}"`;
  return (
    `anchor apple generic${identifier}` + ` and certificate leaf[subject.OU] = "${teamIdentifier}"`
  );
}
