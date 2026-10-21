import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const native = fileURLToPath(new URL("../../native/portable-launcher/", import.meta.url));

function functionSource(source, name) {
  const pattern = new RegExp(`^static[^\\n]*\\b${name}\\s*\\(`, "mu");
  const match = pattern.exec(source);
  if (match === null) throw new Error("Missing actual Windows policy function");
  const end = source.indexOf("\n}", match.index);
  if (end === -1) throw new Error("Missing actual Windows policy function boundary");
  return source.slice(match.index, end + 2);
}

function compileFixture(root) {
  const source = readFileSync(join(native, "keiko-portable-update-coordinator-windows.h"), "utf8");
  const typesStart = source.indexOf("typedef struct {");
  const typesEnd = source.indexOf("static wchar_t *keiko_coordinator_windows_wide_utf8");
  expect(typesStart).toBeGreaterThan(0);
  expect(typesEnd).toBeGreaterThan(typesStart);
  writeFileSync(join(root, "context-under-test.h"), source.slice(typesStart, typesEnd));
  writeFileSync(
    join(root, "resume-under-test.h"),
    [
      "keiko_coordinator_windows_deadline",
      "keiko_coordinator_windows_read_exact_fd",
      "keiko_coordinator_prepare_resume_windows",
    ]
      .map((name) => functionSource(source, name))
      .join("\n"),
  );
  const fixture = join(root, "fixture.c");
  copyFileSync(new URL("../../tests/fixtures/windows-resume-deadline.c", import.meta.url), fixture);
  const executable = join(root, "fixture");
  const result = spawnSync(
    process.platform === "darwin" ? "/usr/bin/clang" : "cc",
    [
      "-std=c17",
      "-D_GNU_SOURCE",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-Wno-unused-function",
      "-I",
      native,
      fixture,
      "-o",
      executable,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return executable;
}

describe.skipIf(process.platform === "win32")(
  "actual Windows resume policy with inert OS ports",
  () => {
    let root;
    let executable;
    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "keiko-windows-resume-"));
      executable = compileFixture(root);
    });
    afterAll(() => {
      if (root !== undefined) rmSync(root, { recursive: true, force: true });
    });

    function run(now, restoring, fault = 0, monotonic = 100) {
      const result = spawnSync(
        executable,
        [String(now), restoring ? "restore" : "forward", String(fault), String(monotonic)],
        { encoding: "utf8", timeout: 3_000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      return JSON.parse(result.stdout);
    }

    describe.each([false, true])("restoring %s", (restoring) => {
      it.each([
        ["ready exactly at expiry", 8],
        ["peek completes at expiry", 9],
        ["read completes at expiry", 10],
        ["peek completes after expiry", 11],
        ["read completes after expiry", 12],
      ])("refuses a gate when %s", (_name, fault) => {
        expect(run(restoring ? 2990 : 990, restoring, fault).admitted).toBe(0);
      });

      it.each([8, 9, 10, 11, 12])("admits timely gate I/O under timing port %s", (fault) => {
        expect(run(restoring ? 2988 : 988, restoring, fault).admitted).toBe(1);
      });

      it("refuses a partial gate completed after the original deadline", () => {
        expect(run(restoring ? 2990 : 990, restoring, 13).admitted).toBe(0);
      });

      it("admits a complete partial gate one millisecond before the deadline", () => {
        expect(run(restoring ? 2987 : 987, restoring, 13).admitted).toBe(1);
      });
    });

    it.each([
      ["forward before start", 999, false, 1],
      ["forward at start", 1000, false, 0],
      ["forward after start", 1001, false, 0],
      ["forward after verify", 2001, false, 0],
      ["restore before start", 999, true, 1],
      ["restore at start", 1000, true, 1],
      ["restore after start", 1001, true, 1],
      ["restore after verify", 2001, true, 1],
      ["restore before cleanup", 2999, true, 1],
      ["restore at cleanup", 3000, true, 0],
      ["restore after cleanup", 3001, true, 0],
    ])("uses the existing phase grant for %s", (_name, now, restoring, admitted) => {
      expect(run(now, restoring)).toMatchObject({
        admitted,
        gateReads: admitted,
        imageChecks: admitted,
        parentChecks: admitted,
      });
    });

    it.each([
      ["image digest", 1],
      ["gate digest", 2],
      ["parent image", 3],
      ["phase classification", 4],
      ["volume", 5],
      ["plan load", 6],
    ])("preserves refusal for invalid %s", (_name, fault) => {
      expect(run(2001, true, fault).admitted).toBe(0);
    });

    it("bounds a withheld gate to the remaining cleanup grant", () => {
      const result = run(2980, true, 7);
      expect(result.admitted).toBe(0);
      expect(result.gateReads).toBe(0);
      expect(result.elapsedMs).toBeLessThanOrEqual(30);
    });

    it("refuses unavailable wall time before image or gate work", () => {
      expect(run("18446744073709551615", true)).toMatchObject({
        admitted: 0,
        imageChecks: 0,
        gateReads: 0,
      });
    });

    it("refuses monotonic deadline overflow before image or gate work", () => {
      expect(run(2001, true, 0, "18446744073709551600")).toMatchObject({
        admitted: 0,
        imageChecks: 0,
        gateReads: 0,
      });
    });
  },
);
