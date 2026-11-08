import { describe, expect, it } from "vitest";
import { RECIPROCAL_ARGUMENTS as ARGS, reciprocalLinkFixture } from "../../../tests/support/jira-reciprocal-link-fixture.js";
import { executeJiraReciprocalRemoteLink as execute } from "./jira-managed-reciprocal-link.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
const RECEIPT = { userKey: "synthetic-actor", issueId: "10001", issueKey: "SYN-1",
  applicationLinkId: "22222222-2222-4222-8222-222222222222", applicationLinkDestinationDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
  selectedRemoteIssueId: "9223372036854775807", delegatedEffectRequested: true };
describe("one native delegated reciprocal link", () => {
  it("uses the primary-proven reversed source/target body and remains unconfirmed", async () => {
    const native = reciprocalLinkFixture();
    expect(await execute(ARGS, native.request, native.ports)).toMatchObject({ ok: false, reason: "unavailable", receipt: { ...RECEIPT, linkId: "51" } });
    expect(native.calls.filter((call) => call.method !== "GET")).toHaveLength(1);
    expect(native.calls.filter((call) => call.path.includes("listApplicationlinks"))).toHaveLength(2);
    expect(native.snapshot()).toEqual({ effects: 1, localLinkObserved: true });
  });
  it("checks fresh configuration, actor, local issue and complete local links without a write", async () => {
    const native = reciprocalLinkFixture();
    expect(await execute(ARGS, native.request, native.ports, true)).toEqual({ ok: true, receipt: {} });
    expect(native.calls.every((call) => call.method === "GET")).toBe(true);
  });
  it.each(["configChanges", "manifestChanges", "actorChanged", "existing"] as const)("refuses changed or conflicting prerequisite: %s", async (control) => {
    const native = reciprocalLinkFixture(); native.controls[control] = true;
    expect(await execute(ARGS, native.request, native.ports)).toMatchObject({ ok: false, reason: "conflict" });
    expect(native.calls.some((call) => call.method === "POST")).toBe(false);
  });
  it("refuses an unconfigured/non-Jira destination and does not trust content as configuration", async () => {
    const native = reciprocalLinkFixture(); native.application.typeId = "generic";
    expect(await execute(ARGS, native.request, native.ports)).toMatchObject({ ok: false, reason: "unavailable" });
    native.application.typeId = "jira"; native.row.hasOutgoingAuthenticationProviders = false;
    expect(await execute(ARGS, native.request, native.ports)).toMatchObject({ ok: false, reason: "unavailable" });
    expect(native.calls.some((call) => call.method === "POST")).toBe(false);
  });
  it("retains selected remote context, but no guessed link ID, after a lost ACK", async () => {
    const native = reciprocalLinkFixture(); native.controls.lostAck = true;
    expect(await execute(ARGS, native.request, native.ports)).toEqual({ ok: false, reason: "timeout", receipt: RECEIPT });
    expect(native.calls.at(-1)?.method).toBe("POST"); expect(native.snapshot().effects).toBe(1);
  });
  it("does not confuse an empty local readback with remote rejection or no effect", async () => {
    const native = reciprocalLinkFixture(); native.controls.omitLocalEffect = true;
    expect(await execute(ARGS, native.request, native.ports)).toMatchObject({ ok: false, reason: "unavailable", receipt: RECEIPT });
    expect(native.snapshot().effects).toBe(1);
  });
  it("keeps known context for a denied readback or acknowledged capture exception", async () => {
    const native = reciprocalLinkFixture(); native.controls.denyReadback = true;
    expect(await execute(ARGS, native.request, native.ports)).toMatchObject({ ok: false, reason: "permission-denied", receipt: RECEIPT });
    const failed = reciprocalLinkFixture(); failed.controls.throwReadback = true;
    try { await execute(ARGS, failed.request, failed.ports); expect.fail("Expected acknowledged exception"); }
    catch (error) { expect(error).toBeInstanceOf(JiraAcknowledgedMutationError); if (!(error instanceof JiraAcknowledgedMutationError)) throw error; expect(error.receipt).toEqual(RECEIPT); }
  });
  it("refuses missing private configuration or explicit acceptance before any request", async () => {
    const native = reciprocalLinkFixture();
    expect(await execute(ARGS, native.request, undefined)).toMatchObject({ ok: false, reason: "unavailable" });
    expect(await execute({ ...ARGS, acceptNativeDelegatedEffect: false }, native.request, native.ports)).toMatchObject({ ok: false, reason: "field-validation" });
    expect(native.calls).toHaveLength(0);
  });
  it.each(["http://remote.example.invalid", "https://u:p@remote.example.invalid", "https://remote.example.invalid?x=1", "https://remote.example.invalid/#x", "https://remote.example.invalid/%252f"])("refuses unsafe configured destination input %s", async (rpcUrl) => {
    const native = reciprocalLinkFixture();
    expect(await execute({ ...ARGS, expectedApplication: { ...ARGS.expectedApplication, rpcUrl } }, native.request, native.ports)).toMatchObject({ ok: false, reason: "field-validation" });
    expect(native.calls).toHaveLength(0);
  });
});
