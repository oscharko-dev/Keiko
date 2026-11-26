import { describe, expect, it } from "vitest";

import {
  keikoServiceNames,
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
const EMPTY_LISTING: ScResult = {
  status: 0,
  stdout: "SERVICE_NAME: Spooler\nDISPLAY_NAME: Print Spooler\n",
};

interface SeamOverrides {
  readonly env?: Record<string, string | undefined>;
  readonly present?: readonly string[];
  readonly programs?: readonly string[];
  /** `null`: `whoami` could not run. */
  readonly groups?: string | null;
  readonly gateway?: ScResult;
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
    sc: (args) =>
      args.length === 2 ? (overrides.gateway ?? NO_SERVICES) : (overrides.listing ?? EMPTY_LISTING),
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

describe("keikoServiceNames", () => {
  it("finds the Keiko-prefixed names in any locale and counts each once", () => {
    const listing = [
      "SERVICE_NAME: KeikoRuntimeGateway",
      "DISPLAY_NAME: KeikoRuntimeGateway",
      "DIENSTNAME: keikoHelper",
      "SERVICE_NAME: Spooler",
      "DISPLAY_NAME: Not Keiko at all",
    ].join("\r\n");
    expect(keikoServiceNames(listing)).toEqual(["keikoruntimegateway", "keikohelper"]);
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
    const listing = { status: 0, stdout: "SERVICE_NAME: KeikoOther\nSERVICE_NAME: Spooler\n" };
    const facts = probeWindowsPreconditions(seams({ listing }));
    expect(facts.unmetPreconditions).toEqual(["service-installed"]);
    expect(facts.services).toEqual({ keikoGatewayServiceInstalled: false, keikoServiceCount: 1 });
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
