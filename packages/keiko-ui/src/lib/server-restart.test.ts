import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "./client-diagnostics";
import {
  noteConnectedServerInstance,
  resetServerRestartStorageReport,
  sessionEndedByRestart,
} from "./server-restart";

const FIRST = "a".repeat(32);
const SECOND = "b".repeat(32);

function health(instanceId: string | undefined): void {
  vi.spyOn(api, "fetchHealth").mockResolvedValue({
    status: "ok",
    version: "1.0.0",
    ...(instanceId === undefined ? {} : { instanceId }),
  });
}

beforeEach(() => {
  resetServerRestartStorageReport();
  window.sessionStorage.clear();
  setClientDiagnosticWriter(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  resetClientDiagnosticWriter();
});

describe("recognizing that Keiko was restarted (#4370)", () => {
  it("reports a restart when the session is gone and the server instance changed", async () => {
    health(FIRST);
    await noteConnectedServerInstance();
    health(SECOND);
    await expect(sessionEndedByRestart()).resolves.toBe(true);
  });

  it("does not claim a restart when the instance is the same (an ordinary expiry)", async () => {
    health(FIRST);
    await noteConnectedServerInstance();
    await expect(sessionEndedByRestart()).resolves.toBe(false);
  });

  it("does not claim a restart for a tab that never saw a connected session", async () => {
    health(SECOND);
    await expect(sessionEndedByRestart()).resolves.toBe(false);
  });

  it.each([undefined, "not-an-instance", "A".repeat(32)])(
    "ignores an instance value that is not the closed shape: %s",
    async (value) => {
      health(FIRST);
      await noteConnectedServerInstance();
      health(value);
      await expect(sessionEndedByRestart()).resolves.toBe(false);
      await noteConnectedServerInstance();
      health(SECOND);
      await expect(sessionEndedByRestart()).resolves.toBe(true);
    },
  );

  it("makes no claim when health cannot be read, and records a body-free diagnostic", async () => {
    health(FIRST);
    await noteConnectedServerInstance();
    const writer = vi.fn();
    setClientDiagnosticWriter(writer);
    vi.spyOn(api, "fetchHealth").mockRejectedValue(new Error("offline"));
    await expect(sessionEndedByRestart()).resolves.toBe(false);
    expect(writer).toHaveBeenCalled();
    expect(JSON.stringify(writer.mock.calls)).not.toContain(FIRST);
  });

  it("makes no claim when tab storage is unavailable, and reports it once without a value", async () => {
    health(FIRST);
    const writer = vi.fn();
    setClientDiagnosticWriter(writer);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    await expect(noteConnectedServerInstance()).resolves.toBeUndefined();
    health(SECOND);
    await expect(sessionEndedByRestart()).resolves.toBe(false);
    await expect(noteConnectedServerInstance()).resolves.toBeUndefined();
    expect(writer).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(writer.mock.calls)).not.toContain(FIRST);
  });
});
