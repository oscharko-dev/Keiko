// What an install for the native runtime's own shell on this host refuses before npm runs (#4522),
// beyond the governed verifier's own refusals (ADR-0043 D17). The shell runs the project's check
// itself with whatever tree the install leaves, so an install that could only leave an incomplete
// tree, or one its lockfile does not describe, is refused with its own closed reason instead:
//
// - `install-scripts-required`: the project's own manifest, or a workspace member's, names an
//   install lifecycle script (`preinstall`, `install`, `postinstall`), or the package holds a
//   `binding.gyp`, for which npm runs `node-gyp rebuild` as its install script unless the manifest
//   sets `gypfile: false`. The install never runs one (`--ignore-scripts`), so a fresh tree would
//   lack what that script produces. `prepare` is not one: it readies a package for publishing or
//   hooks, not its installed dependencies. A tree this process installed earlier is refreshed
//   without this refusal; a tree it did not install is never touched at all (`dependencies.ts`).
//   The install scripts of the project's dependencies are not refused: many packages declare one
//   they work without (esbuild checks its binary), and refusing them would refuse most projects. A
//   dependency that needs its script is left incomplete, its check then fails in the shell, and
//   nothing is reported as verified (ADR-0043 D17).
// - `lockfile-mismatch`: a lockfile no longer records what a manifest declares. npm would then
//   resolve those dependencies afresh, and the check would run against a tree the project's
//   lockfile does not describe; `npm ci` refuses the same state. The root's own entry and every
//   member entry the lockfile holds are compared section by section.
//
// Pure: the caller reads and parses every file within its own caps.

export type HostShellRefusal = "install-scripts-required" | "lockfile-mismatch";

const INSTALL_LIFECYCLE_SCRIPTS: readonly string[] = ["preinstall", "install", "postinstall"];
// The manifest sections npm records on a package's own lockfile entry.
const RECORDED_SECTIONS: readonly string[] = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

export interface HostShellProject {
  /** Each package of the project by its lockfile location: "" for the root, "packages/a" for a member. */
  readonly manifests: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
  /** The parsed root lockfile, when one is present (its readability was checked before). */
  readonly lockfile: Readonly<Record<string, unknown>> | undefined;
  /** The packages, by the same locations, whose folder holds a `binding.gyp`. */
  readonly gypfiles: ReadonlySet<string>;
  /** Whether the folder already holds an installed tree (`node_modules`). */
  readonly treePresent: boolean;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function declaresInstallScript(manifest: Readonly<Record<string, unknown>>): boolean {
  const scripts = manifest.scripts;
  if (!isPlainObject(scripts)) return false;
  return INSTALL_LIFECYCLE_SCRIPTS.some((name) => {
    const script = scripts[name];
    return typeof script === "string" && script.trim() !== "";
  });
}

// npm gives a package with a `binding.gyp` the install script `node-gyp rebuild` unless its
// manifest opts out with `gypfile: false`.
function hasImplicitInstallScript(
  manifest: Readonly<Record<string, unknown>>,
  hasGypfile: boolean,
): boolean {
  return hasGypfile && manifest.gypfile !== false;
}

// An absent section and an empty one record the same: nothing declared.
function sectionEntries(section: unknown): readonly (readonly [string, unknown])[] | undefined {
  if (section === undefined) return [];
  return isPlainObject(section) ? Object.entries(section) : undefined;
}

function sameSection(declared: unknown, recorded: unknown): boolean {
  const left = sectionEntries(declared);
  const right = sectionEntries(recorded);
  if (left === undefined || right?.length !== left.length) return false;
  const recordedByName = new Map(right);
  return left.every(([name, specifier]) => recordedByName.get(name) === specifier);
}

function entryRecordsManifest(
  manifest: Readonly<Record<string, unknown>>,
  entry: unknown,
): boolean {
  return (
    isPlainObject(entry) &&
    RECORDED_SECTIONS.every((section) => sameSection(manifest[section], entry[section]))
  );
}

// The root must be recorded. A member is compared where the lockfile records it: the member walk may
// name a folder a negated workspace pattern removes, which npm never records.
function lockfileRecordsManifests(project: HostShellProject): boolean {
  const packages = project.lockfile?.packages;
  if (!isPlainObject(packages)) return false;
  for (const [location, manifest] of project.manifests) {
    const entry = packages[location];
    if (location !== "" && entry === undefined) continue;
    if (!entryRecordsManifest(manifest, entry)) return false;
  }
  return true;
}

export function hostShellRefusal(project: HostShellProject): HostShellRefusal | undefined {
  if (project.lockfile !== undefined && !lockfileRecordsManifests(project)) {
    return "lockfile-mismatch";
  }
  if (project.treePresent) return undefined;
  for (const [location, manifest] of project.manifests) {
    if (
      declaresInstallScript(manifest) ||
      hasImplicitInstallScript(manifest, project.gypfiles.has(location))
    ) {
      return "install-scripts-required";
    }
  }
  return undefined;
}
