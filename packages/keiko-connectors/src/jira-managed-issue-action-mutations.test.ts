import { describe, expect, it } from "vitest";
import { ISSUE_ACTION_BASE_URL as BASE, ISSUE_ACTION_FIXTURE_CASES as CASES, ISSUE_ACTION_USER as USER, issueActionFixture } from "../../../tests/support/jira-issue-action-fixture.js";
import { executeJiraIssueActionMutation as execute } from "./jira-managed-issue-action-mutations.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";

const pin = CASES[0]; const notify = CASES[1];
describe("native issue pin and explicit email request", () => {
  it.each(CASES)("sends one independently expected $name effect", async ({ name, args, method, path, body, confirmed, receipt }) => {
    const f = issueActionFixture(); const result = await execute(name, structuredClone(args), f.request, false, BASE);
    expect(f.calls.filter((call) => call.method !== "GET")).toEqual([{ path, method, body, expect: "none" }]);
    expect(result.ok).toBe(confirmed);
    expect(result.receipt).toEqual(receipt);
  });
  it.each(CASES)("preflights $name without sending or pinning", async ({ name, args }) => {
    const f = issueActionFixture();
    expect(await execute(name, structuredClone(args), f.request, true, BASE)).toEqual({ ok: true, receipt: {} });
    expect(f.effects()).toBe(0); expect(f.controls.pinned).toBe(false);
  });
  it.each(CASES)("retains known $name targets after lost ACK without replay or guessed readback", async ({ name, args }) => {
    const f = issueActionFixture(); f.controls.lostAck = true;
    expect(await execute(name, structuredClone(args), f.request, false, BASE)).toMatchObject({ ok: false, reason: "timeout", receipt: { issueId: "10001", issueKey: "SYN-1" } });
    expect(f.effects()).toBe(1); expect(f.calls.at(-1)?.method).not.toBe("GET");
  });
  it("never treats queued acknowledgement as delivered email or a safe resend", async () => {
    const f = issueActionFixture(); const result = await execute(notify.name, structuredClone(notify.args), f.request, false, BASE);
    expect(result).toMatchObject({ ok: false, reason: "unavailable", receipt: { recipientUserKeys: [USER.key], notificationDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) } });
    expect(JSON.stringify(result.receipt)).not.toContain(notify.args.textBody);
    expect(JSON.stringify(result.receipt)).not.toContain(USER.name);
    expect(f.effects()).toBe(1);
  });
  it("independently binds recipient key and username before using the native username field", async () => {
    const f = issueActionFixture(); await execute(notify.name, structuredClone(notify.args), f.request, false, BASE);
    expect(f.calls.map((call) => call.path)).toContain("user?username=Recipient+User");
    expect(f.calls.map((call) => call.path)).toContain("user?key=recipient-key");
    const wrong = issueActionFixture(); wrong.controls.aliasUser = true;
    expect(await execute(notify.name, structuredClone(notify.args), wrong.request, false, BASE)).toMatchObject({ ok: false });
    expect(wrong.effects()).toBe(0);
  });
  it.each(["permission-denied", "not-found"] as const)("preserves native %s without claiming successful delivery", async (reason) => {
    const f = issueActionFixture(); f.controls.nativeRefusal = reason;
    expect(await execute(notify.name, structuredClone(notify.args), f.request, false, BASE)).toMatchObject({ ok: false, reason });
    expect(f.effects()).toBe(1);
  });
  it("pins the exact int64 comment and confirms the unchanged same-parent comment independently", async () => {
    const f = issueActionFixture();
    expect(await execute(pin.name, structuredClone(pin.args), f.request, false, BASE)).toEqual({ ok: true, receipt: pin.receipt });
    expect(f.calls.filter((call) => call.path.endsWith("/pinned-comments"))).toHaveLength(2);
    expect(f.calls.filter((call) => call.method === "PUT")[0]?.body).toBe(true);
  });
  it("refuses a pre-effect no-op for an already observed exact pin", async () => {
    const f = issueActionFixture(); f.controls.pinned = true;
    expect(await execute(pin.name, structuredClone(pin.args), f.request, false, BASE)).toMatchObject({ ok: false, reason: "conflict", detail: { unchanged: true }, receipt: pin.receipt });
    expect(f.effects()).toBe(0);
  });
  it.each(["body", "visibility", "issue-id", "comment-parent"] as const)("refuses changed reviewed %s before pinning", async (change) => {
    const f = issueActionFixture();
    if (change === "body") f.comment.body = "Different content";
    if (change === "visibility") f.comment.visibility = { type: "group", value: "Restricted" };
    if (change === "issue-id") f.issue.id = "10002";
    if (change === "comment-parent") f.comment.self = `${BASE}/rest/api/2/issue/10002/comment/9007199254740993`;
    expect(await execute(pin.name, structuredClone(pin.args), f.request, false, BASE)).toMatchObject({ ok: false });
    expect(f.effects()).toBe(0);
  });
  it("retains pin uncertainty after denied/malformed/missing independent readback", async () => {
    for (const flag of ["denyReadback", "wrongReadback"] as const) {
      const f = issueActionFixture(); f.controls[flag] = true;
      expect(await execute(pin.name, structuredClone(pin.args), f.request, false, BASE)).toMatchObject({ ok: false, receipt: pin.receipt });
      expect(f.effects()).toBe(1);
    }
    const malformed = issueActionFixture(); malformed.controls.malformedPinned = true;
    expect(await execute(pin.name, structuredClone(pin.args), malformed.request, false, BASE)).toMatchObject({ ok: false });
    expect(malformed.effects()).toBe(0);
  });
  it("preserves original post-ACK fault and frozen known pin receipt", async () => {
    const f = issueActionFixture(); f.controls.throwReadback = true; let observed: unknown;
    try { await execute(pin.name, structuredClone(pin.args), f.request, false, BASE); } catch (error) { observed = error; }
    expect(observed).toBeInstanceOf(JiraAcknowledgedMutationError);
    if (!(observed instanceof JiraAcknowledgedMutationError)) throw new TypeError("Expected acknowledged fault");
    expect(observed.cause).toBeInstanceOf(TypeError); expect(observed.receipt).toEqual(pin.receipt);
    expect(Object.isFrozen(observed.receipt)).toBe(true); expect(f.effects()).toBe(1);
  });
  it("snapshots selected recipients before an asynchronous identity lookup", async () => {
    const f = issueActionFixture(); const selected = [{ ...USER }];
    const request: typeof f.request = async (...args) => {
      if (args[0] === "myself") selected[0] = { key: "foreign-key", name: "Foreign User" };
      return f.request(...args);
    };
    await execute(notify.name, { ...notify.args, users: selected }, request, false, BASE);
    expect(f.calls.find((call) => call.method === "POST")?.body).toEqual(notify.body);
  });
  it.each([
    { ...notify.args, confirmEmailSend: false },
    { ...notify.args, subject: "injected\nsubject" },
    { ...notify.args, users: [{ ...USER, emailAddress: "raw@example.invalid" }] },
    { ...notify.args, htmlBody: "<b>unsupported</b>" },
    { ...notify.args, users: [USER, USER] },
    { ...pin.args, expectedVisibility: null },
    { ...pin.args, pinned: false },
  ])("refuses unsupported or incomplete actions before requests", async (args) => {
    const f = issueActionFixture(); const operation = "commentId" in args ? pin.name : notify.name;
    expect(await execute(operation, args, f.request, false, BASE)).toMatchObject({ ok: false, reason: "field-validation" });
    expect(f.calls).toEqual([]);
  });
});
