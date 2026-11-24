import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "./client-diagnostics";
import {
  notePageServerVersion,
  reloadIfServerVersionChanged,
  resetPageServerVersionForTests,
} from "./server-version-reload";

const messages: string[] = [];

function serverRuns(version: string): void {
  vi.spyOn(api, "fetchHealth").mockResolvedValue({ status: "ok", version });
}

beforeEach(() => {
  resetPageServerVersionForTests();
  messages.length = 0;
  setClientDiagnosticWriter((message) => {
    messages.push(message);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  resetClientDiagnosticWriter();
});

describe("reloading a tab that re-paired with a newer server build (#4103 F1)", () => {
  it("reloads once and reports it when the server version changed since the page loaded", async () => {
    notePageServerVersion("1.5.7");
    serverRuns("1.5.8");
    const reload = vi.fn();

    await expect(reloadIfServerVersionChanged(reload)).resolves.toBe(true);

    expect(reload).toHaveBeenCalledOnce();
    expect(messages).toEqual([
      "The server version changed since this page loaded; reloading the page.",
    ]);
  });

  it("keeps the page when the server still runs the version it loaded with", async () => {
    notePageServerVersion("1.5.8");
    serverRuns("1.5.8");
    const reload = vi.fn();

    await expect(reloadIfServerVersionChanged(reload)).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("keeps the first version it saw, so a later health read cannot hide the upgrade", async () => {
    notePageServerVersion("1.5.7");
    notePageServerVersion("1.5.8");
    serverRuns("1.5.8");
    const reload = vi.fn();

    await expect(reloadIfServerVersionChanged(reload)).resolves.toBe(true);
  });

  it.each([undefined, "", 7])(
    "never reloads or reads health when the page saw no usable version (%s)",
    async (version) => {
      notePageServerVersion(version);
      const read = vi.spyOn(api, "fetchHealth");
      const reload = vi.fn();

      await expect(reloadIfServerVersionChanged(reload)).resolves.toBe(false);
      expect(read).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
    },
  );

  it("never reloads on an empty current version", async () => {
    notePageServerVersion("1.5.7");
    serverRuns("");
    const reload = vi.fn();

    await expect(reloadIfServerVersionChanged(reload)).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("reports an unreadable version and keeps the page", async () => {
    notePageServerVersion("1.5.7");
    vi.spyOn(api, "fetchHealth").mockRejectedValue(new TypeError("Failed to fetch"));
    const reload = vi.fn();

    await expect(reloadIfServerVersionChanged(reload)).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(messages).toEqual(["Server version could not be read after a re-pair."]);
  });
});
