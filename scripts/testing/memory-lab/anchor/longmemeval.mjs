// The LongMemEval download of the anchor fetcher (#4208): the Hub tree API names the one cleaned
// LongMemEval_S JSON file, which is streamed to disk and verified against its published size and
// SHA-256 before it is renamed into place. A file already on disk that matches is never downloaded
// again.
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DOWNLOAD_HEADERS,
  FetchFailure,
  describeNetworkError,
  requestJson,
  requestOnce,
  withRetries,
} from "./http.mjs";
import { ensurePrivateDirectory } from "./private-files.mjs";
import { HUB } from "./sets.mjs";

function isTree(value) {
  return Array.isArray(value);
}

// Exactly one cleaned LongMemEval_S JSON file may match; any other outcome fails closed with the
// names found, rather than guessing which file was meant.
function pickLongMemEvalFile(tree) {
  const files = tree.filter((entry) => entry?.type === "file" && typeof entry.path === "string");
  const matches = files.filter(
    (entry) =>
      basename(entry.path) === entry.path &&
      entry.path.startsWith("longmemeval_s") &&
      entry.path.includes("cleaned") &&
      entry.path.endsWith(".json"),
  );
  if (matches.length !== 1)
    throw new FetchFailure(
      `expected one longmemeval_s cleaned JSON file, found ${String(matches.length)} among: ${files.map((entry) => entry.path).join(", ")}`,
    );
  const [entry] = matches;
  return {
    path: entry.path,
    size: Number.isSafeInteger(entry.size) ? entry.size : undefined,
    sha256: typeof entry.lfs?.oid === "string" ? entry.lfs.oid : undefined,
  };
}

// Counts bytes and hashes whatever flows through, so a download is verified without a second pass.
function measuringTap() {
  const hash = createHash("sha256");
  let bytes = 0;
  const tap = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  return { tap, measurement: () => ({ bytes, sha256: hash.digest("hex") }) };
}

async function measureFile(path) {
  const { tap, measurement } = measuringTap();
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  await pipeline(createReadStream(path), tap, sink);
  return measurement();
}

// The measurement of a file already on disk, when it matches the published size and digest.
async function verifiedFile(path, entry) {
  if (!existsSync(path)) return undefined;
  if (entry.size !== undefined && statSync(path).size !== entry.size) return undefined;
  const measured = await measureFile(path);
  return entry.sha256 === undefined || measured.sha256 === entry.sha256 ? measured : undefined;
}

async function streamToFile(response, path) {
  if (response.body === null) throw new FetchFailure("download has no body", { retryable: true });
  const { tap, measurement } = measuringTap();
  try {
    await pipeline(Readable.fromWeb(response.body), tap, createWriteStream(path, { mode: 0o600 }));
  } catch (error) {
    rmSync(path, { force: true });
    throw new FetchFailure(`download interrupted (${describeNetworkError(error)})`, {
      retryable: true,
      cause: error,
    });
  }
  return measurement();
}

function verifyDownload(entry, received, partialPath) {
  const sizeWrong = entry.size !== undefined && received.bytes !== entry.size;
  const digestWrong = entry.sha256 !== undefined && received.sha256 !== entry.sha256;
  if (!sizeWrong && !digestWrong) return;
  rmSync(partialPath, { force: true });
  throw new FetchFailure(
    `download does not match the published ${sizeWrong ? "size" : "SHA-256"} of ${entry.path}`,
    { retryable: true },
  );
}

async function downloadFile(set, context, entry, target) {
  const url = `${HUB}/datasets/${set.dataset}/resolve/${set.revision}/${encodeURIComponent(entry.path)}`;
  const partialPath = `${target}.part`;
  const received = await withRetries(context, `download ${entry.path}`, async () => {
    const response = await requestOnce(url, context, {
      timeoutMs: context.downloadTimeoutMs,
      headers: DOWNLOAD_HEADERS,
    });
    const measured = await streamToFile(response, partialPath);
    verifyDownload(entry, measured, partialPath);
    return measured;
  });
  renameSync(partialPath, target);
  return received;
}

export async function fetchLongMemEval(name, set, context, { setDir }) {
  ensurePrivateDirectory(setDir);
  const treeUrl = `${HUB}/api/datasets/${set.dataset}/tree/${set.revision}`;
  const { value: tree } = await requestJson(treeUrl, `${name} file listing`, context, isTree);
  const entry = pickLongMemEvalFile(tree);
  const target = join(setDir, entry.path);
  const existing = await verifiedFile(target, entry);
  const measured = existing ?? (await downloadFile(set, context, entry, target));
  context.log(
    `${name} ${entry.path} bytes=${String(measured.bytes)}${existing === undefined ? "" : " (already on disk)"}`,
  );
  return {
    filter: null,
    file: entry.path,
    rowCount: null,
    bytes: measured.bytes,
    sha256: measured.sha256,
    sourceUrlTemplate: `${HUB}/datasets/${set.dataset}/resolve/${set.revision}/{file}`,
    apiUrlTemplate: treeUrl,
  };
}
