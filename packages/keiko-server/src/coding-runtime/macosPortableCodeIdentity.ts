const TEAM_IDENTIFIER = /^[A-Z0-9]{10}$/u;
const TEAM_IDENTIFIER_LINE = /^TeamIdentifier=([A-Z0-9]{10})$/gmu;
const MACOS_RELEASE_TEAM_IDENTIFIER = "__KEIKO_APPLE_TEAM_ID__";

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
  const identifier = bundleIdentifier === undefined ? "" : ` and identifier "${bundleIdentifier}"`;
  return (
    `anchor apple generic${identifier}` + ` and certificate leaf[subject.OU] = "${teamIdentifier}"`
  );
}
