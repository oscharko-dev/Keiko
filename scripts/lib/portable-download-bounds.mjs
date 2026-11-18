// Bounds for the publisher's unauthenticated download of each portable release asset.
//
// A valid asset is a few hundred megabytes: the whole transfer may take half an hour, but a
// connection that moves less than 10 KiB/s for a minute is stalled, and the subprocess timeout
// sits just above curl's own deadline so a hung process is still ended and named.

import { existsSync, statSync } from "node:fs";

export const PORTABLE_DOWNLOAD_MAX_TIME_SECONDS = 1800;
export const PORTABLE_DOWNLOAD_STALL_SECONDS = 60;
export const PORTABLE_DOWNLOAD_STALL_BYTES_PER_SECOND = 10 * 1024;
export const PORTABLE_DOWNLOAD_TIMEOUT_GRACE_MS = 30_000;

// curl's documented exit statuses for a transfer deadline and for --max-filesize.
const CURL_EXIT_OPERATION_TIMEDOUT = 28;
const CURL_EXIT_FILESIZE_EXCEEDED = 63;

// Mirrors MAX_PORTABLE_MANIFEST_BYTES in packages/keiko-server/src/update-portable-staging-shared.ts
// (scripts cannot import TS sources; portable-download-bounds.test.mjs pins the two equal).
export const PORTABLE_MANIFEST_MAX_BYTES = 1_048_576;
const PORTABLE_MANIFEST_DOWNLOAD_MAX_TIME_SECONDS = 120;

/** The subprocess timeout for the small manifest download through gh. */
export function portableManifestDownloadTimeoutMs() {
  return portableDownloadTimeoutMs(PORTABLE_MANIFEST_DOWNLOAD_MAX_TIME_SECONDS);
}

/** The transfer deadline; tests may shorten it, a release run never can. */
export function portableDownloadMaxTimeSeconds(env = process.env) {
  const override = Number(env.KEIKO_PORTABLE_DOWNLOAD_MAX_TIME_SECONDS);
  return env.NODE_ENV === "test" && Number.isInteger(override) && override > 0
    ? override
    : PORTABLE_DOWNLOAD_MAX_TIME_SECONDS;
}

/** The subprocess timeout: curl's own deadline plus a grace period. */
export function portableDownloadTimeoutMs(maxTimeSeconds) {
  return maxTimeSeconds * 1000 + PORTABLE_DOWNLOAD_TIMEOUT_GRACE_MS;
}

/** curl arguments for one asset: HTTPS only, also through every redirect, bounded in time and size. */
export function portableDownloadCurlArgs({ expectedSize, destination, url, maxTimeSeconds }) {
  // -q first: no .curlrc applies.
  return [
    "-q",
    "--proto",
    "=https",
    "--proto-redir",
    "=https",
    "--fail",
    "--silent",
    "--show-error",
    "--location",
    "--max-time",
    String(maxTimeSeconds),
    "--speed-limit",
    String(PORTABLE_DOWNLOAD_STALL_BYTES_PER_SECOND),
    "--speed-time",
    String(PORTABLE_DOWNLOAD_STALL_SECONDS),
    "--max-filesize",
    String(expectedSize),
    "--output",
    destination,
    url,
  ];
}

/**
 * curl's --max-filesize only applies when the server states a length. The file-size resource limit
 * of the child process bounds the bytes written either way: a transfer past the expected size ends
 * with SIGXFSZ instead of filling the runner's temporary storage. `ulimit -f` counts 512-byte
 * blocks in POSIX shells, so one block more than the size rounded up always admits the exact size.
 */
export function boundedCurlCommand(args, expectedSize, platform = process.platform) {
  if (platform === "win32") return { cmd: "curl", args };
  const blocks = Math.ceil(expectedSize / 512) + 1;
  return {
    cmd: "sh",
    args: ["-c", 'ulimit -f "$1" && shift && exec "$@"', "sh", String(blocks), "curl", ...args],
  };
}

function downloadedSize(destination) {
  return existsSync(destination) ? statSync(destination).size : 0;
}

/** The plain reason a failed download names, with the asset it concerns. */
export function portableDownloadFailure(result, expected, destination) {
  const assetName = expected.assetName;
  if (result.error?.code === "ETIMEDOUT" || result.status === CURL_EXIT_OPERATION_TIMEDOUT) {
    return `portable asset download timed out for ${assetName}.`;
  }
  // Node and curl may meet the file-size limit as a failed write instead of the signal; either
  // way the file can only be longer than the expected size when the response was too large.
  if (
    result.signal === "SIGXFSZ" ||
    result.status === CURL_EXIT_FILESIZE_EXCEEDED ||
    downloadedSize(destination) > expected.expectedSize
  ) {
    return `portable asset download exceeded the expected size for ${assetName}.`;
  }
  return `unauthenticated portable asset download failed for ${assetName}.`;
}
