import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, parse } from "node:path";

function parentTrust(path) {
  const root = parse(path).root;
  let current = dirname(path);
  for (;;) {
    const entry = lstatSync(current);
    if (entry.isSymbolicLink()) return "symlink";
    if (!entry.isDirectory()) return "not-directory";
    if (entry.uid !== 0) return "not-root-owned";
    if ((entry.mode & 0o022) !== 0) return "group-or-other-writable";
    if (current === root) return "trusted";
    current = dirname(current);
  }
}

function gitHostFacts(developerDirectory) {
  const resolved = spawnSync("/usr/bin/xcrun", ["--find", "git"], {
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      ...(developerDirectory === undefined ? {} : { DEVELOPER_DIR: developerDirectory }),
    },
    shell: false,
    timeout: 10_000,
  });
  if (resolved.error !== undefined || resolved.status !== 0) return { status: "resolver-failed" };
  const path = resolved.stdout.trim();
  if (!isAbsolute(path) || path.includes("\0") || /[\r\n]/u.test(path)) {
    return { status: "invalid-path" };
  }
  try {
    const entry = lstatSync(path);
    return {
      status: "resolved",
      canonical: realpathSync(path) === path,
      regular: entry.isFile(),
      symlink: entry.isSymbolicLink(),
      oneLink: entry.nlink === 1,
      rootOwned: entry.uid === 0,
      ownerOnlyWritable: (entry.mode & 0o022) === 0,
      parentTrust: parentTrust(path),
    };
  } catch {
    return { status: "metadata-unavailable" };
  }
}

process.stdout.write(
  `darwin-git-host: ${JSON.stringify({
    selected: gitHostFacts(),
    commandLineTools: gitHostFacts("/Library/Developer/CommandLineTools"),
  })}\n`,
);
