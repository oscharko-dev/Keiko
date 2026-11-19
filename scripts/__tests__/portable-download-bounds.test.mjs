import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  boundedCommand,
  boundedCurlCommand,
  PORTABLE_DOWNLOAD_MAX_TIME_SECONDS,
  PORTABLE_DOWNLOAD_STALL_BYTES_PER_SECOND,
  PORTABLE_DOWNLOAD_STALL_SECONDS,
  PORTABLE_DOWNLOAD_TIMEOUT_GRACE_MS,
  portableDownloadCurlArgs,
  portableDownloadFailure,
  portableDownloadMaxTimeSeconds,
  portableDownloadTimeoutMs,
} from "../lib/portable-download-bounds.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fileOfSize(size) {
  const root = mkdtempSync(join(tmpdir(), "keiko-download-bounds-"));
  roots.push(root);
  const path = join(root, "asset.zip");
  writeFileSync(path, Buffer.alloc(size));
  return path;
}

const expected = { assetName: "keiko-linux-x64.zip", expectedSize: 1000 };

describe("portable download bounds (PR #4464)", () => {
  it("keeps the release deadline unless a test run shortens it", () => {
    expect(portableDownloadMaxTimeSeconds({})).toBe(PORTABLE_DOWNLOAD_MAX_TIME_SECONDS);
    // A release run cannot shorten or lift its own deadline.
    expect(portableDownloadMaxTimeSeconds({ KEIKO_PORTABLE_DOWNLOAD_MAX_TIME_SECONDS: "1" })).toBe(
      PORTABLE_DOWNLOAD_MAX_TIME_SECONDS,
    );
    expect(
      portableDownloadMaxTimeSeconds({
        NODE_ENV: "test",
        KEIKO_PORTABLE_DOWNLOAD_MAX_TIME_SECONDS: "2",
      }),
    ).toBe(2);
    for (const invalid of ["0", "-1", "1.5", "x", ""]) {
      expect(
        portableDownloadMaxTimeSeconds({
          NODE_ENV: "test",
          KEIKO_PORTABLE_DOWNLOAD_MAX_TIME_SECONDS: invalid,
        }),
        invalid,
      ).toBe(PORTABLE_DOWNLOAD_MAX_TIME_SECONDS);
    }
    expect(portableDownloadTimeoutMs(2)).toBe(2000 + PORTABLE_DOWNLOAD_TIMEOUT_GRACE_MS);
  });

  it("bounds curl in time, speed and size, HTTPS only and without a .curlrc", () => {
    const args = portableDownloadCurlArgs({
      expectedSize: 1234,
      destination: "/tmp/out.zip",
      url: "https://example.invalid/a.zip",
      maxTimeSeconds: 1800,
    });
    expect(args[0]).toBe("-q");
    const value = (flag) => args[args.indexOf(flag) + 1];
    expect(value("--proto")).toBe("=https");
    expect(value("--proto-redir")).toBe("=https");
    expect(value("--max-time")).toBe("1800");
    expect(value("--speed-limit")).toBe(String(PORTABLE_DOWNLOAD_STALL_BYTES_PER_SECOND));
    expect(value("--speed-time")).toBe(String(PORTABLE_DOWNLOAD_STALL_SECONDS));
    expect(value("--max-filesize")).toBe("1234");
    expect(value("--output")).toBe("/tmp/out.zip");
    expect(args.at(-1)).toBe("https://example.invalid/a.zip");
    expect(args).toContain("--fail");
  });

  it("caps the bytes written with a file-size limit that admits the exact size", () => {
    const args = ["--output", "x"];
    for (const [size, blocks] of [
      [0, 1],
      [1, 2],
      [512, 2],
      [513, 3],
      [1024, 3],
    ]) {
      const command = boundedCurlCommand(args, size, "linux");
      expect(command.cmd).toBe("sh");
      expect(command.args.slice(0, 5)).toEqual([
        "-c",
        'ulimit -f "$1" && shift && exec "$@"',
        "sh",
        String(blocks),
        "curl",
      ]);
      expect(command.args.slice(5)).toEqual(args);
      expect(Number(blocks) * 512).toBeGreaterThanOrEqual(size);
    }
    expect(boundedCurlCommand(args, 1024, "darwin").cmd).toBe("sh");
    // Windows has no POSIX shell limit; curl's own size and time bounds still apply.
    expect(boundedCurlCommand(args, 1024, "win32")).toEqual({ cmd: "curl", args });
  });

  it("names a timeout, an oversized response and any other failure with the asset", () => {
    const missing = join(tmpdir(), "keiko-download-bounds-missing", "asset.zip");
    expect(portableDownloadFailure({ error: { code: "ETIMEDOUT" } }, expected, missing)).toBe(
      "portable asset download timed out for keiko-linux-x64.zip.",
    );
    expect(portableDownloadFailure({ signal: "SIGXFSZ", status: null }, expected, missing)).toBe(
      "portable asset download exceeded the expected size for keiko-linux-x64.zip.",
    );
    // A failed write at the limit leaves a file longer than the expected size.
    expect(portableDownloadFailure({ status: 23 }, expected, fileOfSize(1001))).toBe(
      "portable asset download exceeded the expected size for keiko-linux-x64.zip.",
    );
    for (const destination of [missing, fileOfSize(1000), fileOfSize(10)]) {
      expect(portableDownloadFailure({ status: 22 }, expected, destination)).toBe(
        "unauthenticated portable asset download failed for keiko-linux-x64.zip.",
      );
    }
  });

  it("names curl's own timeout and file-size statuses, even with a short or missing file", () => {
    const missing = join(tmpdir(), "keiko-download-bounds-missing", "asset.zip");
    for (const destination of [missing, fileOfSize(10)]) {
      expect(portableDownloadFailure({ status: 28 }, expected, destination)).toBe(
        "portable asset download timed out for keiko-linux-x64.zip.",
      );
      expect(portableDownloadFailure({ status: 63 }, expected, destination)).toBe(
        "portable asset download exceeded the expected size for keiko-linux-x64.zip.",
      );
    }
  });

  it("keeps the manifest limit equal to the updater's MAX_PORTABLE_MANIFEST_BYTES", async () => {
    const { MAX_PORTABLE_MANIFEST_BYTES } =
      await import("../../packages/keiko-server/src/update-portable-staging-shared.ts");
    const { PORTABLE_MANIFEST_MAX_BYTES } = await import("../lib/portable-download-bounds.mjs");
    expect(PORTABLE_MANIFEST_MAX_BYTES).toBe(MAX_PORTABLE_MANIFEST_BYTES);
  });
});

