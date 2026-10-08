import { dirname, join, relative } from "node:path";
import {
  assertContainedRealPath,
  resolveWithinWorkspace,
  type WorkspaceFs,
  type WorkspaceInfo,
} from "@oscharko-dev/keiko-workspace";

export interface TargetedProject {
  readonly root: string;
  readonly files: string[];
}

// Keep the execution/sandbox root at the repository. A nested Vitest project's --root selects
// its own configuration and setup while the repository's hoisted dependencies stay available.
export function targetedVitestProjects(
  workspace: WorkspaceInfo,
  files: readonly string[],
  fs: WorkspaceFs,
): readonly TargetedProject[] {
  const projects = new Map<string, TargetedProject>();
  for (const file of files) {
    const root = nestedVitestRoot(workspace, file, fs);
    const project = projects.get(root) ?? { root, files: [] };
    project.files.push(root === "" ? file : relative(root, file).replaceAll("\\", "/"));
    projects.set(root, project);
  }
  return [...projects.values()];
}

const VITEST_CONFIG_NAMES = ["vitest.config", "vite.config"] as const;
const VITEST_CONFIG_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"] as const;

function hasOwnVitestConfig(workspace: WorkspaceInfo, directory: string, fs: WorkspaceFs): boolean {
  return VITEST_CONFIG_NAMES.some((name) =>
    VITEST_CONFIG_EXTENSIONS.some((extension) => {
      const path = resolveWithinWorkspace(workspace.root, join(directory, name + extension));
      if (!fs.exists(path)) return false;
      const config = assertContainedRealPath(fs, workspace.root, path, "targeted test config");
      return fs.stat(config).isFile;
    }),
  );
}

function nestedVitestRoot(workspace: WorkspaceInfo, file: string, fs: WorkspaceFs): string {
  let directory = dirname(file);
  while (directory !== ".") {
    const manifest = resolveWithinWorkspace(workspace.root, join(directory, "package.json"));
    if (fs.exists(manifest)) {
      assertContainedRealPath(
        fs,
        workspace.root,
        resolveWithinWorkspace(workspace.root, directory),
        "targeted test project",
      );
      return hasOwnVitestConfig(workspace, directory, fs) ? directory : "";
    }
    directory = dirname(directory);
  }
  return "";
}
