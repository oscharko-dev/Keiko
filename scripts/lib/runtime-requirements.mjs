// Shared registry descriptors and lockfile edge resolution for staged runtime delivery.
import { satisfies } from "semver";

/** Retain each actual range/origin and optional precedence; a required origin wins by name. */
export function collectRuntimeRequirements(sources) {
  const requirements = new Map();
  for (const { origin, requirements: entries } of sources) {
    for (const { name, range, optional } of entries) {
      const key = `${name}\u0000${optional === true ? "optional" : "required"}\u0000${range}`;
      const record = requirements.get(key) ?? {
        name,
        range,
        optional: optional === true,
        origins: new Set(),
      };
      record.origins.add(origin);
      requirements.set(key, record);
    }
  }
  const required = new Set(
    [...requirements.values()].filter(({ optional }) => !optional).map(({ name }) => name),
  );
  return [...requirements.values()]
    .filter(({ name, optional }) => !optional || !required.has(name))
    .sort(
      (a, b) =>
        compareDescriptorStrings(a.name, b.name) || compareDescriptorStrings(a.range, b.range),
    )
    .map(({ name, range, optional, origins }) => ({
      name,
      range,
      optional,
      origins: [...origins].sort(compareDescriptorStrings),
    }));
}

function compareDescriptorStrings(left, right) {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/**
 * Whether the version an edge resolves to satisfies THIS descriptor's range.
 *
 * Per descriptor, not per name: when one parent's optional range is satisfied by an installed copy
 * and a second parent declares a NON-OVERLAPPING optional range for the same name, npm may resolve
 * the second to nothing and the walk-up then finds the first parent's copy. Serving it would answer
 * a descriptor it does not satisfy, and Yarn fails with "no candidates" for the other one.
 *
 * `semver` decides this rather than `minimumSatisfyingVersion`'s lowest-member approximation: the
 * ranges here come from every manifest in the transitive closure, and a hand-rolled matcher over
 * that grammar is exactly the guessing this file already refuses to do elsewhere. An `npm:` alias
 * descriptor carries its range after the target, which is the half `semver` needs.
 */
export function descriptorIsSatisfied(requirement, version) {
  if (version === undefined) return false;
  const range = aliasRange(requirement.range ?? "");
  if (range === "" || range === "*" || range === "latest") return true;
  return satisfies(version, range, { includePrerelease: true, loose: true });
}

/**
 * `npm:target@^1.2.3` -> `^1.2.3`. `assertRegistryOnlyDescriptors` already accepts `npm:` as a
 * registry protocol; treating it as unresolvable here is the inconsistency #3133 records, and it
 * made a legitimately absent optional alias fatal instead of stubbing it.
 */
export function aliasRange(range) {
  const trimmed = range.trim();
  if (!trimmed.startsWith("npm:")) return trimmed;
  const target = trimmed.slice("npm:".length);
  const at = target.lastIndexOf("@");
  return at <= 0 ? "*" : target.slice(at + 1);
}

/**
 * npm's package-json documentation: "Entries in optionalDependencies will override entries of the
 * same name in dependencies." That precedence is applied per manifest, so a name listed in both is
 * treated as optional. Across DIFFERENT manifests a genuine required edge still wins — see
 * `record()` — because another package really does need it.
 */
export function manifestRequirements(manifest, bundledSet = new Set()) {
  const merged = new Map();
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    merged.set(name, { name, range, optional: false });
  }
  for (const [name, range] of Object.entries(manifest.optionalDependencies ?? {})) {
    merged.set(name, { name, range, optional: true });
  }
  return [...merged.values()].filter((requirement) => !bundledSet.has(requirement.name));
}

/** Peer imports couple an ancestor to the same delivered runtime family, including optional peers. */
export function manifestRuntimeEdges(manifest) {
  return [
    ...manifestRequirements(manifest),
    ...Object.entries(manifest.peerDependencies ?? {}).map(([name, range]) => ({
      name,
      range,
      optional: manifest.peerDependenciesMeta?.[name]?.optional === true,
    })),
  ];
}

/**
 * The install path that owns `path` — where Node's resolution continues when a name is not found
 * beside it. `node_modules/a/node_modules/b` is owned by `node_modules/a`; a workspace path and a
 * hoisted package alike are owned by the project root, spelled `""`.
 */
export function lockfileOwnerPath(path) {
  const marker = "/node_modules/";
  const at = path.lastIndexOf(marker);
  return at === -1 ? "" : path.slice(0, at);
}

/**
 * Resolve one dependency edge the way Node does: beside the requesting package first, then in each
 * owner up to the project root. This is the whole point of #3133 — the answer comes from the edges
 * the lockfile pins, so a copy the production graph never selects is never even considered.
 */
export function resolveLockfileEdge(packages, originPath, name) {
  let owner = originPath;
  for (;;) {
    const candidate = owner === "" ? `node_modules/${name}` : `${owner}/node_modules/${name}`;
    if (packages.has(candidate)) return candidate;
    if (owner === "") return undefined;
    owner = lockfileOwnerPath(owner);
  }
}

/**
 * The name and version a lockfile record pins. An `npm:` alias is installed under the ALIAS
 * directory while Yarn requests the packument under the TARGET name, and the record carries that
 * target in its own `name` field — which is why the alias question this issue also tracks is
 * answered here rather than by re-parsing a descriptor `minimumSatisfyingVersion` cannot read.
 */
export function lockfileRecordIdentity(path, entry) {
  const installedAs = path.split("node_modules/").at(-1) ?? "";
  return {
    name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : installedAs,
    version: typeof entry.version === "string" ? entry.version : undefined,
  };
}
