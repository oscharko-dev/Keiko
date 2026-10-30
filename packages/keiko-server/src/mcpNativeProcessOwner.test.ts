import { beforeEach, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { assertMcpNativeStdioOwner } from "@oscharko-dev/keiko-mcp";
import { discoverQualifiedPortableOpenCode } from "./coding-runtime/productionPortableCodingRuntime.js";
import { discoverDevLaneOpenCode } from "./coding-runtime/devLanePortableCodingRuntime.js";
import { emitServerDiagnostic } from "./diagnostics-log.js";
import { discoverMcpNativeProcessOwner } from "./mcpNativeProcessOwner.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("@oscharko-dev/keiko-mcp", () => ({ assertMcpNativeStdioOwner: vi.fn() }));
vi.mock("./coding-runtime/productionPortableCodingRuntime.js", () => ({
  discoverQualifiedPortableOpenCode: vi.fn(),
}));
vi.mock("./coding-runtime/devLanePortableCodingRuntime.js", () => ({
  discoverDevLaneOpenCode: vi.fn(),
}));
vi.mock("./diagnostics-log.js", () => ({
  emitServerDiagnostic: vi.fn(),
  contentFreeErrorClass: (): string => "Error",
}));
const binding = { nativeHelperPath: "C:\\Keiko\\owner.exe", nativeHelperSha256: "a".repeat(64) };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(assertMcpNativeStdioOwner).mockReset();
  vi.mocked(discoverQualifiedPortableOpenCode).mockReturnValue(undefined);
  vi.mocked(discoverDevLaneOpenCode).mockReturnValue({ outcome: "inactive" });
  vi.mocked(spawnSync).mockReturnValue({
    status: 0,
    stdout: '{"schemaVersion":1,"ownedStdio":"windows-job"}',
  } as ReturnType<typeof spawnSync>);
});

it("does not probe irrelevant platforms or missing native assets", () => {
  expect(discoverMcpNativeProcessOwner({}, "darwin")).toBeUndefined();
  expect(discoverMcpNativeProcessOwner({}, "win32")).toBeUndefined();
  expect(spawnSync).not.toHaveBeenCalled();
  expect(emitServerDiagnostic).not.toHaveBeenCalled();
});
it.each(["portable", "development"])(
  "admits only a verified %s owner with the current capability",
  (lane) => {
    if (lane === "portable")
      vi.mocked(discoverQualifiedPortableOpenCode).mockReturnValue(
        binding as ReturnType<typeof discoverQualifiedPortableOpenCode>,
      );
    else
      vi.mocked(discoverDevLaneOpenCode).mockReturnValue({
        outcome: "activated",
        runtime: binding,
      } as ReturnType<typeof discoverDevLaneOpenCode>);
    const result = discoverMcpNativeProcessOwner(
      { SYSTEMROOT: "C:\\Windows", SYNTHETIC_SECRET: "not-for-probe" },
      "win32",
    );
    expect(result).toEqual({
      executable: binding.nativeHelperPath,
      sha256: binding.nativeHelperSha256,
    });
    expect(assertMcpNativeStdioOwner).toHaveBeenCalledWith(result);
    expect(spawnSync).toHaveBeenCalledWith(
      binding.nativeHelperPath,
      ["--probe-stdio-owner"],
      expect.objectContaining({ env: { SYSTEMROOT: "C:\\Windows" } }),
    );
  },
);
it.each(["stale", "mismatched-output", "tampered", "missing-digest"])(
  "refuses a %s owner",
  (failure) => {
    vi.mocked(discoverQualifiedPortableOpenCode).mockReturnValue({
      ...binding,
      ...(failure === "missing-digest" ? { nativeHelperSha256: undefined } : {}),
    } as ReturnType<typeof discoverQualifiedPortableOpenCode>);
    if (failure === "stale")
      vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: "" } as ReturnType<
        typeof spawnSync
      >);
    if (failure === "mismatched-output")
      vi.mocked(spawnSync).mockReturnValue({
        status: 0,
        stdout: '{"schemaVersion":2,"ownedStdio":"windows-job"}',
      } as ReturnType<typeof spawnSync>);
    if (failure === "tampered")
      vi.mocked(assertMcpNativeStdioOwner).mockImplementation(() => {
        throw new Error("synthetic private path");
      });
    expect(discoverMcpNativeProcessOwner({}, "win32")).toBeUndefined();
    if (failure === "tampered") {
      expect(spawnSync).not.toHaveBeenCalled();
      expect(JSON.stringify(vi.mocked(emitServerDiagnostic).mock.calls)).not.toContain(
        "synthetic private path",
      );
    }
  },
);

it.each(["failed", "mismatched", "throwing"])(
  "records a body-free %s probe refusal through the supplied diagnostic sink",
  (failure) => {
    vi.mocked(discoverQualifiedPortableOpenCode).mockReturnValue(
      binding as ReturnType<typeof discoverQualifiedPortableOpenCode>,
    );
    if (failure === "throwing")
      vi.mocked(spawnSync).mockImplementationOnce(() => {
        throw new Error("synthetic private probe data");
      });
    else
      vi.mocked(spawnSync).mockReturnValueOnce({
        status: failure === "failed" ? null : 0,
        stdout: "synthetic private probe data",
      } as ReturnType<typeof spawnSync>);
    const diagnostics = { record: vi.fn() };
    expect(discoverMcpNativeProcessOwner({}, "win32", diagnostics)).toBeUndefined();
    expect(emitServerDiagnostic).toHaveBeenCalledWith(
      diagnostics,
      expect.objectContaining({ operation: "mcp.connection", source: "mcp.native-owner" }),
    );
    expect(JSON.stringify(vi.mocked(emitServerDiagnostic).mock.calls)).not.toContain(
      "synthetic private probe data",
    );
  },
);
