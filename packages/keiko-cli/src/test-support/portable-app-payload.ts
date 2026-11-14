import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packFiles } from "../../../../scripts/package-surface-pack.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
// Both trees are admitted whole by the inspection's folder rules, so one file of each stands for
// them; every other entry of the real listing is written as it is.
const WHOLE_TREES = ["dist/", "node_modules/"] as const;

let cachedListing: readonly string[] | undefined;

/**
 * The files the root package's own pack step packs, from the function the package-surface gate and
 * the portable stager's `npm pack` share. A fixture built from it carries every entry a real
 * payload's `app/` carries, including those npm adds on its own.
 */
export function realRootPackListing(): readonly string[] {
  cachedListing ??= packFiles({ packageDir: REPO_ROOT }).map((file) => file.path);
  return cachedListing;
}

/** The real listing with each whole tree reduced to its first file. */
export function realRootPackSample(): readonly string[] {
  const listing = realRootPackListing();
  const outsideTrees = listing.filter((path) => !WHOLE_TREES.some((tree) => path.startsWith(tree)));
  const treeSamples = WHOLE_TREES.flatMap(
    (tree) => listing.find((path) => path.startsWith(tree)) ?? [],
  );
  return [...outsideTrees, ...treeSamples];
}

function realRootPackageJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

/**
 * Writes what the packed root package puts below a payload's `app/`: every entry of the real
 * listing, and a `package.json` that keeps the fixture's own name and version but carries the real
 * package's `files`, `bin` and `main`, the fields npm packed those entries from. Returns the
 * paths relative to the resource root.
 */
export function writePortableAppPayload(resourceRoot: string): readonly string[] {
  const written: string[] = [];
  for (const path of realRootPackSample()) {
    const target = join(resourceRoot, "app", ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    if (path === "package.json") continue;
    writeFileSync(target, "fixture app file\n");
    written.push(`app/${path}`);
  }
  const packagePath = join(resourceRoot, "app", "package.json");
  mkdirSync(dirname(packagePath), { recursive: true });
  const existing = existsSync(packagePath)
    ? (JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>)
    : {};
  const real = realRootPackageJson();
  writeFileSync(
    packagePath,
    JSON.stringify({ ...existing, files: real.files, bin: real.bin, main: real.main }),
  );
  written.push("app/package.json");
  return written;
}
