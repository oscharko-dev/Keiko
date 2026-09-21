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

// Platform coding-runtime packages (#3577). They share the scope but are not workspaces: each is
// published on its own, carries one platform's OpenCode executable and native helper (~75 MB
// packed), and is selected by npm through its os/cpu fields. They are therefore optional, never
// bundled into the main tarball, and pinned to their own exact version, which moves only when the
// runtime itself changes and not with the product version.
export const platformRuntimePackagePrefix = `${scope}keiko-coding-runtime-`;

export function isPlatformRuntimePackage(name) {
  return typeof name === "string" && name.startsWith(platformRuntimePackagePrefix);
}

/** The root manifest's platform runtime entries, across every dependency field. */
export function platformRuntimeDependencyEntries(manifest) {
  const entries = [];
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = manifest?.[field];
    if (deps === null || typeof deps !== "object" || Array.isArray(deps)) continue;
    for (const [name, specifier] of Object.entries(deps)) {
      if (isPlatformRuntimePackage(name)) entries.push({ field, name, specifier });
    }
  }
  return entries;
}

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
      if (name.startsWith(scope) && !isPlatformRuntimePackage(name)) {
        entries.push({ field, malformed: false, name, specifier });
      }
    }
  }
  return entries;
}
