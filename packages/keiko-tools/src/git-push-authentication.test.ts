import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-contracts";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { defaultResolveExecutable } from "./exec.js";
import {
  gitCredentialHelperCommand,
  prepareGitHubPushAuthentication,
} from "./git-push-authentication.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
interface Fixture {
  root: string;
  workspace: WorkspaceInfo;
  external: string;
  env: NodeJS.ProcessEnv;
  executable: string;
}
function fixture(): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "keiko-gh-helper-")));
  cleanups.push(() => {
    rmSync(base, { recursive: true, force: true });
  });
  const root = join(base, "work");
  const external = join(base, "trusted-install 'quoted' $literal `literal`");
  mkdirSync(root);
  mkdirSync(external);
  const executable = join(external, process.platform === "win32" ? "gh.EXE" : "gh");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  chmodSync(executable, 0o700);
  const workspace: WorkspaceInfo = {
    root,
    selectedRoot: root,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
  return {
    root,
    workspace,
    external,
    executable,
    env: {
      PATH: external,
      HOME: base,
      USERPROFILE: base,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  };
}
function prepare(f: Fixture): ReturnType<typeof prepareGitHubPushAuthentication> {
  return prepareGitHubPushAuthentication("https://github.com/owner/repo.git", {
    workspace: f.workspace,
    processEnv: f.env,
  });
}

describe("trusted GitHub push authentication", () => {
  it("quotes the official helper through Git's shell on POSIX and Windows", () => {
    expect(gitCredentialHelperCommand("/opt/GitHub CLI/gh", "linux")).toBe(
      "!'/opt/GitHub CLI/gh' auth git-credential",
    );
    expect(
      gitCredentialHelperCommand(String.raw`C:\Program Files\GitHub CLI\gh.exe`, "win32"),
    ).toBe("!'C:/Program Files/GitHub CLI/gh.exe' auth git-credential");
    expect(gitCredentialHelperCommand("/opt/it's gh", "darwin")).toBe(
      "!'/opt/it'\\''s gh' auth git-credential",
    );
  });
  it.each(["relative-gh", "/opt/gh\ncommand", "/opt/gh\rcommand", "/opt/gh\0command"])(
    "rejects malformed helper executable %j",
    (path) => {
      expect(() => gitCredentialHelperCommand(path, "linux")).toThrow(
        "git-push-auth-executable-invalid",
      );
    },
  );
  it.each([String.raw`C:\tools\gh.cmd`, String.raw`C:\tools\gh.bat`, String.raw`C:\tools\gh.com`])(
    "requires a Windows executable image %s",
    (path) => {
      expect(() => gitCredentialHelperCommand(path, "win32")).toThrow(
        "git-push-auth-executable-invalid",
      );
    },
  );
  it("resets inherited helpers and scopes the fixed resolved binary to canonical HTTPS GitHub", () => {
    const f = fixture();
    const result = prepare(f);
    expect(result.configArgs).toEqual([
      "-c",
      "credential.helper=",
      "-c",
      `credential.https://github.com.helper=${gitCredentialHelperCommand(defaultResolveExecutable("gh", { workspace: f.workspace, processEnv: f.env }))}`,
      "-c",
      "credential.interactive=false",
      "-c",
      "credential.useHttpPath=true",
    ]);
    expect(result.pinnedEnv).toEqual({
      GH_HOST: "github.com",
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
      GH_TELEMETRY: "0",
    });
  });
  it("never accesses credential-bearing environment values", () => {
    const f = fixture();
    for (const key of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
    ]) {
      Object.defineProperty(f.env, key, {
        enumerable: true,
        get: (): never => {
          throw new Error("credential value was accessed");
        },
      });
    }
    expect(prepare(f).configArgs).toHaveLength(8);
  });
  it.each(["git@github.com:owner/repo.git", "ssh://git@github.com/owner/repo.git"])(
    "leaves SSH %s without an HTTP helper or gh requirement",
    (url) => {
      const f = fixture();
      const resolveExecutable = vi.fn((): never => {
        throw new Error("unexpected helper resolution");
      });
      expect(
        prepareGitHubPushAuthentication(url, {
          workspace: f.workspace,
          processEnv: {},
          resolveExecutable,
        }),
      ).toEqual({ configArgs: [], pinnedEnv: {} });
      expect(resolveExecutable).not.toHaveBeenCalled();
    },
  );
  it.each([
    "https://foreign.example/owner/repo",
    "https://token@github.com/owner/repo",
    "https://github.com:443/owner/repo",
    "http://github.com/owner/repo",
  ])("denies a noncanonical target %s before helper discovery", (url) => {
    const f = fixture();
    expect(() =>
      prepareGitHubPushAuthentication(url, { workspace: f.workspace, processEnv: {} }),
    ).toThrow("git-push-auth-destination-invalid");
  });
  it("uses the existing PATH boundary to refuse a repository-local gh before a later safe binary", () => {
    const f = fixture();
    const planted = join(f.root, process.platform === "win32" ? "gh.EXE" : "gh");
    writeFileSync(planted, "#!/bin/sh\nexit 0\n");
    chmodSync(planted, 0o700);
    f.env.PATH = `${f.root}${delimiter}${f.external}`;
    expect(() => prepare(f)).toThrow("executable resolves inside workspace");
  });
  it("refuses an external PATH alias whose executable points back into the repository", () => {
    const f = fixture();
    const planted = join(f.root, "planted");
    writeFileSync(planted, "#!/bin/sh\nexit 0\n");
    chmodSync(planted, 0o700);
    rmSync(f.executable);
    symlinkSync(planted, f.executable);
    expect(() => prepare(f)).toThrow("executable resolves inside workspace");
  });
  it("refuses a trusted resolver seam that accidentally returns an in-workspace path", () => {
    const f = fixture();
    expect(() =>
      prepareGitHubPushAuthentication("https://github.com/owner/repo", {
        workspace: f.workspace,
        processEnv: f.env,
        resolveExecutable: () => join(f.root, "gh"),
      }),
    ).toThrow("git-push-auth-config-untrusted");
  });
  it("fails closed when gh is unavailable instead of falling back to an ambient helper", () => {
    const f = fixture();
    f.env.PATH = "";
    expect(() => prepare(f)).toThrow("executable not found on PATH: gh");
  });
  it.each(["GH_CONFIG_DIR", "XDG_CONFIG_HOME", "HOME", "USERPROFILE", "AppData", "APPDATA"])(
    "rejects repository-controlled account selector %s",
    (key) => {
      const f = fixture();
      f.env[key] = join(f.root, "config", "missing");
      expect(() => prepare(f)).toThrow("git-push-auth-config-untrusted");
    },
  );
  it("rejects config aliases, including missing descendants inside a repository alias", () => {
    const f = fixture();
    const alias = join(f.external, "config-alias");
    symlinkSync(f.root, alias, "dir");
    f.env.GH_CONFIG_DIR = join(alias, "missing", "gh");
    expect(() => prepare(f)).toThrow("git-push-auth-config-untrusted");
  });
  it.each(["hosts.yml", "config.yml"])(
    "rejects %s symlinks into workspace without reading config contents",
    (name) => {
      const f = fixture();
      const file = join(f.root, name);
      writeFileSync(file, "private credential configuration");
      symlinkSync(file, join(f.external, name));
      f.env.GH_CONFIG_DIR = f.external;
      expect(() => prepare(f)).toThrow("git-push-auth-config-untrusted");
    },
  );
  it("accepts missing external account configuration and refuses broken existing aliases", () => {
    const f = fixture();
    f.env.GH_CONFIG_DIR = join(f.external, "not-created", "gh");
    expect(prepare(f).configArgs).toHaveLength(8);
    f.env.GH_CONFIG_DIR = join(f.external, "broken");
    symlinkSync(join(f.root, "missing"), f.env.GH_CONFIG_DIR);
    expect(() => prepare(f)).toThrow("git-push-auth-config-untrusted");
  });
  it("uses only filesystem metadata when validating authentication paths", () => {
    const f = fixture();
    const fs = {
      ...nodeWorkspaceFs,
      readFileUtf8: (): never => {
        throw new Error("config content was read");
      },
    };
    expect(
      prepareGitHubPushAuthentication("https://github.com/owner/repo", {
        workspace: f.workspace,
        processEnv: f.env,
        fs,
      }).configArgs,
    ).toHaveLength(8);
  });
});

