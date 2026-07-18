// Issue #2489 (Finding 8) — EDITOR_AGENT_SCHEMA_VERSION and EDITOR_VERIFICATION_SCHEMA_VERSION are
// deliberately two independent "ladders" (docs/keiko-editor/2088-foundation-wave-audit.md,
// Deliberate exclusions), but they must not silently drift apart while both are pinned at "1".
// Pure (no file I/O) so check-contract-boundaries.mjs's schema-version check is directly
// unit-testable with plain source strings, unlike the rest of that CLI script, which is exercised
// only via subprocess (spawnSync never contributes coverage to the parent test process).
export function schemaVersionLiteral(source, constantName) {
  const match = new RegExp(`export const ${constantName} = "([^"]+)" as const;`).exec(source);
  return match === null ? undefined : match[1];
}

export function schemaVersionLockstepFailures(agentSource, verificationSource) {
  const failures = [];
  const agentVersion = schemaVersionLiteral(agentSource, "EDITOR_AGENT_SCHEMA_VERSION");
  if (agentVersion === undefined) {
    failures.push(
      "packages/keiko-contracts/src/editor-agent.ts: could not find EDITOR_AGENT_SCHEMA_VERSION " +
        "to check schema-version lockstep.",
    );
  }
  const verificationVersion = schemaVersionLiteral(
    verificationSource,
    "EDITOR_VERIFICATION_SCHEMA_VERSION",
  );
  if (verificationVersion === undefined) {
    failures.push(
      "packages/keiko-contracts/src/editor-verification.ts: could not find " +
        "EDITOR_VERIFICATION_SCHEMA_VERSION to check schema-version lockstep.",
    );
  }
  if (
    agentVersion !== undefined &&
    verificationVersion !== undefined &&
    agentVersion !== verificationVersion
  ) {
    failures.push(
      `EDITOR_AGENT_SCHEMA_VERSION ("${agentVersion}") and ` +
        `EDITOR_VERIFICATION_SCHEMA_VERSION ("${verificationVersion}") have drifted out ` +
        "of lockstep.",
    );
  }
  return failures;
}
