export const scope = "@oscharko-dev/";

export const explicitPrivateWorkspaceExclusions = new Map([
  [
    "@oscharko-dev/keiko-ui",
    "build-time UI workspace; the root package ships the static UI artifact under dist/ui",
  ],
  [
    "@oscharko-dev/keiko-editor",
    "build-time editor workspace; not part of the root runtime dependency closure",
  ],
]);

export function internalDependencyEntries(manifest) {
  const entries = [];
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = manifest[field];
    if (deps === undefined) continue;
    if (deps === null || typeof deps !== "object" || Array.isArray(deps)) {
      entries.push({
        field,
        malformed: true,
        name: undefined,
        specifier: undefined,
      });
      continue;
    }
    for (const [name, specifier] of Object.entries(deps)) {
      if (name.startsWith(scope)) {
        entries.push({ field, malformed: false, name, specifier });
      }
    }
  }
  return entries;
}