describe.skipIf(process.platform === "win32")(
  "real Git credential protocol with a synthetic gh helper",
  () => {
    it("runs only the quoted trusted helper and keeps its private bytes inside Git's protocol", () => {
      const f = fixture();
      writeFileSync(
        f.executable,
        '#!/bin/sh\n[ "$1 $2 $3" = "auth git-credential get" ] || exit 1\nprintf "protocol=https\\nhost=github.com\\nusername=fixture-user\\npassword=fixture-only-value\\n"\n',
      );
      const result = prepare(f);
      const marker = join(f.root, "hostile-helper-ran");
      const hostile = `!printf hostile > '${marker.replaceAll("'", "'\\''")}'`;
      const options = {
        cwd: f.root,
        env: { ...f.env, PATH: process.env.PATH, ...result.pinnedEnv },
        encoding: "utf8" as const,
        input: "protocol=https\nhost=github.com\npath=owner/repo.git\n\n",
      };
      // Prove the hostile fixture is executable without the production reset, then prove that
      // the real prepared configuration prevents it. A dead helper cannot satisfy this regression.
      expect(() =>
        execFileSync("git", ["-c", `credential.helper=${hostile}`, "credential", "fill"], {
          ...options,
          stdio: ["pipe", "pipe", "pipe"],
        }),
      ).toThrow();
      expect(existsSync(marker)).toBe(true);
      rmSync(marker);
      const stdout = execFileSync(
        "git",
        ["-c", `credential.helper=${hostile}`, ...result.configArgs, "credential", "fill"],
        options,
      );
      expect(stdout).toContain("username=fixture-user\npassword=fixture-only-value");
      expect(stdout).not.toContain("hostile-helper");
      expect(existsSync(marker)).toBe(false);
    });
    it("never invokes the GitHub helper for another HTTPS host", () => {
      const f = fixture();
      const marker = join(f.external, "called");
      writeFileSync(
        f.executable,
        `#!/bin/sh\nprintf 'called' > '${marker.replaceAll("'", "'\\''")}'\n`,
      );
      const result = prepare(f);
      expect(() =>
        execFileSync("git", [...result.configArgs, "credential", "fill"], {
          cwd: f.root,
          env: { ...f.env, PATH: process.env.PATH, ...result.pinnedEnv },
          encoding: "utf8",
          input: "protocol=https\nhost=foreign.example\n\n",
          stdio: ["pipe", "pipe", "pipe"],
        }),
      ).toThrow();
      expect(() => readFileSync(marker)).toThrow();
    });
  },
);
