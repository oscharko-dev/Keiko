import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prepareLabRun } from "../testing/jira-chat-lab/run-preflight.mjs";
import { DEFAULT_LAB_CONNECTION } from "../testing/jira-chat-lab/lab-client.mjs";
const { native, window, token, tls, renewTls } = vi.hoisted(() => ({
  native: vi.fn(),
  window: vi.fn(),
  token: vi.fn(),
  tls: vi.fn(),
  renewTls: vi.fn(),
}));
vi.mock("../testing/jira-chat-lab/lab-client.mjs", async (original) => ({
  ...(await original()),
  labRequest: native,
  basicAuth: () => "Basic synthetic",
}));
vi.mock("../testing/jira-chat-lab/requirements/license-window.mjs", () => ({
  ensureLicenseWindow: window,
}));
vi.mock("../testing/jira-chat-lab/fixture-tokens.mjs", () => ({ ensureFixtureToken: token }));
vi.mock("../testing/jira-chat-lab/tls-front.mjs", () => ({ labTlsRemainingSeconds: tls }));
vi.mock("../testing/jira-chat-lab/tls-window.mjs", () => ({ renewTlsWindow: renewTls }));
const roots = [];
beforeEach(() => {
  native.mockResolvedValue({
    status: 200,
    value: { version: "10.3.26", versionNumbers: [10, 3, 26], deploymentType: "Data Center" },
  });
  window.mockResolvedValue(9000);
  token.mockResolvedValue("Bearer synthetic");
  tls.mockReturnValue(9000);
  renewTls.mockResolvedValue({ renewed: false, remainingBefore: 9000, remainingAfter: 9000 });
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "jira-run-preflight-"));
  roots.push(directory);
  mkdirSync(join(directory, "secrets"), { mode: 0o700 });
  writeFileSync(join(directory, "secrets", "api-token"), "synthetic", { mode: 0o600 });
  return {
    ...DEFAULT_LAB_CONNECTION,
    directory,
    project: "keiko-jira-4081-preflight",
    schemaVersion: 1,
    syntheticOnly: true,
  };
}
it("checks native release, obtains the existing license window and renews only seeded PAT actors before the run", async () => {
  const session = fixture();
  const listeners = process.listenerCount("exit");
  const release = await prepareLabRun(session);
  expect(window).toHaveBeenCalledWith(session, session.directory, 3000);
  expect(token).toHaveBeenCalledExactlyOnceWith(session, "api", 43_200);
  expect(native.mock.invocationCallOrder[0]).toBeLessThan(window.mock.invocationCallOrder[0]);
  expect(window.mock.invocationCallOrder[0]).toBeLessThan(token.mock.invocationCallOrder[0]);
  release();
  release();
  expect(process.listenerCount("exit")).toBe(listeners);
  expect(readdirSync(join(session.directory, "lanes"))).toEqual([]);
});
it("refuses a mismatched native release without renewing a license or a PAT", async () => {
  const session = fixture();
  native.mockResolvedValue({
    status: 200,
    value: { version: "11.3.13", versionNumbers: [11, 3, 13], deploymentType: "Data Center" },
  });
  await expect(prepareLabRun(session)).rejects.toThrow(TypeError);
  expect(window).not.toHaveBeenCalled();
  expect(token).not.toHaveBeenCalled();
  expect(readdirSync(join(session.directory, "lanes"))).toEqual([]);
});
it("requires a TLS window that outlasts the run before any network or renewal", async () => {
  tls.mockReturnValue(2900);
  await expect(prepareLabRun(fixture())).rejects.toThrow(TypeError);
  expect(native).not.toHaveBeenCalled();
  expect(window).not.toHaveBeenCalled();
});
it("renews an expired certificate itself before any Jira request, and then runs", async () => {
  tls.mockReturnValue(-5);
  renewTls.mockImplementation(async () => {
    tls.mockReturnValue(31_536_000);
    return { renewed: true };
  });
  const release = await prepareLabRun(fixture());
  expect(renewTls).toHaveBeenCalledOnce();
  expect(renewTls.mock.invocationCallOrder[0]).toBeLessThan(native.mock.invocationCallOrder[0]);
  expect(window).toHaveBeenCalled();
  release();
});

it("still withholds the run when the renewal did not give the run a certificate window", async () => {
  tls.mockReturnValue(10);
  await expect(prepareLabRun(fixture())).rejects.toThrow(TypeError);
  expect(renewTls).toHaveBeenCalledOnce();
  expect(native).not.toHaveBeenCalled();
  expect(window).not.toHaveBeenCalled();
  expect(token).not.toHaveBeenCalled();
});

it("withholds the run when the certificate renewal itself fails", async () => {
  tls.mockReturnValue(10);
  renewTls.mockRejectedValue(new TypeError("Laboratory session start failed"));
  await expect(prepareLabRun(fixture())).rejects.toThrow(TypeError);
  expect(native).not.toHaveBeenCalled();
});

it.each(["license", "token"])(
  "cleans up its lane and withholds the run when %s renewal fails",
  async (source) => {
    const session = fixture();
    (source === "license" ? window : token).mockRejectedValue(new TypeError("Synthetic refusal"));
    await expect(prepareLabRun(session)).rejects.toThrow(TypeError);
    expect(readdirSync(join(session.directory, "lanes"))).toEqual([]);
    if (source === "license") expect(token).not.toHaveBeenCalled();
  },
);
it.each([0, -1, NaN, 6901])(
  "refuses invalid run windows before any effects: %s",
  async (seconds) => {
    await expect(prepareLabRun(fixture(), seconds)).rejects.toThrow(TypeError);
    expect(native).not.toHaveBeenCalled();
    expect(window).not.toHaveBeenCalled();
  },
);
