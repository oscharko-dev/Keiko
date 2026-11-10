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

/**
 * Keiko portable target -> the npm `os`/`cpu` pair and package suffix npm selects a host by. The
 * one list of platform runtime packages: the builder names its packages from it, and the publish
 * gate requires the main package to declare every one of them, because a missing entry would
 * silently take the coding runtime away from every npm installation on that platform.
 */
export const platformRuntimePackages = Object.freeze({
  "macos-arm64": Object.freeze({ cpu: "arm64", os: "darwin", suffix: "darwin-arm64" }),
  "macos-x64": Object.freeze({ cpu: "x64", os: "darwin", suffix: "darwin-x64" }),
  // #4068: built and approved, but never published. The main package can declare it only once its
  // first version exists on the registry (its lockfile must resolve it), so it is listed here as
  // pending; the first publication removes the flag and adds the optionalDependency together.
  "windows-x64": Object.freeze({
    cpu: "x64",
    os: "win32",
    suffix: "win32-x64",
    firstPublication: "pending",
  }),
});

export function platformRuntimePackageName(target) {
  const entry = platformRuntimePackages[target];
  if (entry === undefined) throw new TypeError(`unsupported npm runtime package target: ${target}`);
  return `${platformRuntimePackagePrefix}${entry.suffix}`;
}

export const requiredPlatformRuntimePackageNames = Object.freeze(
  Object.keys(platformRuntimePackages)
    .filter((target) => platformRuntimePackages[target].firstPublication !== "pending")
    .map(platformRuntimePackageName),
);

/** Approved packages whose first version is not yet on the registry; the main package omits them. */
export const pendingPlatformRuntimePackageNames = Object.freeze(
  Object.keys(platformRuntimePackages)
    .filter((target) => platformRuntimePackages[target].firstPublication === "pending")
    .map(platformRuntimePackageName),
);

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
