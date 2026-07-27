const TEAM_IDENTIFIER = /^[A-Z0-9]{10}$/u;
const TEAM_IDENTIFIER_LINE = /^TeamIdentifier=([A-Z0-9]{10})$/gmu;
const MACOS_RELEASE_TEAM_IDENTIFIER = "__KEIKO_APPLE_TEAM_ID__";

export function macosReleaseTeamIdentifier(): string | undefined {
  return TEAM_IDENTIFIER.test(MACOS_RELEASE_TEAM_IDENTIFIER)
    ? MACOS_RELEASE_TEAM_IDENTIFIER
    : undefined;
}

export function macosTeamIdentifierFromOutput(output: string): string | undefined {
  const matches = [...output.matchAll(TEAM_IDENTIFIER_LINE)];
  if (matches.length !== 1) return undefined;
  const identifier = matches[0]?.[1];
  return identifier !== undefined && TEAM_IDENTIFIER.test(identifier) ? identifier : undefined;
}

export function macosDeveloperIdRequirement(
  teamIdentifier: string,
  bundleIdentifier?: string,
): string {
  if (!TEAM_IDENTIFIER.test(teamIdentifier)) {
    throw new TypeError("macOS team identifier is invalid");
  }
  const identifier = bundleIdentifier === undefined ? "" : ` and identifier "${bundleIdentifier}"`;
  return (
    `anchor apple generic${identifier}` + ` and certificate leaf[subject.OU] = "${teamIdentifier}"`
  );
}
