import { describe, expect, it } from "vitest";
import {
  RECIPROCAL_ARGUMENTS as ARGS,
  reciprocalLinkFixture,
} from "../../../tests/support/jira-reciprocal-link-fixture.js";
import { executeJiraReciprocalRemoteLink as execute } from "./jira-managed-reciprocal-link.js";
import { checkReciprocalInput, reciprocalInputRefusal } from "./jira-reciprocal-link-values.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
const RECEIPT = {
  userKey: "synthetic-actor",
  issueId: "10001",
  issueKey: "SYN-1",
  applicationLinkId: "22222222-2222-4222-8222-222222222222",
  applicationLinkDestinationDigest: expect.stringMatching(/^[0-9a-f]{64}$/u) as string,
  selectedRemoteIssueId: "9223372036854775807",
  delegatedEffectRequested: true,
};
describe("one native delegated reciprocal link", () => {
  it("uses the primary-proven reversed source/target body and remains unconfirmed", async () => {
    const native = reciprocalLinkFixture();
    expect(await execute(ARGS, native.request, native.ports)).toMatchObject({
      ok: false,
      reason: "unavailable",
      receipt: { ...RECEIPT, linkId: "51" },
    });
    expect(native.calls.filter((call) => call.method !== "GET")).toHaveLength(1);
    expect(native.calls.filter((call) => call.path.includes("listApplicationlinks"))).toHaveLength(
      2,
    );
    expect(native.snapshot()).toEqual({ effects: 1, localLinkObserved: true });
  });
  it("checks fresh configuration, actor, local issue and complete local links without a write", async () => {
    const native = reciprocalLinkFixture();
    expect(await execute(ARGS, native.request, native.ports, true)).toEqual({
      ok: true,
      receipt: {},
    });
    expect(native.calls.every((call) => call.method === "GET")).toBe(true);
  });
  it.each(["configChanges", "manifestChanges", "actorChanged", "existing"] as const)(
    "refuses changed or conflicting prerequisite: %s",
    async (control) => {
      const native = reciprocalLinkFixture();
      native.controls[control] = true;
      expect(await execute(ARGS, native.request, native.ports)).toMatchObject({
        ok: false,
        reason: "conflict",
      });
      expect(native.calls.some((call) => call.method === "POST")).toBe(false);
    },
  );
  it("refuses an unconfigured/non-Jira destination and does not trust content as configuration", async () => {
    const native = reciprocalLinkFixture();
    native.application.typeId = "generic";
    expect(await execute(ARGS, native.request, native.ports)).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    native.application.typeId = "jira";
    native.row.hasOutgoingAuthenticationProviders = false;
    expect(await execute(ARGS, native.request, native.ports)).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    expect(native.calls.some((call) => call.method === "POST")).toBe(false);
  });
  it("retains selected remote context, but no guessed link ID, after a lost ACK", async () => {
    const native = reciprocalLinkFixture();
    native.controls.lostAck = true;
    expect(await execute(ARGS, native.request, native.ports)).toEqual({
      ok: false,
      reason: "timeout",
      receipt: RECEIPT,
    });
    expect(native.calls.at(-1)?.method).toBe("POST");
    expect(native.snapshot().effects).toBe(1);
  });
  it("does not confuse an empty local readback with remote rejection or no effect", async () => {
    const native = reciprocalLinkFixture();
    native.controls.omitLocalEffect = true;
    expect(await execute(ARGS, native.request, native.ports)).toMatchObject({
      ok: false,
      reason: "unavailable",
      receipt: RECEIPT,
    });
    expect(native.snapshot().effects).toBe(1);
  });
  it("keeps known context for a denied readback or acknowledged capture exception", async () => {
    const native = reciprocalLinkFixture();
    native.controls.denyReadback = true;
    expect(await execute(ARGS, native.request, native.ports)).toMatchObject({
      ok: false,
      reason: "permission-denied",
      receipt: RECEIPT,
    });
    const failed = reciprocalLinkFixture();
    failed.controls.throwReadback = true;
    try {
      await execute(ARGS, failed.request, failed.ports);
      expect.fail("Expected acknowledged exception");
    } catch (error) {
      expect(error).toBeInstanceOf(JiraAcknowledgedMutationError);
      if (!(error instanceof JiraAcknowledgedMutationError)) throw error;
      expect(error.receipt).toEqual(RECEIPT);
    }
  });
  it("refuses missing private configuration or explicit acceptance before any request", async () => {
    const native = reciprocalLinkFixture();
    expect(await execute(ARGS, native.request, undefined)).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    expect(
      await execute({ ...ARGS, acceptNativeDelegatedEffect: false }, native.request, native.ports),
    ).toMatchObject({ ok: false, reason: "field-validation" });
    expect(native.calls).toHaveLength(0);
  });
  it.each([
    "http://remote.example.invalid",
    "https://u:p@remote.example.invalid",
    "https://remote.example.invalid?x=1",
    "https://remote.example.invalid/#x",
    "https://remote.example.invalid/%252f",
  ])("refuses unsafe configured destination input %s", async (rpcUrl) => {
    const native = reciprocalLinkFixture();
    expect(
      await execute(
        { ...ARGS, expectedApplication: { ...ARGS.expectedApplication, rpcUrl } },
        native.request,
        native.ports,
      ),
    ).toMatchObject({ ok: false, reason: "field-validation" });
    expect(native.calls).toHaveLength(0);
  });
  // #4357 AC3: a refused reciprocal-link input names the rule the model must satisfy, one fixed
  // sentence per cause, pinned exactly and within the 200-byte bound of a detail message.
  it.each([
    [
      "another argument",
      { ...ARGS, headers: "x" },
      [
        "This call takes only expectedActorKey, expectedIssue, expectedApplication, remoteIssueId, remoteIssueTitle, sourceRelationship, targetRelationship, expectLocalLinkAbsent, acceptNativeDelegatedEffect.",
      ],
    ],
    [
      "an actor key that is not text",
      { ...ARGS, expectedActorKey: "" },
      [
        "expectedActorKey must be the key of the connected Jira user (non-blank, at most 255 characters); jira.myself returns it. Nothing was changed.",
      ],
    ],
    [
      "a missing acceptance",
      { ...ARGS, acceptNativeDelegatedEffect: false },
      [
        "Send expectLocalLinkAbsent:true and acceptNativeDelegatedEffect:true: the local link must not exist yet, and Jira performs the reciprocal effect itself. Nothing was changed.",
      ],
    ],
    [
      "an issue review of the wrong shape",
      { ...ARGS, expectedIssue: { id: "10001" } },
      [
        "expectedIssue must be the issue as reviewed: id, key, summary, projectId and issueTypeId, nothing else. Nothing was changed.",
      ],
    ],
    [
      "an unsafe application destination",
      { ...ARGS, expectedApplication: { ...ARGS.expectedApplication, rpcUrl: "http://x.invalid" } },
      [
        "expectedApplication must be the configured link: id (UUID), name (at most 255), displayUrl and rpcUrl (HTTPS, at most 2048, no credentials, query, fragment, whitespace or backslash).",
      ],
    ],
    [
      "a remote issue of the wrong shape",
      { ...ARGS, remoteIssueId: "not-a-number" },
      [
        "remoteIssueId must be a numeric ID; remoteIssueTitle, sourceRelationship and targetRelationship must be non-blank text of at most 255 characters. Nothing was changed.",
      ],
    ],
  ])("names the rule an input broke: %s", async (_name, args, messages) => {
    const native = reciprocalLinkFixture();
    expect(await execute(args, native.request, native.ports)).toEqual({
      ok: false,
      reason: "field-validation",
      detail: { validation: "invalid-field", messages },
    });
    expect(native.calls).toHaveLength(0);
    for (const message of messages)
      expect(new TextEncoder().encode(message).length).toBeLessThanOrEqual(200);
  });
  it("names the size rule from the same check the parser uses", () => {
    expect(checkReciprocalInput(ARGS, 10)).toEqual({ ok: false, cause: "size" });
    expect(reciprocalInputRefusal("size")).toEqual({
      ok: false,
      reason: "field-validation",
      detail: {
        validation: "invalid-field",
        messages: ["The arguments are larger than one call may carry. Nothing was changed."],
      },
    });
    expect(checkReciprocalInput(ARGS).ok).toBe(true);
  });
  // #4354: the saved issue templates stand in front of this write like every other write path; a
  // library that cannot be read refuses it before any request, in check and in execution.
  it.each([false, true])(
    "refuses before any write when the saved templates cannot be read, check=%s",
    async (check) => {
      const native = reciprocalLinkFixture();
      const refused = await execute(ARGS, native.request, native.ports, check, () => ({
        templates: [],
        unreadable: 1,
      }));
      expect(refused).toMatchObject({
        ok: false,
        reason: "field-validation",
        violations: [{ ruleId: "template-unreadable" }],
      });
      expect(native.calls.some((call) => call.method !== "GET")).toBe(false);
    },
  );
});

// #4357 AC3: before any request, a key that is not the connected user's is an argument to correct, as
// for remote links; the model is told where the key comes from, not that a reviewed user changed.
describe("an expectedActorKey that is not the connected user's, before the request", () => {
  const ACTOR_KEY_RULE =
    "expectedActorKey is not the key of the connected Jira user. It must be the key jira.myself returns: read it, then send the write again. Nothing was changed.";
  it.each([false, true])("says where the key comes from, check=%s", async (check) => {
    const native = reciprocalLinkFixture();
    native.controls.actorChanged = true;
    const refused = await execute(ARGS, native.request, native.ports, check);
    expect(refused).toMatchObject({
      ok: false,
      reason: "conflict",
      detail: { messages: [ACTOR_KEY_RULE] },
    });
    expect(JSON.stringify(refused)).not.toMatch(/reviewed user|replayed/u);
    expect(new TextEncoder().encode(ACTOR_KEY_RULE).length).toBeLessThanOrEqual(200);
    expect(native.calls.some((call) => call.method === "POST")).toBe(false);
  });
});
