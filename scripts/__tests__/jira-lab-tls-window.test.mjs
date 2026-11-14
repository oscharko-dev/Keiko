// The certificate window of a lab run (#4369): an expired or nearly expired certificate is renewed
// by the owned session at an idle boundary; a sufficient one is left alone.
import { describe, expect, it, vi } from "vitest";
import { renewTlsWindow } from "../testing/jira-chat-lab/tls-window.mjs";

const session = { directory: "/private/session" };
const NEEDED = 3_301;

function ports({ before, after = before, exclusive } = {}) {
  let renewed = false;
  const remaining = vi.fn(() => {
    const value = renewed ? after : before;
    if (value === "invalid") throw new TypeError("Lab TLS identity is invalid");
    return value;
  });
  const restart = vi.fn(() => {
    renewed = true;
  });
  const run = vi.fn(async (_directory, stillNeeded, action) =>
    (await stillNeeded()) ? action() : undefined,
  );
  return { remaining, restart, exclusive: exclusive ?? run, log: vi.fn(), run };
}

describe("renewTlsWindow", () => {
  it("leaves a certificate with enough time alone and starts nothing", async () => {
    const p = ports({ before: 86_400 * 300 });
    expect(await renewTlsWindow(session, NEEDED, p)).toEqual({
      renewed: false,
      remainingBefore: 86_400 * 300,
      remainingAfter: 86_400 * 300,
    });
    expect(p.restart).not.toHaveBeenCalled();
    expect(p.run).not.toHaveBeenCalled();
  });

  it.each([
    ["expired", -100],
    ["nearly expired", 600],
    ["invalid", "invalid"],
  ])("renews an %s certificate through the owned session's own start", async (_name, before) => {
    const p = ports({ before, after: 86_400 * 365 });
    const result = await renewTlsWindow(session, NEEDED, p);
    expect(p.restart).toHaveBeenCalledExactlyOnceWith("/private/session");
    expect(result).toMatchObject({ renewed: true, remainingAfter: 86_400 * 365 });
    expect(JSON.parse(p.log.mock.calls[0][0])).toEqual({
      operation: "jira-lab-tls-window",
      renewed: true,
      sufficient: true,
    });
  });

  it("reports an insufficient window when the restart did not renew it", async () => {
    const p = ports({ before: -1, after: 5 });
    const result = await renewTlsWindow(session, NEEDED, p);
    expect(result).toMatchObject({ renewed: true, remainingAfter: 5 });
    expect(JSON.parse(p.log.mock.calls[0][0]).sufficient).toBe(false);
  });

  it("renews nothing when another lane already did, as the lock holder re-asks", async () => {
    let calls = 0;
    const remaining = vi.fn(() => (calls++ === 0 ? 10 : 86_400 * 365));
    const p = { ...ports({ before: 0 }), remaining };
    const result = await renewTlsWindow(session, NEEDED, p);
    expect(p.restart).not.toHaveBeenCalled();
    expect(result).toMatchObject({ renewed: false, remainingAfter: 86_400 * 365 });
  });

  it("does not hide a failed start", async () => {
    const p = ports({ before: -1 });
    p.restart.mockImplementation(() => {
      throw new TypeError("Laboratory session start failed");
    });
    await expect(renewTlsWindow(session, NEEDED, p)).rejects.toThrow("start failed");
  });
});
