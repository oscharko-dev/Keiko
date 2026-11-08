import { describe, expect, it } from "vitest";
import { prepareJiraHumanInputReview as prepare } from "./jira-human-input-review.js";
import { scriptedJiraMutationRequest } from "./jira-test-request/_support.js";
import { copyHumanInputBinding, humanInputRequestId, humanInputView } from "./jira-human-input-values.js";
import { privateJiraCustodyFixture } from "../../../tests/support/jira-private-custody-fixture.js";
import { anonymizationUnlockFixture } from "../../../tests/support/jira-anonymization-unlock-fixture.js";

const BASE = "https://jira.example.invalid/engineering";
const ACTOR = { key: "actor-key", name: "actor-name" };
const TARGET = { key: "target-key", name: "target-name" };
const OBSERVED_ACTOR = { ok: true, status: 200, body: ACTOR } as const;
const OBSERVED_TARGET = { ok: true, status: 200, body: TARGET } as const;
const ARGS = { expectedActorKey: ACTOR.key, user: TARGET };

describe("human-input destination and target evidence", () => {
  it("binds both native target selectors and retains only the credential destination and identity facts", async () => {
    const request = scriptedJiraMutationRequest([OBSERVED_ACTOR, OBSERVED_TARGET, OBSERVED_TARGET]);
    expect(await prepare("update-user-password", ARGS, BASE, request)).toEqual({
      jiraBaseUrl: BASE, actorUserKey: ACTOR.key, actorUsername: ACTOR.name,
      targetKind: "user", targetUserKey: TARGET.key, targetUsername: TARGET.name,
    });
    expect(request.mock.calls).toEqual([
      ["myself", "GET", undefined, "json"],
      ["user?username=target-name", "GET", undefined, "json"],
      ["user?key=target-key", "GET", undefined, "json"],
    ]);
  });
  it.each([
    { ok: true, status: 200, body: { ...TARGET, key: "another-directory-key" } },
    { ok: true, status: 200, body: { ...TARGET, name: "renamed-target" } },
    { ok: true, status: 200, body: { ...TARGET, deleted: true } },
    { ok: false, reason: "permission-denied", httpStatus: 403 },
  ] as const)("does not request human input after native target mismatch or refusal %#", async (changed) => {
    const request = scriptedJiraMutationRequest([OBSERVED_ACTOR, OBSERVED_TARGET, changed]);
    expect(await prepare("update-user-password", ARGS, BASE, request)).toBeUndefined();
    expect(request.mock.calls.every(([, method]) => method === "GET")).toBe(true);
  });
  it("cannot substitute a model URL or an unsafe credential destination", async () => {
    const request = scriptedJiraMutationRequest([]);
    expect(await prepare("update-user-password", { ...ARGS, jiraBaseUrl: "https://foreign.invalid" }, BASE, request)).toBeUndefined();
    for (const unsafe of ["https://user:secret@jira.example.invalid", "https://jira.example.invalid/?token=value", "http://jira.example.invalid", "https://jira.example.invalid/../other"])
      expect(await prepare("update-user-password", ARGS, unsafe, request)).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });
  it("keeps proposed creation and license validation distinct from observed target accounts", async () => {
    const request = scriptedJiraMutationRequest([OBSERVED_ACTOR, OBSERVED_ACTOR]);
    expect(await prepare("validate-create-user-password", { expectedActorKey: ACTOR.key,
      username: "proposed", displayName: "Proposed account", emailAddress: "proposed@example.invalid" }, BASE, request))
      .toMatchObject({ targetKind: "proposed-user", targetUsername: "proposed" });
    const license = await prepare("validate-license", { expectedActorKey: ACTOR.key }, BASE, request);
    expect(license).toMatchObject({ targetKind: "instance" });
    expect(license).not.toHaveProperty("targetUsername");
    expect(request.mock.calls.map(([path]) => path)).toEqual(["myself", "myself"]);
  });
  it("requires self-password and login targets to remain the observed connected actor", async () => {
    const self = scriptedJiraMutationRequest([OBSERVED_ACTOR,
      { ...OBSERVED_TARGET, body: { key: ACTOR.key, name: TARGET.name } },
      { ...OBSERVED_TARGET, body: { key: ACTOR.key, name: TARGET.name } }]);
    expect(await prepare("update-my-password", { expectedActorKey: ACTOR.key, user: { key: ACTOR.key, name: TARGET.name } }, BASE, self)).toBeUndefined();
    const login = scriptedJiraMutationRequest([OBSERVED_ACTOR]);
    expect(await prepare("login", { expectedActorKey: ACTOR.key }, BASE, login)).toMatchObject({
      targetKind: "user", targetUserKey: ACTOR.key, targetUsername: ACTOR.name,
    });
  });
  it("takes the unlock node from a fresh exact native task and refuses changed owners", async () => {
    const f = anonymizationUnlockFixture();
    expect(await prepare("unlock-user-anonymization", f.args, BASE, f.request)).toMatchObject({
      targetKind: "anonymization-task", targetUserKey: "anonymized-target", executingNode: "native-owner-node",
    });
    f.progress.executingNode = "another-owner";
    expect(await prepare("unlock-user-anonymization", f.args, BASE, f.request)).toBeUndefined();
    expect(f.effects).toEqual([]);
  });
  it("binds destination and target evidence into the private request identity and persisted public view", async () => {
    const fixture = privateJiraCustodyFixture("jira.login");
    const request = scriptedJiraMutationRequest([{ ...OBSERVED_ACTOR, body: { key: fixture.binding.actorUserKey, name: fixture.binding.actorUsername } }]);
    const review = await prepare("login", { expectedActorKey: fixture.binding.actorUserKey }, BASE, request);
    const bound = copyHumanInputBinding({ ...fixture.binding, review });
    expect(bound).toBeDefined(); if (bound === undefined) throw new TypeError("Expected reviewed binding");
    expect(humanInputRequestId(bound)).not.toBe(humanInputRequestId(fixture.binding));
    expect(Object.isFrozen(bound.review)).toBe(true);
    const view = humanInputView({ schemaVersion: 1, kind: "jira-operation-input", binding: bound,
      requestId: humanInputRequestId(bound), revision: "7765d9e4-fc9a-46d5-aea4-24880fec5e1e", state: "awaiting-input" });
    expect(view.review).toEqual(review);
    expect(copyHumanInputBinding({ ...bound, actorUsername: "another-actor" })).toBeUndefined();
    expect(copyHumanInputBinding({ ...fixture.binding, review: undefined })).toBeUndefined();
  });
});
