import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pathIsDenied } from "./files-deny.js";
import {
  insideInstallationPayload,
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

  // Audit of the program-folder refusal: a launch directory that could not be resolved once (a share
  // not yet mounted) kept its lexical spelling for the life of the process, so the folder was later
  // never compared by its system name.
  it("resolves a launch directory again once it can be resolved", () => {
    const { program, root } = folders();
    const link = join(root, "link-made-later");
    // Not resolvable yet: only the lexical spelling is compared.
    expect(insideProgramFolder(join(program, "package.json"), DECLARED, link)).toBe(false);
    symlinkSync(program, link, "junction");
    expect(insideProgramFolder(join(program, "package.json"), DECLARED, link)).toBe(true);
  });

  it("knows the folder by the name it was launched with and by its resolved name", () => {
    const { program, root } = folders();
    const link = join(root, "launched-through-a-link");
    symlinkSync(program, link, "junction");
    // Launched through the link: a root given as the link or as the resolved folder is refused.
    expect(insideProgramFolder(join(link, "package.json"), DECLARED, link)).toBe(true);
    expect(insideProgramFolder(join(program, "package.json"), DECLARED, link)).toBe(true);
  });

  // The same folder spelled another way: a link into it here, a Windows short name (LONGNA~1) on
  // Windows. Neither spelling contains the launch directory's text, so the operating system's own
  // name of the path decides.
  it("refuses a path that reaches the program folder under another spelling", () => {
    const { program, sibling, root } = folders();
    const alias = join(root, "another-spelling");
    symlinkSync(program, alias, "junction");
    expect(insideProgramFolder(alias, DECLARED, program)).toBe(true);
    expect(insideProgramFolder(join(alias, "node_modules"), DECLARED, program)).toBe(true);
    // A link to a neighbour is the neighbour.
    const elsewhere = join(root, "link-to-a-neighbour");
    symlinkSync(sibling, elsewhere, "junction");
    expect(insideProgramFolder(elsewhere, DECLARED, program)).toBe(false);
    // A path that does not exist has no other spelling to resolve.
    expect(insideProgramFolder(join(root, "no-such-folder"), DECLARED, program)).toBe(false);
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

describe("insideInstallationPayload", () => {
  it("names the payload of any installation by its layout, with either separator and any case", () => {
    for (const path of [
      "C:\\Users\\kstd\\Keiko159\\Keiko\\system\\Keiko\\app",
      "c:\\users\\kstd\\keiko159\\keiko\\SYSTEM\\keiko\\App\\dist\\x.js",
      "/Users/me/Keiko/system/Keiko/runtime/node",
      "/Users/me/Keiko/system/Keiko/Keiko.app/Contents/Resources/app",
      "/Users/me/Keiko/system/Keiko/.portable",
      "D:/Keiko/node_modules/@oscharko-dev/keiko/dist",
    ]) {
      expect(insideInstallationPayload(path), path).toBe(true);
    }
  });

  it("leaves ordinary folders, look-alikes and relative paths alone", () => {
    for (const path of [
      "/Users/me/work/project",
      "/Users/me/system/Keiko-projects/app",
      "/Users/me/system/other/app",
      "/Users/me/Keiko/system",
      "/Users/me/node_modules/@oscharko-dev/keiko-ui",
      "C:\\Users\\me\\repo",
      "system/Keiko/app",
    ]) {
      expect(insideInstallationPayload(path), path).toBe(false);
    }
  });
});

describe("insideInstallationPayload on a POSIX host", () => {
  it("keeps the case of a POSIX path, so a person's lower-case folder is not a payload", () => {
    if (process.platform === "win32") return;
    for (const path of [
      "/home/u/code/system/keiko/app",
      "/home/u/code/system/Keiko/APP",
      "/home/u/code/Node_Modules/@oscharko-dev/keiko",
    ]) {
      expect(insideInstallationPayload(path), path).toBe(false);
    }
    expect(insideInstallationPayload("/home/u/Keiko/system/Keiko/app")).toBe(true);
  });

  it("reads a UNC share and a trailing separator as a Windows path", () => {
    expect(insideInstallationPayload("\\\\server\\share\\SYSTEM\\keiko\\App\\")).toBe(true);
    expect(insideInstallationPayload("C:\\Keiko\\system\\Keiko\\runtime\\")).toBe(true);
    expect(insideInstallationPayload("/Users/me/Keiko/system/Keiko/app/")).toBe(true);
  });

  it("judges an existing path by the name the operating system gives it", () => {
    const { root } = folders();
    const payload = join(root, "system", "Keiko", "app");
    mkdirSync(payload, { recursive: true });
    const alias = join(root, "alias");
    symlinkSync(payload, alias, "dir");
    expect(insideInstallationPayload(alias)).toBe(true);
    expect(insideInstallationPayload(join(root, "Keiko-projects"))).toBe(false);
  });

  it("refuses a path it cannot resolve for a reason other than not existing", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const { root } = folders();
    const locked = join(root, "locked");
    mkdirSync(join(locked, "inner"), { recursive: true });
    chmodSync(locked, 0o000);
    try {
      expect(insideInstallationPayload(join(locked, "inner"))).toBe(true);
      expect(pathIsDenied(join(locked, "inner"))).toBe(true);
    } finally {
      chmodSync(locked, 0o700);
    }
    // A path that simply does not exist is another folder, not a refusal.
    expect(insideInstallationPayload(join(root, "no-such-folder"))).toBe(false);
  });
});