describe("boundedCommand transfer ceiling (PR #4464)", () => {
  const posix = process.platform === "win32" ? it.skip : it;
  const CEILING = 1_048_576;

  function writeThrough(bytes) {
    const root = mkdtempSync(join(tmpdir(), "keiko-download-bounds-"));
    roots.push(root);
    const out = join(root, "manifest.json");
    const command = boundedCommand(
      "sh",
      ["-c", `head -c ${String(bytes)} /dev/zero > "$1"`, "sh", out],
      CEILING,
    );
    const result = spawnSync(command.cmd, command.args, { encoding: "utf8" });
    return { out, result };
  }

  posix("cuts a body larger than the ceiling while it is written", () => {
    const { out, result } = writeThrough(CEILING * 4);
    expect(result.status === 0 && result.signal === null).toBe(false);
    // Linux counts the limit in 512-byte blocks, macOS's sh in 1024-byte ones: at most twice the
    // ceiling reaches the disk there, never the four times the body would write.
    expect(statSync(out).size).toBeLessThanOrEqual(2 * CEILING + 1024);
  });

  posix("admits a body of exactly the ceiling", () => {
    const { out, result } = writeThrough(CEILING);
    expect(result.status).toBe(0);
    expect(statSync(out).size).toBe(CEILING);
  });

  it("leaves the command alone where no POSIX file-size limit exists", () => {
    expect(boundedCommand("gh", ["a"], CEILING, "win32")).toEqual({ cmd: "gh", args: ["a"] });
  });
});
