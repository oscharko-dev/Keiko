// Shared, platform-independent protocol codec and process helpers for the runtime-supervisor
// harnesses. Extracted from the two copies under
// `native/runtime-supervisor/test-protocol.mjs` (Windows) and
// `native/runtime-supervisor/macos/test-protocol.mjs` (macOS) per audit KEIKO-0304. The audit
// documented six ways those copies had drifted; each divergence is reconciled deliberately below,
// not by whichever version was moved first.

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

// SUPERVISOR-006 kept: `fileURLToPath` for platform paths — the raw `.pathname` off a `new URL`
// misencodes on Windows (drive letters) and mishandles `%`, `#`, `?`, spaces.
export { fileURLToPath };

// One canonical name at the boundary. `frame` (macOS) and `header` (Windows) were the same
// function; both call sites now use `header` (the Windows spelling), and `frame` is exported as an
// alias so external readers see the historical name too.
export function header(magic, kind, payloadLength) {
  const bytes = Buffer.alloc(12);
  bytes.write(magic, 0, "ascii");
  bytes.writeUInt16LE(1, 4);
  bytes.writeUInt16LE(kind, 6);
  bytes.writeUInt32LE(payloadLength, 8);
  return bytes;
}
export const frame = header;

/**
 * Build the KRP1 launch packet. Both platforms encode the same shape: 32-hex recovery handle,
 * executable, cwd, then arg pairs and env pairs prefixed by (argCount, envCount).
 *
 * @param {string} executable  absolute path the supervisor will `posix_spawn` / `CreateProcessW`
 * @param {string} cwd         working directory
 * @param {readonly [string,string][]=} envPairs  parent env vars to forward, `[["K","V"], …]`
 * @param {readonly string[]=} args               positional arguments to pass to the executable
 */
export function launchPacket(
  executable,
  cwd,
  envPairs = [["KEIKO_ALPHA", "one"]],
  args = ["--qualified", "second-argument"],
) {
  const strings = [
    "0123456789abcdef0123456789abcdef",
    executable,
    cwd,
    ...args,
    ...envPairs.flatMap(([key, value]) => [key, value]),
  ];
  const prefix = Buffer.alloc(4);
  prefix.writeUInt16LE(args.length, 0);
  prefix.writeUInt16LE(envPairs.length, 2);
  const parts = [prefix];
  for (const value of strings) {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length);
    parts.push(length, bytes, Buffer.alloc(1));
  }
  const payload = Buffer.concat(parts);
  return Buffer.concat([header("KRP1", 1, payload.length), payload]);
}

/**
 * Wrap a Node stream into a bounded-read queue. Chunks accumulate until `readBytes` consumes the
 * requested prefix. `wake` is invoked once per data/end/close/error event; a stream that ends or
 * errors before the requested bytes arrive rejects the pending read rather than deadlocking.
 *
 * `error` and `close` are BOTH observed alongside `end`:
 *  - `error`: stream emitted a failure (broken pipe, ECONNRESET). Saved on `reader.error` so the
 *    next `readBytes` check rejects with that error instead of a generic "ended before …" —
 *    otherwise the error goes to the unhandled-error path and terminates the harness.
 *  - `close`: on Windows the child's stdio can `close` without an `end` (Readable in flowing mode,
 *    or an aborted pipe), and readers relying on `end` alone would then never wake. Treating
 *    `close` as ended-when-not-errored makes the pending read settle.
 */
export function streamReader(stream) {
  const reader = { chunks: [], size: 0, wake: undefined, ended: false, error: undefined };
  stream.on("data", (chunk) => {
    reader.chunks.push(chunk);
    reader.size += chunk.length;
    reader.wake?.();
  });
  stream.once("end", () => {
    reader.ended = true;
    reader.wake?.();
  });
  stream.once("error", (error) => {
    reader.error = error;
    reader.wake?.();
  });
  stream.once("close", () => {
    reader.ended = true;
    reader.wake?.();
  });
  return reader;
}

/**
 * Wait for `length` bytes on `reader` and return them, splicing the remainder back into the queue.
 * Windows waiter-clear-before-reject behaviour kept per the finding: the wake callback is nulled
 * BEFORE the promise resolves or rejects, so a late data event cannot re-enter it after settlement.
 *
 * Rejection ordering: an `error` observed on the stream takes precedence over a natural `end`,
 * because the actual cause of the read failing is the pipe error, not the missing-bytes symptom.
 */
export function readBytes(reader, length) {
  return new Promise((resolveBytes, reject) => {
    const check = () => {
      if (reader.size >= length) {
        reader.wake = undefined;
        const bytes = Buffer.concat(reader.chunks);
        reader.chunks = [bytes.subarray(length)];
        reader.size = bytes.length - length;
        resolveBytes(bytes.subarray(0, length));
        return;
      }
      if (reader.error !== undefined) {
        reader.wake = undefined;
        reject(reader.error);
        return;
      }
      if (reader.ended) {
        reader.wake = undefined;
        reject(
          new Error(
            `native helper ended before producing bounded response (buffered=${String(reader.size)})`,
          ),
        );
      }
    };
    reader.wake = check;
    check();
  });
}

/**
 * Read one KRS1 response frame — 12-byte header (magic, version, kind, length) then the payload.
 * The 64-byte cap is deliberate: both supervisors only ever emit reap proofs shorter than that,
 * so a longer length is a protocol confusion this rejects rather than reads.
 */
