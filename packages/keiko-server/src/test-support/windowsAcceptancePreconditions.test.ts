import { describe, expect, it } from "vitest";

import { acceptanceEvidenceFailures } from "../../../../scripts/check-acceptance-evidence.mjs";
import { OPENCODE_PINNED_VERSION } from "../coding-runtime/opencodeRuntimeVersions.js";
import { buildAcceptanceEvidence } from "./acceptanceEvidence.js";
import {
  WINDOWS_PRECONDITION_CODES,
  keikoRegistryServiceNames,
  probeWindowsPreconditions,
  windowsUserClass,
  type ScResult,
  type WindowsProbeSeams,
} from "./windowsAcceptancePreconditions.js";

const HEADER = '"Group Name","Type","SID","Attributes"';
const row = (
  sid: string,
  attributes = "Mandatory group, Enabled by default, Enabled group",
): string => `"NAME\\something","Well-known group","${sid}","${attributes}"`;

const STANDARD_GROUPS = [HEADER, row("S-1-1-0"), row("S-1-5-32-545"), row("S-1-16-8192")].join(
  "\n",
);
const ELEVATED_GROUPS = [
  HEADER,
  row("S-1-1-0"),
  row("S-1-5-32-544", "Mandatory group, Enabled by default, Enabled group, Group owner"),
  row("S-1-16-12288"),
].join("\n");
const FILTERED_ADMIN_GROUPS = [
  HEADER,
  row("S-1-1-0"),
  row("S-1-5-32-544", "Group used for deny only"),
  row("S-1-16-8192"),
].join("\n");

const NO_SERVICES: ScResult = { status: 1060, stdout: "" };
const REGISTRY_ROOT = "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services";
const registryListing = (...names: readonly string[]): ScResult => ({
  status: 0,
  stdout: ["", REGISTRY_ROOT, ...names.map((name) => `${REGISTRY_ROOT}\\${name}`), ""].join("\r\n"),
});
const EMPTY_LISTING: ScResult = registryListing("Spooler", "BFE", "Dhcp");
/** What the SCM answers to a standard user under a batch or network logon: it cannot enumerate. */
const ENUMERATION_DENIED: ScResult = { status: 5, stdout: "[SC] OpenSCManager FAILED 5:" };

interface SeamOverrides {
  readonly env?: Record<string, string | undefined>;
  readonly present?: readonly string[];
  readonly programs?: readonly string[];
  /** `null`: `whoami` could not run. */
  readonly groups?: string | null;
  readonly gateway?: ScResult;
  /** The answer for `com.docker.service`. */
  readonly dockerService?: ScResult;
  /** The registry listing of the service keys. */
  readonly listing?: ScResult;
  /** `where.exe` could not run. */
  readonly whereUnrunnable?: boolean;
}

function seams(overrides: SeamOverrides = {}): WindowsProbeSeams {
  return {
    env: overrides.env ?? {
      ProgramFiles: "C:\\Program Files",
      LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
    },
    exists: (path) => (overrides.present ?? []).includes(path),
    onPath: (program) =>
      overrides.whereUnrunnable === true ? undefined : (overrides.programs ?? []).includes(program),
    whoamiGroups: () =>
      overrides.groups === null ? undefined : (overrides.groups ?? STANDARD_GROUPS),
    reg: () => overrides.listing ?? EMPTY_LISTING,
    sc: (args): ScResult => {
      if (args.length !== 2) return ENUMERATION_DENIED;
      return args[1] === "com.docker.service"
        ? (overrides.dockerService ?? NO_SERVICES)
        : (overrides.gateway ?? NO_SERVICES);
    },
  };
}

describe("windowsUserClass", () => {
  it("certifies only a token that is neither elevated nor in Administrators", () => {
    expect(windowsUserClass(STANDARD_GROUPS)).toBe("standard");
  });

  it("refuses an elevated administrator", () => {
    expect(windowsUserClass(ELEVATED_GROUPS)).toBe("administrator");
  });

  it("refuses the filtered token of an administrator, whose group is deny-only", () => {
    expect(windowsUserClass(FILTERED_ADMIN_GROUPS)).toBe("administrator");
  });

  it("refuses a high integrity level without the group, and reads the SID whatever the locale", () => {
    const localized = [
      '"Gruppenname","Typ","SID","Attribute"',
      row("S-1-1-0"),
      row("S-1-16-16384"),
    ];
    expect(windowsUserClass(localized.join("\n"))).toBe("administrator");
  });

  it("is unknown for output that is not a group list", () => {
    expect(windowsUserClass("")).toBe("unknown");
    expect(windowsUserClass("ERROR: Access is denied.")).toBe("unknown");
    expect(windowsUserClass("S-1-5-32-545 only")).toBe("unknown");
  });

  it("does not read a longer SID as Administrators", () => {
    const longer = [HEADER, row("S-1-1-0"), row("S-1-5-32-5445"), row("S-1-16-8192")].join("\n");
    expect(windowsUserClass(longer)).toBe("standard");
  });
});

