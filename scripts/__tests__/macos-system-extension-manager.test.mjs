import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL(
    "../../native/runtime-supervisor/macos/system-extension/keiko_system_extension_manager.m",
    import.meta.url,
  ),
  "utf8",
);
const monitorSource = readFileSync(
  new URL(
    "../../native/runtime-supervisor/macos/system-extension/keiko_runtime_monitor.m",
    import.meta.url,
  ),
  "utf8",
);
// KEIKO-0261/0278: the macOS harness source (for its platform-independent contract pins) and the
// Windows harness source (for its lifecycle guards) are read as text, same as the .m/.c sources.
const macosProtocolHarness = readFileSync(
  new URL("../../native/runtime-supervisor/macos/test-protocol.mjs", import.meta.url),
  "utf8",
);
const windowsProtocolHarness = readFileSync(
  new URL("../../native/runtime-supervisor/test-protocol.mjs", import.meta.url),
  "utf8",
);
const supervisorSource = readFileSync(
  new URL("../../native/runtime-supervisor/macos/keiko_runtime_supervisor.c", import.meta.url),
  "utf8",
);
const protocolHarness = readFileSync(
  new URL("../../native/runtime-supervisor/macos/test-protocol.mjs", import.meta.url),
  "utf8",
);

function methodBody(signature) {
  const start = source.indexOf(signature);
  if (start === -1) throw new Error(`missing Objective-C method: ${signature}`);
  const nextMethod = source.indexOf("\n- (", start + signature.length);
  return source.slice(start, nextMethod === -1 ? undefined : nextMethod);
}

function functionBody(sourceText, signature) {
  const start = sourceText.indexOf(signature);
  if (start === -1) throw new Error(`missing function: ${signature}`);
  const open = sourceText.indexOf("{", start + signature.length);
  let depth = 0;
  for (let index = open; index < sourceText.length; index += 1) {
    if (sourceText[index] === "{") depth += 1;
    if (sourceText[index] === "}") depth -= 1;
    if (depth === 0) return sourceText.slice(start, index + 1);
  }
  throw new Error(`unterminated function: ${signature}`);
}

