import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  linkSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  attestPortableManagedRegistrationFacts,
  refreshPortableRegistration,
  type PortableActivationLayout,
} from "./update-portable-activation-files.js";
import { writePosixRegistrationFixture } from "./__tests__/portable-registration.js";

const targets = ["linux-x64", "macos-x64", "macos-arm64"] as const;
const roots: string[] = [];
const version = "1.2.3";
const attestationModule = new URL("../dist/update-portable-activation-files.js", import.meta.url);
type AttestationInput = Parameters<typeof attestPortableManagedRegistrationFacts>[0];

interface Fixture {
  readonly home: string;
  readonly layout: PortableActivationLayout;
  readonly input: AttestationInput;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function register(fixture: Fixture): AttestationInput {
  refreshPortableRegistration({
    stateDir: fixture.input.stateDir,
    layout: fixture.layout,
    target: fixture.input.target,
    env: {},
    home: fixture.home,
    now: 1_700_000_000_000,
  });
  const registration = readFileSync(join(fixture.input.stateDir, "portable-install-state.json"));
  return {
    ...fixture.input,
    expectedSha256: createHash("sha256").update(registration).digest("hex"),
  };
}

function fixture(target: (typeof targets)[number]): Fixture {
  const home = mkdtempSync(join(realpathSync(tmpdir()), "keiko-posix-registration-"));
  roots.push(home);
  const managedRoot = join(home, target === "linux-x64" ? "Keiko" : "Keiko.app");
  const stateDir = join(home, "state");
  const { layout, registration } = writePosixRegistrationFixture({
    managedRoot,
    stateDir,
    target,
    version,
    home,
    now: 1_700_000_000_000,
  });
  const expectedSha256 = createHash("sha256").update(registration).digest("hex");
  return { home, layout, input: { stateDir, managedRoot, target, version, expectedSha256 } };
}

function expectChildAttestation(input: AttestationInput, expected: "accepted" | "refused"): void {
  const script = [
    "const api = await import(process.argv[1]);",
    "const result = api.attestPortableManagedRegistrationFacts(JSON.parse(process.argv[2]));",
    'process.stdout.write(result === undefined ? "refused" : "accepted");',
  ].join("\n");
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script, attestationModule.href, JSON.stringify(input)],
    { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" },
  );
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  expect(child.stdout).toBe(expected);
}

describe.each(targets)("%s active registration binding", (target) => {
  it("accepts the current setup/launcher binding without inventing a Windows generation", () => {
    const current = fixture(target);
    expect(attestPortableManagedRegistrationFacts(current.input)).toEqual({});
  });

  it.each(["setupManifestPath", "launcherPath"] as const)(
    "rejects changed %s bytes even when the registration itself is unchanged",
    (key) => {
      const current = fixture(target);
      writeFileSync(current.layout[key], "substituted");
      expect(attestPortableManagedRegistrationFacts(current.input)).toBeUndefined();
    },
  );

  it.each(["setupManifestPath", "launcherPath"] as const)(
    "rejects a hard-linked %s even when its bytes are unchanged",
    (key) => {
      const current = fixture(target);
      linkSync(current.layout[key], join(current.home, "second-link"));
      expect(attestPortableManagedRegistrationFacts(current.input)).toBeUndefined();
    },
  );

  it.each(["setupManifestPath", "launcherPath"] as const)(
    "rejects a symlinked %s even when its bytes are unchanged",
    (key) => {
      const current = fixture(target);
      const path = current.layout[key];
      const content = readFileSync(path);
      const replacement = join(current.home, "replacement");
      writeFileSync(replacement, content);
      rmSync(path);
      symlinkSync(replacement, path);
      expect(attestPortableManagedRegistrationFacts(current.input)).toBeUndefined();
    },
  );

  it("rejects a newly recorded setup for another target", () => {
    const current = fixture(target);
    const setup: unknown = JSON.parse(readFileSync(current.layout.setupManifestPath, "utf8"));
    if (setup === null || typeof setup !== "object" || Array.isArray(setup)) {
      throw new TypeError("expected a setup fixture object");
    }
    writeFileSync(
      current.layout.setupManifestPath,
      JSON.stringify({ ...setup, platformTarget: "windows-x64" }),
    );
    expect(attestPortableManagedRegistrationFacts(register(current))).toBeUndefined();
  });

  it
    .skipIf(process.platform === "win32")
    .each(["setupManifestPath", "launcherPath", "registration"] as const)(
    "refuses a FIFO at %s without blocking startup",
    (key) => {
      const current = fixture(target);
      expectChildAttestation(current.input, "accepted");
      const path =
        key === "registration"
          ? join(current.input.stateDir, "portable-install-state.json")
          : current.layout[key];
      rmSync(path);
      execFileSync("/usr/bin/mkfifo", [path], { timeout: 5_000 });
      expectChildAttestation(current.input, "refused");
    },
  );
});