// KEIKO-0690: keep the per-kind payload contract in one place. Both Windows and macOS
// supervisors emit the exact same three response kinds through the shared KRS1 codec:
//   kind 1 RESPONSE_LAUNCHED  → 0 bytes
//   kind 2 RESPONSE_REAPED    → exactly 8 bytes (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION excerpt)
//   kind 3 RESPONSE_ERROR     → exactly 2 bytes (little-endian error code)
// Confirmed against `enum response_kind` in native/runtime-supervisor/{windows,macos}/keiko_
// runtime_supervisor.c. A pre-fix short frame would drop past the `length <= 64` upper bound and
// throw ERR_OUT_OF_RANGE inside Buffer.readUInt32LE instead of producing a protocol assertion
// that names the observed length.
const EXPECTED_PAYLOAD_LENGTH_BY_KIND = new Map([
  [1, 0],
  [2, 8],
  [3, 2],
]);

export async function response(reader) {
  const responseHeader = await readBytes(reader, 12);
  assert.equal(responseHeader.subarray(0, 4).toString("ascii"), "KRS1");
  assert.equal(responseHeader.readUInt16LE(4), 1);
  const kind = responseHeader.readUInt16LE(6);
  const length = responseHeader.readUInt32LE(8);
  assert.ok(length <= 64);
  const expected = EXPECTED_PAYLOAD_LENGTH_BY_KIND.get(kind);
  assert.notEqual(
    expected,
    undefined,
    `unknown KRS1 response kind ${String(kind)} (length=${String(length)})`,
  );
  assert.equal(
    length,
    expected,
    `KRS1 response kind ${String(kind)} must carry ${String(expected)} bytes, observed ${String(length)}`,
  );
  return {
    kind,
    payload: length === 0 ? Buffer.alloc(0) : await readBytes(reader, length),
  };
}

// Poll budget for `waitForExit`: 200 attempts × 20 ms = 4 s. One documented value across both
// platforms (was 100/200 apart) — long enough for macOS Endpoint Security to observe the exit
// (the case that originally used 200), short enough that a stuck test fails inside a normal
// harness budget rather than dragging out to the outer deadline.
const EXIT_POLL_ATTEMPTS = 200;
const EXIT_POLL_INTERVAL_MS = 20;

/**
 * Poll until `pid` disappears. Exported as both `waitForExit` (Windows spelling) and `waitGone`
 * (macOS spelling); the two were the same function with different names and poll budgets.
 */
export async function waitForExit(pid) {
  for (let attempt = 0; attempt < EXIT_POLL_ATTEMPTS; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, EXIT_POLL_INTERVAL_MS));
  }
  throw new Error(
    `pid ${String(pid)} remained visible after ${String(EXIT_POLL_ATTEMPTS * EXIT_POLL_INTERVAL_MS)}ms`,
  );
}
export const waitGone = waitForExit;

/**
 * Diagnostic wrapper: race `promise` against the child's `exited` promise so a stream failure is
 * re-thrown labelled with which stage it happened in. Kept from the Windows harness (the audit's
 * SUPERVISOR-DIAGNOSTIC-001 preference) and exported so both harnesses attribute failures the
 * same way.
 *
 * Only the stderr BYTE COUNT is embedded in the thrown error, not the body. A broken or untrusted
 * helper could otherwise write arbitrary text (including secrets, path fragments, or attacker-
 * controlled diagnostic strings) that would end up in qualification and CI logs verbatim. The
 * count is enough to tell a "silent" failure apart from a diagnostic one; the actual bytes are
 * still on the child's stderr stream for a developer to inspect directly if needed, and the
 * success-path assertion `Buffer.concat(stderr).length === 0` still catches any non-empty stderr
 * on a well-formed run.
 */
export async function explained(stage, promise, exited, stderr) {
  const exitCode = Symbol("exited");
  // KEIKO-0850: neutralise `exited`'s rejection before the race — a rejected `exited` (child
  // spawn error, unusual exit sequence) used to reject the whole race and propagate the raw
  // error, dropping the stage annotation this wrapper exists to preserve. Map both settlement
  // paths of `exited` to a resolution with the `exitCode` marker so the race can never reject
  // through that leg. `promise.catch(...)` already handles the other leg.
  const neutralisedExited = exited.then(
    (code) => ({ [exitCode]: code }),
    (exitError) => ({ [exitCode]: `errored:${String(exitError?.code ?? exitError)}` }),
  );
  const raced = await Promise.race([
    promise.catch((error) => ({ error })),
    neutralisedExited,
  ]);
  if (raced && exitCode in raced) {
    const stderrBytes = Buffer.concat(stderr).length;
    throw new Error(
      `${stage}: helper exited with ${String(raced[exitCode])} before responding` +
        (stderrBytes > 0 ? ` (stderrBytes=${String(stderrBytes)})` : ""),
    );
  }
  if (raced && "error" in raced) {
    // Preserve the stage prefix the pre-KEIKO-0304 Windows wrapper carried: a helper that returns
    // a malformed frame without exiting rejects the response promise, and this branch used to
    // rethrow the raw error (`bad magic`) with no indication of WHICH stage was in flight. Prefix
    // the message in place so stack, cause, and error class survive (codex 3792824429 on #3202).
    const stderrBytes = Buffer.concat(stderr).length;
    const stderrSuffix = stderrBytes > 0 ? ` (helper stderrBytes=${String(stderrBytes)})` : "";
    raced.error.message = `${stage}: ${raced.error.message}${stderrSuffix}`;
    throw raced.error;
  }
  return raced;
}