describe("macOS system-extension activation manager", () => {
  it("keeps approval pending without accepting an unbounded activation wait", () => {
    const approval = methodBody("- (void)requestNeedsUserApproval:");

    expect(approval).not.toContain("dispatch_semaphore_signal");
    expect(source).not.toContain("DISPATCH_TIME_FOREVER");
    expect(source).toContain("KEIKO_ACTIVATION_TIMEOUT_SECONDS");
    expect(source).toMatch(/dispatch_time\(\s*DISPATCH_TIME_NOW/u);
    expect(source).toContain("dispatch_semaphore_wait(delegate.completion, deadline) != 0");
  });

  it("opens Apple's documented Full Disk Access settings and waits for the monitor", () => {
    expect(source).toContain(
      "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles",
    );
    expect(source).toContain("KEIKO_MONITOR_NEEDS_FULL_DISK_ACCESS");
    expect(source).toContain("open_full_disk_access_settings");
    expect(source).toContain("wait_for_active_monitor");
    expect(source).toContain("attempt < KEIKO_MONITOR_ATTEMPTS");
  });

  it("keeps the monitor closed and retries until Full Disk Access is granted", () => {
    expect(monitorSource).toContain("ES_NEW_CLIENT_RESULT_ERR_NOT_PERMITTED");
    expect(monitorSource).toContain("set_endpoint_state(ENDPOINT_STATE_NEEDS_FULL_DISK_ACCESS);");
    expect(monitorSource).toContain("current_endpoint_state() != ENDPOINT_STATE_ACTIVE");
    expect(monitorSource).toContain("endpoint_state = ENDPOINT_STATE_ACTIVE;");
  });

  it("fails closed for monitor transport, ownership, and connection exhaustion", () => {
    const reply = functionBody(monitorSource, "static int reply_to(");
    const reserve = functionBody(monitorSource, "static int reserve_connection(");
    const connection = functionBody(monitorSource, "static void *serve_client(");
    const main = functionBody(monitorSource, "int main(");

    expect(reply).toContain("sent == (ssize_t)sizeof(reply)");
    expect(reply).toContain("shutdown(session->descriptor, SHUT_RDWR)");
    // KEIKO-0433 split the old single `session->descriptor < 0 && session->uid == uid` guard into
    // three outcomes. Both halves of that guard must survive the split: a session already owned by
    // a live connection is adopted by nobody, and an owner mismatch still fails.
    expect(connection).toContain("session->descriptor >= 0");
    expect(connection).toContain("session->uid != uid");
    expect(reserve).toContain("KEIKO_MAX_CONNECTIONS");
    expect(main).toContain("reserve_connection()");
    expect(main).toContain("errno != EINTR && errno != ECONNABORTED");
  });

  it("terminates on monitor and poll failures and always reaps the protocol harness", () => {
    const supervise = functionBody(supervisorSource, "static int supervise(");
    const qualify = functionBody(protocolHarness, "async function qualify(");

    expect(supervise).toContain("if (poll_result < 0)");
    expect(supervise).toContain("if (errno == EINTR) continue;");
    expect(supervise).toMatch(/KEIKO_MONITOR_ZERO_LIVE[\s\S]*else \{\s*return 0;/u);
    expect(qualify).toContain("finally {");
    expect(qualify).toContain('child.kill("SIGKILL")');
    expect(qualify).toContain("await exited.catch");
  });

  // KEIKO-0278: the pin above covered only the macOS `qualify`. The two Windows harness functions
  // had no finally at all — `assertControlEofFailsClosed` had no watchdog whatsoever — so a
  // supervisor that hangs on control EOF hung the entire native-quality lane instead of failing
  // with a named stage. Both are now pinned to the same three tokens.
  describe.each([["qualifyWindows"], ["assertControlEofFailsClosed"]])(
    "%s carries the harness lifecycle guard",
    (name) => {
      it("clears its deadline, SIGKILLs on an incomplete run, and awaits the exit", () => {
        const body = functionBody(windowsProtocolHarness, `async function ${name}(`);
        expect(body).toContain("finally {");
        expect(body).toContain("clearTimeout(deadline)");
        expect(body).toContain('child.kill("SIGKILL")');
        expect(body).toContain("await exited.catch");
      });
    },
  );

  // KEIKO-0261: fd 3 and fd 4 are the supervisor's control and response pipes. The qualification
  // fixture never touches them, so nothing behavioural observes the close — this source pin is the
  // only thing between that trust boundary and a silent deletion.
  it("pins the macOS fd-3/fd-4 close and the non-PATH spawn form", () => {
    // The harness writes these as regex literals, so the source text carries escaped parens.
    for (const descriptor of [3, 4]) {
      expect(macosProtocolHarness).toMatch(
        new RegExp(`posix_spawn_file_actions_addclose\\\\\\(&actions, ${String(descriptor)}`, "u"),
      );
    }
    // Codex 3793944200 on #3202 split the assertion regex from
    // `posix_spawnp|execvp|execlp|execvP` to `\bposix_spawnp\s*\(|\bexecvp\s*\(|\bexeclp\s*\(|
    // \bexecvP\s*\(` (word boundary + optional whitespace before `(`).
    //
    // Coderabbit 3794185716 + codex 3794202587 on #3202: anchor the pin to the
    // `assert.doesNotMatch(...)` block — a bare identifier in a nearby COMMENT would
    // otherwise satisfy the check and let the identifier be deleted from the assertion
    // itself. `[\s\S]*?` captures the full call including any trailing error-message
    // arguments (up to the closing `);`), so the extract remains robust if the harness
    // later grows a message parameter.
    const forbiddenCallAssertion = macosProtocolHarness.match(
      /assert\.doesNotMatch\(\s*codeAndLiteralsText,[\s\S]*?\);/u,
    );
    expect(forbiddenCallAssertion, "the assert.doesNotMatch block must be present").not.toBeNull();
    for (const name of ["posix_spawnp", "execvp", "execlp", "execvP"]) {
      expect(forbiddenCallAssertion[0]).toContain(name);
    }
    // The pins must sit ABOVE the darwin guard or they only run on macOS, which is where they are
    // least needed — the source contract is platform-independent by design.
    const guardAt = macosProtocolHarness.indexOf('process.platform === "darwin"');
    expect(macosProtocolHarness.indexOf("posix_spawn_file_actions_addclose")).toBeLessThan(guardAt);
  });

  // The pin above proves the HARNESS asserts it; this proves the assertion is currently true of the
  // supervisor it guards, so the pair cannot both drift into agreeing about nothing.
  it("keeps the supervisor's fd-3/fd-4 close and non-PATH spawn in place", () => {
    expect(supervisorSource).toContain("posix_spawn_file_actions_addclose(&actions, 3)");
    expect(supervisorSource).toContain("posix_spawn_file_actions_addclose(&actions, 4)");
    expect(supervisorSource).toMatch(/posix_spawn\(/u);
    expect(supervisorSource).not.toMatch(/posix_spawnp|execvp|execlp|execvP/u);
  });

  // KEIKO-0419: the daemon emitted no diagnostic output at all, so an Endpoint Security failure,
  // a Full-Disk-Access refusal and a kill-switch fan-out were equally invisible to an operator.
  describe("runtime monitor diagnostics (KEIKO-0419)", () => {
    it("logs through os_log under the documented subsystem", () => {
      expect(monitorSource).toContain("#include <os/log.h>");
      expect(monitorSource).toContain('os_log_create("com.oscharko.keiko.runtime-monitor"');
    });

    it("logs every endpoint state transition, including the one that bypasses the setter", () => {
      expect(functionBody(monitorSource, "static void set_endpoint_state(")).toContain("os_log(");
      // start_endpoint_security assigns ENDPOINT_STATE_ACTIVE directly under the lock rather than
      // through set_endpoint_state, so it needs its own line or the transition that matters most
      // would be the only silent one.
      expect(functionBody(monitorSource, "static void *start_endpoint_security(")).toContain(
        "os_log(",
      );
    });

    it("logs the kill-switch fan-out and the Endpoint Security failure branches", () => {
      expect(functionBody(monitorSource, "static void stop_session(")).toContain("os_log(");
      const endpoint = functionBody(monitorSource, "static void *start_endpoint_security(");
      expect(endpoint).toContain("es_new_client denied");
      expect(endpoint).toContain("es_subscribe failed");
      expect(functionBody(monitorSource, "static void *serve_client(")).toContain("os_log_error(");
    });

    it("keeps the per-event hot path free of logging", () => {
      // Logging every fork/exec/exit machine-wide would recreate the hot-path cost the O(n)-scan
      // finding warns about. Decision points only.
      expect(functionBody(monitorSource, "static void endpoint_event(")).not.toContain("os_log");
    });

    it("logs no process command lines, argv or environment", () => {
      for (const line of monitorSource.split("\n").filter((l) => l.includes("os_log"))) {
        expect(line).not.toMatch(/argv|environ|cmdline|executable->path/u);
      }
    });
  });

  // KEIKO-0450: every non-zero exit discarded its reason, including the NSError the OS supplied,
  // so three different operator actions all surfaced as one generic failure.
  describe("system extension manager diagnostics (KEIKO-0450)", () => {
    it("reports the OS-supplied reason instead of discarding the NSError", () => {
      expect(source).not.toContain("(void)error;");
      expect(source).toContain("error.localizedDescription.UTF8String");
    });

    it("distinguishes the three activation failure causes", () => {
      const activate = functionBody(source, "static int activate_extension(");
      const messages = [...activate.matchAll(/fprintf\(stderr,\s*\n?\s*"([^"]+)/gu)].map(
        (match) => match[1],
      );
      expect(messages.length).toBeGreaterThanOrEqual(3);
      expect(new Set(messages).size).toBe(messages.length);
    });

    it("writes nothing to stderr on the success paths", () => {
      // portable-macos-activation.ts requires result.stderr === "" on success; a diagnostic on a
      // success path would break that caller.
      const activate = functionBody(source, "static int activate_extension(");
      const successReturn = activate.slice(activate.lastIndexOf('puts("active")'));
      expect(successReturn).not.toContain("fprintf(stderr");
    });
  });

  // KEIKO-0283: an accepted connection that never wrote its handshake blocked serve_client's first
  // read forever while holding one of the 32 slots, so a stalled same-team peer could exhaust the
  // budget and lock out every ARM/RECONCILE — the kill-switch among them.
  describe("accepted connection handshake deadline (KEIKO-0283)", () => {
    it("bounds the pre-handshake read on every accepted descriptor", () => {
      const main = functionBody(monitorSource, "int main(");
      expect(main).toContain("SO_RCVTIMEO");
      expect(main).toContain("SO_SNDTIMEO");
      expect(main).toContain("KEIKO_HANDSHAKE_TIMEOUT_SECONDS");
      // Alongside SO_NOSIGPIPE, not instead of it.
      expect(main).toContain("SO_NOSIGPIPE");
    });

    it("restores blocking reads once the handshake is valid", () => {
      // The long-lived read after the handshake is the deliberate dead-man's switch for supervisor
      // liveness. Leaving a timeout on it would tear down healthy sessions every few seconds.
      const connection = functionBody(monitorSource, "static void *serve_client(");
      expect(connection).toMatch(
        /request_valid\(&request, peer\)[\s\S]*?struct timeval blocking = \{\.tv_sec = 0, \.tv_usec = 0\}/u,
      );
      expect(connection).toMatch(/blocking[\s\S]*?while \(read_exact\(descriptor/u);
    });
  });

  // KEIKO-0433: RECONCILE answered ZERO_LIVE both for "no such session" and for "already owned by
  // a live connection" — opposite situations demanding opposite caller responses.
  describe("reconcile outcome distinguishability (KEIKO-0433)", () => {
    it("appends the new response code without renumbering the wire protocol", () => {
      const protocol = readFileSync(
        new URL(
          "../../native/runtime-supervisor/macos/keiko_runtime_monitor_protocol.h",
          import.meta.url,
        ),
        "utf8",
      );
      expect(protocol).toContain("KEIKO_MONITOR_ALREADY_ACTIVE = 9");
      // Every pre-existing value keeps its number: reassigning one breaks already-built binaries.
      for (const [name, value] of [
        ["KEIKO_MONITOR_ACTIVE", 1],
        ["KEIKO_MONITOR_ARMED", 2],
        ["KEIKO_MONITOR_ROOT_OBSERVED", 3],
        ["KEIKO_MONITOR_ZERO_LIVE", 4],
        ["KEIKO_MONITOR_ERROR", 5],
        ["KEIKO_MONITOR_NEEDS_FULL_DISK_ACCESS", 6],
        ["KEIKO_MONITOR_STARTING", 7],
        ["KEIKO_MONITOR_FAILED", 8],
      ]) {
        expect(protocol).toContain(`${name} = ${String(value)}`);
      }
    });

    it("replies ALREADY_ACTIVE only for the live case and keeps ZERO_LIVE for unknown handles", () => {
      const connection = functionBody(monitorSource, "static void *serve_client(");
      expect(connection).toContain("RECONCILE_ALREADY_LIVE");
      expect(connection).toContain("KEIKO_MONITOR_ALREADY_ACTIVE");
      expect(connection).toContain("KEIKO_MONITOR_ZERO_LIVE");
      // An owner mismatch must stay indistinguishable from an unknown handle: telling a different
      // uid that the handle exists is an information leak, not a diagnostic.
      expect(connection).toMatch(/session->uid != uid[\s\S]{0,400}RECONCILE_UNKNOWN_HANDLE/u);
    });

    it("gives the supervisor its own branch instead of the generic observe error", () => {
      const reconcile = functionBody(supervisorSource, "static int reconcile(");
      expect(reconcile).toContain("KEIKO_MONITOR_ALREADY_ACTIVE");
      expect(reconcile).toContain("ERROR_TREE_ALREADY_SUPERVISED");
      expect(reconcile).toMatch(
        /KEIKO_MONITOR_ALREADY_ACTIVE[\s\S]{0,200}ERROR_TREE_ALREADY_SUPERVISED[\s\S]{0,200}ERROR_TREE_OBSERVE/u,
      );
    });
  });

  // KEIKO-0771: session_for_pid used to answer against the first session whose recorded
  // supervisor_pid matched the queried pid, so after an OS pid-number reuse the daemon could
  // misattribute a fork to a different session. allocate_session now refuses the ARM when
  // another active session already owns supervisor_pid, parallel to the existing recovery-
  // handle uniqueness rejection.
  describe("allocate_session supervisor_pid uniqueness (KEIKO-0771)", () => {
    it("refuses ARM when another active session already owns supervisor_pid", () => {
      const body = functionBody(monitorSource, "static struct monitor_session *allocate_session(");
      expect(body).toMatch(
        /existing->active[\s\S]{0,200}existing->supervisor_pid\s*==\s*\(pid_t\)request->supervisor_pid/u,
      );
      expect(body).toMatch(/return NULL;/u);
      const uniquenessGuardAt = body.search(/existing->supervisor_pid\s*==/u);
      const freeSlotAt = body.search(/session->active\)\s*continue;/u);
      expect(uniquenessGuardAt).toBeGreaterThan(-1);
      expect(freeSlotAt).toBeGreaterThan(-1);
      expect(uniquenessGuardAt).toBeLessThan(freeSlotAt);
    });
  });
});
