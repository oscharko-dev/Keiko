import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  "native/runtime-supervisor/macos/system-extension/keiko_system_extension_manager.m",
  "utf8",
);
const monitorSource = readFileSync(
  "native/runtime-supervisor/macos/system-extension/keiko_runtime_monitor.m",
  "utf8",
);
const supervisorSource = readFileSync(
  "native/runtime-supervisor/macos/keiko_runtime_supervisor.c",
  "utf8",
);
const protocolHarness = readFileSync("native/runtime-supervisor/macos/test-protocol.mjs", "utf8");

function methodBody(signature) {
  const start = source.indexOf(signature);
  if (start === -1) throw new Error(`missing Objective-C method: ${signature}`);
  const nextMethod = source.indexOf("\n- (", start + signature.length);
  return source.slice(start, nextMethod === -1 ? undefined : nextMethod);
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
    expect(monitorSource).toContain("sent == (ssize_t)sizeof(reply)");
    expect(monitorSource).toContain("shutdown(session->descriptor, SHUT_RDWR)");
    expect(monitorSource).toContain("session->descriptor < 0 && session->uid == uid");
    expect(monitorSource).toContain("KEIKO_MAX_CONNECTIONS");
    expect(monitorSource).toContain("reserve_connection()");
    expect(monitorSource).toContain("errno != EINTR && errno != ECONNABORTED");
  });

  it("terminates on monitor and poll failures and always reaps the protocol harness", () => {
    expect(supervisorSource).toContain("if (poll_result < 0)");
    expect(supervisorSource).toContain("if (errno == EINTR) continue;");
    expect(supervisorSource).toMatch(/KEIKO_MONITOR_ZERO_LIVE[\s\S]*else \{\s*return 0;/u);
    expect(protocolHarness).toContain("finally {");
    expect(protocolHarness).toContain('child.kill("SIGKILL")');
    expect(protocolHarness).toContain("await exited.catch");
  });
});
