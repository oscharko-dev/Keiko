import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pathIsDenied } from "./files-deny.js";
import {
  insideProgramFolder,
  launchedFromProgramFolder,
  PROGRAM_FOLDER_LAUNCH_ENV,
} from "./launch-directory.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function folders(): { readonly program: string; readonly sibling: string; readonly root: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-launch-directory-")));
  roots.push(root);
  const program = join(root, "Keiko");
  const sibling = join(root, "Keiko-projects");
  mkdirSync(join(program, "node_modules"), { recursive: true });
  mkdirSync(sibling);
  return { program, sibling, root };
}

const DECLARED = { [PROGRAM_FOLDER_LAUNCH_ENV]: "1" };

describe("launch directory of a Keiko running in its program folder", () => {
  it("is read from the declaration the launchers pin, and only an exact declaration counts", () => {
    // keiko-cli's portable-management and the npm folder launcher pin the same literal.
    expect(PROGRAM_FOLDER_LAUNCH_ENV).toBe("KEIKO_LAUNCH_FROM_PROGRAM_FOLDER");
    expect(launchedFromProgramFolder({ [PROGRAM_FOLDER_LAUNCH_ENV]: "1" })).toBe(true);
    for (const declared of [undefined, "", "0", "true", "yes"]) {
      expect(launchedFromProgramFolder({ [PROGRAM_FOLDER_LAUNCH_ENV]: declared })).toBe(false);
    }
    expect(launchedFromProgramFolder({})).toBe(false);
  });
});

describe("insideProgramFolder", () => {
  it("holds for the declared program folder and everything in it, never for a neighbour", () => {
    const { program, sibling, root } = folders();
    expect(insideProgramFolder(program, DECLARED, program)).toBe(true);
    expect(insideProgramFolder(join(program, "keiko.config.json"), DECLARED, program)).toBe(true);
    expect(insideProgramFolder(join(program, "node_modules", "x"), DECLARED, program)).toBe(true);
    // A folder whose name only starts like the program folder is another folder.
    expect(insideProgramFolder(sibling, DECLARED, program)).toBe(false);
    // The parent holds other folders of the person and stays theirs.
    expect(insideProgramFolder(root, DECLARED, program)).toBe(false);
  });

  it("holds for nothing without the launcher's declaration", () => {
    const { program } = folders();
    expect(insideProgramFolder(program, {}, program)).toBe(false);
    expect(insideProgramFolder(program, { [PROGRAM_FOLDER_LAUNCH_ENV]: "true" }, program)).toBe(
      false,
    );
  });

  it("never judges a relative path: it belongs to a root that was admitted on its own", () => {
    const { program } = folders();
    for (const relativePath of ["", ".", "src/index.ts", "Keiko", "../Keiko"]) {
      expect(insideProgramFolder(relativePath, DECLARED, program)).toBe(false);
    }
  });

  it("knows the folder by the name it was launched with and by its resolved name", () => {
    const { program, root } = folders();
    const link = join(root, "launched-through-a-link");
    symlinkSync(program, link, "junction");
    // Launched through the link: a root given as the link or as the resolved folder is refused.
    expect(insideProgramFolder(join(link, "package.json"), DECLARED, link)).toBe(true);
    expect(insideProgramFolder(join(program, "package.json"), DECLARED, link)).toBe(true);
  });

  it("still refuses a launch directory that can no longer be resolved, as it was given", () => {
    const { root } = folders();
    const gone = join(root, "removed-while-running");
    expect(insideProgramFolder(join(gone, "start.cmd"), DECLARED, gone)).toBe(true);
  });
});

// The read surface asks one gate. Files, Git, the folder dialog, project registration and a Chat's
// connected folder all pass an absolute root to it, so the program folder is refused for all of
// them at once; a root-relative path keeps the deny list alone.
describe("pathIsDenied on a program-folder launch", () => {
  it("refuses the program folder as a root and leaves every other folder alone", () => {
    const { program, sibling } = folders();
    vi.spyOn(process, "cwd").mockReturnValue(program);
    expect(pathIsDenied(program)).toBe(false);

    vi.stubEnv(PROGRAM_FOLDER_LAUNCH_ENV, "1");
    expect(pathIsDenied(program)).toBe(true);
    expect(pathIsDenied(join(program, "package.json"))).toBe(true);
    expect(pathIsDenied(sibling)).toBe(false);
  });

  it("judges a root-relative path by the deny list alone", () => {
    const { program } = folders();
    vi.spyOn(process, "cwd").mockReturnValue(program);
    vi.stubEnv(PROGRAM_FOLDER_LAUNCH_ENV, "1");
    expect(pathIsDenied("src/index.ts")).toBe(false);
    expect(pathIsDenied("keiko.config.json")).toBe(true);
    expect(pathIsDenied(".env")).toBe(true);
  });
});
