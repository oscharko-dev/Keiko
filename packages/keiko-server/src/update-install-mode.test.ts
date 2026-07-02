import { describe, expect, it } from "vitest";
import { CommandDeniedError, DEFAULT_SANDBOX_POLICY, runCommand } from "@oscharko-dev/keiko-tools";
import {
  UPDATE_COMMAND_RULES,
  buildUpdateCommand,
  detectUpdateInstallMode,
  productionUpdateFacts,
  type UpdateRuntimeFacts,
} from "./update-install-mode.js";

const ROOT = "/usr/local/lib/node_modules/@oscharko-dev/keiko";
const YARN_ROOT = "/Users/alice/.config/yarn/global/node_modules/@oscharko-dev/keiko";
const WINDOWS_NPM_ROOT =
  "C:\\Users\\Alice\\AppData\\Roaming\\npm\\node_modules\\@oscharko-dev\\keiko";

function fakeDetectorFs(manifestPath: string): Parameters<typeof productionUpdateFacts>[1] {
  return {
    existsSync: (path: string): boolean => path === manifestPath,
    readFileSync: (): string => JSON.stringify({ name: "@oscharko-dev/keiko" }),
    realpathSync: (path: string): string => path,
    lstatSync: () => ({ isSymbolicLink: () => false }),
  };
}

function facts(overrides: Partial<UpdateRuntimeFacts> = {}): UpdateRuntimeFacts {
  return {
    packageRoot: ROOT,
    packageName: "@oscharko-dev/keiko",
    packageManagerHint: "npm",
    installScope: "global",
    ...overrides,
  };
}

describe("detectUpdateInstallMode", () => {
  it("supports deterministic global npm and Yarn installs", () => {
    expect(detectUpdateInstallMode(facts()).packageManager).toBe("npm");
    expect(detectUpdateInstallMode(facts({ packageManagerHint: "yarn" })).packageManager).toBe(
      "yarn",
    );
  });

  it("refuses transient, checkout, linked, launcher-drift, and local installs", () => {
    expect(detectUpdateInstallMode(facts({ transientRunner: true })).reason).toBe(
      "transient-runner",
    );
    expect(detectUpdateInstallMode(facts({ localCheckout: true })).reason).toBe("local-checkout");
    expect(detectUpdateInstallMode(facts({ linkedPackage: true })).reason).toBe("linked-package");
    expect(detectUpdateInstallMode(facts({ launcherDrift: true })).reason).toBe("launcher-drift");
    expect(detectUpdateInstallMode(facts({ installScope: "local" })).reason).toBe("local-install");
  });

  it("fails closed when the package manager is ambiguous", () => {
    expect(detectUpdateInstallMode(facts({ packageManagerHint: undefined })).reason).toBe(
      "package-manager-ambiguous",
    );
  });

  it("infers npm from an env-free published global bin path", () => {
    const runtimeFacts = productionUpdateFacts(
      { KEIKO_CLI_BIN_PATH: `${ROOT}/dist/cli/index.js` },
      fakeDetectorFs(`${ROOT}/package.json`),
    );

    expect(runtimeFacts.packageManagerHint).toBe("npm");
    expect(detectUpdateInstallMode(runtimeFacts, {}).packageManager).toBe("npm");
  });

  it("infers npm from an env-free Windows global bin path", () => {
    const runtimeFacts = productionUpdateFacts(
      { KEIKO_CLI_BIN_PATH: `${WINDOWS_NPM_ROOT}\\dist\\cli\\index.js` },
      fakeDetectorFs(`${WINDOWS_NPM_ROOT}\\package.json`),
    );

    expect(runtimeFacts.packageRoot).toBe(WINDOWS_NPM_ROOT);
    expect(runtimeFacts.packageManagerHint).toBe("npm");
    expect(runtimeFacts.installScope).toBeUndefined();
    expect(detectUpdateInstallMode(runtimeFacts, {}).packageManager).toBe("npm");
  });

  it("infers Yarn from an env-free Yarn global bin path", () => {
    const runtimeFacts = productionUpdateFacts(
      { KEIKO_CLI_BIN_PATH: `${YARN_ROOT}/dist/cli/index.js` },
      fakeDetectorFs(`${YARN_ROOT}/package.json`),
    );

    expect(runtimeFacts.packageManagerHint).toBe("yarn");
    expect(detectUpdateInstallMode(runtimeFacts, {}).packageManager).toBe("yarn");
  });
});

describe("update command policy", () => {
  it("builds exact npm and Yarn argv without shell strings", () => {
    expect(buildUpdateCommand("npm", "0.2.12")).toMatchObject({
      executable: "npm",
      args: ["install", "--global", "--ignore-scripts", "@oscharko-dev/keiko@0.2.12"],
    });
    expect(buildUpdateCommand("yarn", "0.2.12")).toMatchObject({
      executable: "yarn",
      args: ["global", "add", "--ignore-scripts", "@oscharko-dev/keiko@0.2.12"],
    });
  });

  it("denies package-manager flags outside the update argv", async () => {
    await expect(
      runCommand(
        {
          command: "npm",
          args: ["--prefix", "/tmp/evil", "install", "@oscharko-dev/keiko@0.2.12"],
          cwd: undefined,
          timeoutMs: 1_000,
          signal: new AbortController().signal,
        },
        {
          workspace: {
            root: process.cwd(),
            name: undefined,
            version: undefined,
            testFramework: "unknown",
            sourceDirs: [],
            testDirs: [],
            languages: [],
            ignoreLines: [],
          },
          policy: DEFAULT_SANDBOX_POLICY,
          commandRules: UPDATE_COMMAND_RULES,
          spawn: () => {
            throw new Error("spawn should not run");
          },
          processEnv: { PATH: process.env.PATH },
          now: Date.now,
        },
      ),
    ).rejects.toBeInstanceOf(CommandDeniedError);
  });
});
