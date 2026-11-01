import { execFileSync } from "node:child_process";

// This reads npm's real package selection, rather than guessing what "files" or .npmignore means.
export function collectPolicyPackages(root, packages) {
  if (process.env.npm_execpath === undefined) throw new TypeError("npm-invocation-required");
  const output = execFileSync(
    process.execPath,
    [process.env.npm_execpath, "pack", "--dry-run", "--json", "--ignore-scripts", "--workspaces"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const packed = JSON.parse(output);
  return evaluatePolicyPackages(packed, packages);
}

export function evaluatePolicyPackages(packed, packages) {
  const names = packages
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  if (
    !Array.isArray(packed) ||
    packed
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right))
      .join("\0") !== names.join("\0")
  ) {
    throw new TypeError("pack-inventory-mismatch");
  }
  return packages.map((entry) => {
    const actual = packed.find((item) => item.name === entry.name);
    const files = actual.files
      .map((file) => file.path)
      .sort((left, right) => left.localeCompare(right));
    const targets = entry.exports.map((item) => item.target.replace(/^\.\//u, ""));
    if (targets.some((target) => !files.includes(target)))
      throw new TypeError("unpacked-export-target");
    return { name: entry.name, files, fileCount: files.length };
  });
}