describe("keikoRegistryServiceNames", () => {
  it("finds the Keiko-prefixed service keys in any locale and counts each once", () => {
    const listing = registryListing("KeikoRuntimeGateway", "keikoHelper", "Spooler", "NotKeiko");
    const output = `${listing.stdout}\r\n${REGISTRY_ROOT}\\KEIKORUNTIMEGATEWAY`;
    expect(keikoRegistryServiceNames(output)).toEqual(["keikoruntimegateway", "keikohelper"]);
  });

  it("ignores a nested key and any other root", () => {
    const output = `${REGISTRY_ROOT}\\Keiko\\Parameters\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Keiko\r\n`;
    expect(keikoRegistryServiceNames(output)).toEqual([]);
  });
});

describe("probeWindowsPreconditions", () => {
  it("certifies a clean standard user", () => {
    const facts = probeWindowsPreconditions(seams());
    expect(facts.userClass).toBe("standard");
    expect(facts.containerRuntime).toEqual({
      dockerOnPath: false,
      podmanOnPath: false,
      otherClientOnPath: false,
      dockerHostConfigured: false,
      dockerServiceInstalled: false,
      runtimePipePresent: false,
      applicationPresent: false,
    });
    expect(facts.services).toEqual({ keikoGatewayServiceInstalled: false, keikoServiceCount: 0 });
    expect(facts.unmetPreconditions).toEqual([]);
  });

  it("names an administrator alone", () => {
    expect(
      probeWindowsPreconditions(seams({ groups: ELEVATED_GROUPS })).unmetPreconditions,
    ).toEqual(["administrator"]);
  });

  it.each([
    ["a client on PATH", { programs: ["docker"] }],
    ["podman on PATH", { programs: ["podman"] }],
    ["DOCKER_HOST", { env: { DOCKER_HOST: "npipe:////./pipe/x" } }],
    ["CONTAINER_HOST", { env: { CONTAINER_HOST: "ssh://x" } }],
    ["the docker engine pipe", { present: ["\\\\.\\pipe\\docker_engine"] }],
    ["the podman machine pipe", { present: ["\\\\.\\pipe\\podman-machine-default"] }],
    ["Docker Desktop's folder", { present: ["C:\\Program Files\\Docker"] }],
    [
      "Podman Desktop under the user's programs",
      { present: ["C:\\Users\\u\\AppData\\Local\\Programs\\Podman Desktop"] },
    ],
    [
      "the per-user podman-desktop folder",
      { present: ["C:\\Users\\u\\AppData\\Local\\Programs\\podman-desktop"] },
    ],
    ["the Docker Desktop service", { dockerService: { status: 0, stdout: "" } }],
  ] satisfies readonly (readonly [string, SeamOverrides])[])(
    "names a container runtime alone: %s",
    (_sign, overrides) => {
      const facts = probeWindowsPreconditions(seams(overrides));
      expect(facts.unmetPreconditions).toEqual(["container-runtime-present"]);
    },
  );

  it("names the gateway service alone, found by its exact name", () => {
    const facts = probeWindowsPreconditions(seams({ gateway: { status: 0, stdout: "" } }));
    expect(facts.unmetPreconditions).toEqual(["service-installed"]);
    expect(facts.services).toEqual({ keikoGatewayServiceInstalled: true, keikoServiceCount: 1 });
  });

  it("names any service with the Keiko prefix", () => {
    const listing = registryListing("KeikoOther", "Spooler");
    const facts = probeWindowsPreconditions(seams({ listing }));
    expect(facts.unmetPreconditions).toEqual(["service-installed"]);
    expect(facts.services).toEqual({ keikoGatewayServiceInstalled: false, keikoServiceCount: 1 });
  });

  it("certifies a clean machine whose SCM refuses enumeration to a batch logon (regression)", () => {
    const facts = probeWindowsPreconditions(seams());
    expect(facts.services).toEqual({ keikoGatewayServiceInstalled: false, keikoServiceCount: 0 });
    expect(facts.unmetPreconditions).toEqual([]);
  });

  it("names every failed precondition, not only the first", () => {
    const facts = probeWindowsPreconditions(
      seams({
        groups: ELEVATED_GROUPS,
        programs: ["docker"],
        gateway: { status: 0, stdout: "" },
      }),
    );
    expect(facts.unmetPreconditions).toEqual([
      "administrator",
      "container-runtime-present",
      "service-installed",
    ]);
  });

  it("fails closed as its own code when the user probe cannot run", () => {
    for (const groups of [null, "ERROR: Access is denied."]) {
      const facts = probeWindowsPreconditions(seams({ groups }));
      expect(facts.userClass).toBe("unknown");
      expect(facts.unmetPreconditions).toEqual(["administrator-probe-failed"]);
    }
  });

  it("fails closed as its own code when the container probe cannot run", () => {
    const facts = probeWindowsPreconditions(seams({ whereUnrunnable: true }));
    expect(facts.containerRuntime).toEqual({});
    expect(facts.unmetPreconditions).toEqual(["container-runtime-probe-failed"]);
  });

  it("fails closed as its own code when the Docker Desktop service query cannot answer", () => {
    const facts = probeWindowsPreconditions(seams({ dockerService: { status: null, stdout: "" } }));
    expect(facts.containerRuntime).toEqual({});
    expect(facts.unmetPreconditions).toEqual(["container-runtime-probe-failed"]);
  });

  it.each([
    ["a gateway query that cannot run", { gateway: { status: null, stdout: "" } }],
    ["an unexpected gateway query status", { gateway: { status: 5, stdout: "" } }],
    ["a listing that fails", { listing: { status: 1, stdout: "" } }],
    ["a listing that cannot run", { listing: { status: null, stdout: "" } }],
  ] satisfies readonly (readonly [string, SeamOverrides])[])(
    "fails closed as its own code for %s",
    (_name, overrides) => {
      const facts = probeWindowsPreconditions(seams(overrides));
      expect(facts.services).toBeUndefined();
      expect(facts.unmetPreconditions).toEqual(["service-probe-failed"]);
    },
  );

  it("records no path, name or SID of the person", () => {
    const facts = probeWindowsPreconditions(
      seams({ groups: ELEVATED_GROUPS, gateway: { status: 0, stdout: "" } }),
    );
    expect(JSON.stringify(facts)).not.toMatch(/S-1-|\\|NAME|Keiko[A-Z]/u);
  });
});

