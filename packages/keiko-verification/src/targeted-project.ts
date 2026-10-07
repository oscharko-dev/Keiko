import { dirname, join, relative } from "node:path";
import {
  assertContainedRealPath,
  detectWorkspaceAt,
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

function nestedVitestRoot(workspace: WorkspaceInfo, file: string, fs: WorkspaceFs): string {
  let directory = dirname(file);
  while (directory !== ".") {
    const manifest = resolveWithinWorkspace(workspace.root, join(directory, "package.json"));
    if (fs.exists(manifest)) {
      const root = assertContainedRealPath(
        fs,
        workspace.root,
        resolveWithinWorkspace(workspace.root, directory),
        "targeted test project",
      );
      const nested = detectWorkspaceAt(root, fs, { scanSourceFilesForLanguages: false });
      return nested.testFramework === "vitest" ? directory : "";
    }
    directory = dirname(directory);
  }
  return "";
}
