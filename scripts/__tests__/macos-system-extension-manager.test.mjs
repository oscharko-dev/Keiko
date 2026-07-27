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

function methodBody(signature) {
  const start = source.indexOf(signature);
  if (start === -1) throw new Error(`missing Objective-C method: ${signature}`);
  const nextMethod = source.indexOf("\n- (", start + signature.length);
  return source.slice(start, nextMethod === -1 ? undefined : nextMethod);
}

describe("macOS system-extension activation manager", () => {
  it("keeps an approval-gated activation request alive until Apple completes it", () => {
    const approval = methodBody("- (void)requestNeedsUserApproval:");

    expect(approval).not.toContain("dispatch_semaphore_signal");
    expect(source).toContain("DISPATCH_TIME_FOREVER");
  });

  it("opens Apple's documented Full Disk Access settings and waits for the monitor", () => {
    expect(source).toContain(
      "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles",
    );
    expect(source).toContain("KEIKO_MONITOR_NEEDS_FULL_DISK_ACCESS");
    expect(source).toContain("open_full_disk_access_settings");
    expect(source).toContain("wait_for_active_monitor");
  });

  it("keeps the monitor closed and retries until Full Disk Access is granted", () => {
    expect(monitorSource).toContain("ES_NEW_CLIENT_RESULT_ERR_NOT_PERMITTED");
    expect(monitorSource).toContain("set_endpoint_state(ENDPOINT_STATE_NEEDS_FULL_DISK_ACCESS);");
    expect(monitorSource).toContain("current_endpoint_state() != ENDPOINT_STATE_ACTIVE");
    expect(monitorSource).toContain("endpoint_state = ENDPOINT_STATE_ACTIVE;");
  });
});