// The probe's output wrapped by the production evidence builder, read by the production checker:
// no evidence is restated here (#4492 AC3).
const WINDOWS_HOST = { platform: "win32", arch: "arm64", osRelease: "10.0.26100", node: "26.13.1" };

function checkedMachine(overrides: SeamOverrides): {
  readonly failures: readonly string[];
  readonly codes: readonly string[];
} {
  const preconditions = probeWindowsPreconditions(seams(overrides));
  const evidence = buildAcceptanceEvidence({
    preconditions,
    opencode: OPENCODE_PINNED_VERSION,
    cases: [],
    caseSetComplete: false,
    everyCaseMetExpectation: false,
    host: WINDOWS_HOST,
  });
  return {
    failures: acceptanceEvidenceFailures(evidence, { preconditionsOnly: true }),
    codes: preconditions.unmetPreconditions,
  };
}

const CODE_CASES = [
  ["administrator", { groups: ELEVATED_GROUPS }, ["administrator"]],
  ["administrator-probe-failed", { groups: null }, ["administrator-probe-failed"]],
  ["container-runtime-present", { programs: ["docker"] }, ["container-runtime-present"]],
  [
    "container-runtime-probe-failed",
    { whereUnrunnable: true },
    ["container-runtime-present", "container-runtime-probe-failed"],
  ],
  ["service-installed", { gateway: { status: 0, stdout: "" } }, ["service-installed"]],
  ["service-probe-failed", { listing: { status: null, stdout: "" } }, ["service-probe-failed"]],
] satisfies readonly (readonly [string, SeamOverrides, readonly string[]])[];

describe("probe output through the production evidence builder and checker", () => {
  it("certifies the preconditions of a clean machine and nothing else", () => {
    const { failures, codes } = checkedMachine({});
    expect(codes).toEqual([]);
    expect(failures).toEqual([]);
  });

  it.each(CODE_CASES)("refuses %s, naming it", (code, overrides, expected) => {
    const { failures, codes } = checkedMachine(overrides);
    expect(codes).toContain(code);
    expect(failures).toEqual(expected);
  });

  it("never reports a code the checker does not recognize, and every code is reachable", () => {
    const emitted = new Set<string>();
    for (const [, overrides] of CODE_CASES) {
      const { failures, codes } = checkedMachine(overrides);
      for (const code of codes) emitted.add(code);
      expect(failures).not.toContain("precondition-unrecognized");
    }
    expect([...emitted].sort()).toEqual([...WINDOWS_PRECONDITION_CODES].sort());
  });

  it("refuses all three at once, naming each", () => {
    const { failures } = checkedMachine({
      groups: ELEVATED_GROUPS,
      programs: ["docker"],
      gateway: { status: 0, stdout: "" },
    });
    expect(failures).toEqual(["administrator", "container-runtime-present", "service-installed"]);
  });

  it("does not certify a machine as a result: the full check still refuses the missing cases", () => {
    const evidence = buildAcceptanceEvidence({
      preconditions: probeWindowsPreconditions(seams()),
      opencode: OPENCODE_PINNED_VERSION,
      cases: [],
      caseSetComplete: false,
      everyCaseMetExpectation: false,
      host: WINDOWS_HOST,
    });
    expect(acceptanceEvidenceFailures(evidence)).toEqual(["case-set-incomplete", "case-not-met"]);
  });
});
