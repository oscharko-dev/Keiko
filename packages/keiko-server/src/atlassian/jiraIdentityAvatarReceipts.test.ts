import { describe, expect, it } from "vitest";
import {
  JIRA_ATTACHMENT_MAX_BYTES,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { IDENTITY_MUTATION_FIXTURE_CASES } from "../../../../tests/support/jira-identity-mutation-fixture.js";
import {
  JIRA_IDENTITY_AVATAR_RECEIPTS,
  validJiraIdentityAvatarReceipt,
  type JiraIdentityAvatarOperation,
} from "./jiraIdentityAvatarReceipts.js";
import { validJiraMutationAttempt } from "./jiraMutationResult.js";

const ACTOR = { actorUserKey: "actor" };
const FILE = { uploadSha256: "3".repeat(64), uploadBytes: 8 };
const PROJECT = {
  ...ACTOR,
  avatarType: "project",
  projectId: "9223372036854775807",
  projectKey: "SYN",
} as const;
const USER = { ...ACTOR, avatarType: "user", userKey: "target-key" } as const;
const TYPE = { ...ACTOR, avatarType: "issuetype", issueTypeId: "7" } as const;
const GENERIC = { ...ACTOR, avatarType: "user" } as const;
const CASES = [
  ...IDENTITY_MUTATION_FIXTURE_CASES,
  { name: "jira.upload-temporary-avatar", receipt: { ...GENERIC, ...FILE, temporaryAvatar: true } },
  { name: "jira.crop-temporary-avatar", receipt: { ...GENERIC, ...FILE, temporaryAvatar: true } },
  { name: "jira.upload-issue-type-avatar", receipt: { ...TYPE, ...FILE, temporaryAvatar: true } },
  {
    name: "jira.create-issue-type-avatar",
    receipt: { ...TYPE, ...FILE, avatarPresent: true, avatarId: "9" },
  },
  { name: "jira.upload-project-avatar", receipt: { ...PROJECT, ...FILE, temporaryAvatar: true } },
  {
    name: "jira.create-project-avatar",
    receipt: { ...PROJECT, ...FILE, avatarPresent: true, avatarId: "9" },
  },
  { name: "jira.set-project-avatar", receipt: { ...PROJECT, avatarId: "9", avatarSelected: true } },
  {
    name: "jira.delete-project-avatar",
    receipt: { ...PROJECT, avatarId: "9", avatarPresent: false },
  },
  { name: "jira.upload-owned-avatar", receipt: { ...TYPE, ...FILE, temporaryAvatar: true } },
  {
    name: "jira.create-owned-avatar",
    receipt: { ...TYPE, ...FILE, avatarPresent: true, avatarId: "9" },
  },
  { name: "jira.delete-owned-avatar", receipt: { ...TYPE, avatarId: "9", avatarPresent: false } },
  { name: "jira.upload-user-avatar", receipt: { ...USER, ...FILE, temporaryAvatar: true } },
  {
    name: "jira.create-user-avatar",
    receipt: { ...USER, ...FILE, avatarPresent: true, avatarId: "9" },
  },
  { name: "jira.set-user-avatar", receipt: { ...USER, avatarId: "9", avatarSelected: true } },
  { name: "jira.delete-user-avatar", receipt: { ...USER, avatarId: "9", avatarPresent: false } },
] as const satisfies readonly {
  readonly name: JiraIdentityAvatarOperation;
  readonly receipt: JiraMutationReceipt;
}[];
const CONFIRMABLE = new Set<string>([
  "jira.update-user",
  "jira.set-project-avatar",
  "jira.set-user-avatar",
]);

describe("strict identity and avatar receipts", () => {
  it("pins all twenty-one exact current identities", () => {
    expect(CASES.map(({ name }) => name).sort()).toEqual(
      Object.keys(JIRA_IDENTITY_AVATAR_RECEIPTS).sort(),
    );
  });
  it.each(CASES)(
    "retains $name context with its actual confirmation boundary",
    ({ name, receipt }) => {
      expect(validJiraIdentityAvatarReceipt(receipt, name)).toBe(true);
      const result = validJiraMutationAttempt({ ok: true, receipt }, name);
      expect(result.ok).toBe(CONFIRMABLE.has(name));
      expect(result.receipt).toEqual(receipt);
      expect(
        validJiraMutationAttempt({ ok: false, reason: "timeout", receipt }, name),
      ).toMatchObject({ ok: false, receipt });
      expect(
        validJiraIdentityAvatarReceipt({ ...receipt, browseUrl: "https://foreign.invalid" }, name),
      ).toBe(false);
    },
  );
  it.each(CASES)(
    "rejects hostile original own-property evidence for $name",
    ({ name, receipt }) => {
      let reads = 0;
      const inherited: JiraMutationReceipt = Object.create(receipt) as JiraMutationReceipt;
      const getter = Object.defineProperty({ ...receipt }, "actorUserKey", {
        enumerable: true,
        get: () => {
          reads++;
          return "actor";
        },
      });
      for (const bad of [
        inherited,
        getter,
        { ...receipt, [Symbol("unexpected")]: true },
        Object.defineProperty({ ...receipt }, "hidden", { value: true }),
      ]) {
        expect(validJiraMutationAttempt({ ok: true, receipt: bad }, name)).toEqual({
          ok: false,
          reason: "malformed-payload",
        });
        expect(
          validJiraMutationAttempt({ ok: false, reason: "unavailable", receipt: bad }, name),
        ).not.toHaveProperty("receipt");
      }
      expect(reads).toBe(0);
    },
  );
  it("retains missing create ACK IDs without inventing users or avatars", () => {
    expect(
      validJiraMutationAttempt(
        { ok: false, reason: "timeout", receipt: { ...ACTOR, userPresent: true } },
        "jira.create-user",
      ),
    ).toMatchObject({ receipt: { ...ACTOR, userPresent: true } });
    expect(
      validJiraIdentityAvatarReceipt(
        { ...ACTOR, userPresent: true, userKey: "known" },
        "jira.create-user",
      ),
    ).toBe(false);
    expect(
      validJiraMutationAttempt(
        { ok: true, receipt: { ...PROJECT, ...FILE, avatarPresent: true } },
        "jira.create-project-avatar",
      ),
    ).toMatchObject({ ok: false, receipt: { ...PROJECT, ...FILE, avatarPresent: true } });
    expect(
      validJiraIdentityAvatarReceipt(
        { ...PROJECT, avatarSelected: true },
        "jira.set-project-avatar",
      ),
    ).toBe(false);
  });
  it("does not turn an active-state change into confirmed display-name metadata", () => {
    const base = { ...ACTOR, userKey: "target", username: "Target", userPresent: true };
    for (const userActive of [false, true])
      expect(
        validJiraMutationAttempt(
          { ok: true, receipt: { ...base, userActive } },
          "jira.update-user",
        ),
      ).toMatchObject({ ok: false, receipt: { ...base, userActive } });
    expect(validJiraMutationAttempt({ ok: true, receipt: base }, "jira.update-user").ok).toBe(true);
  });
  it("binds owned avatar namespace without mixing generic, project, issue-type or user context", () => {
    expect(
      validJiraIdentityAvatarReceipt(
        { ...TYPE, ...FILE, temporaryAvatar: true, projectId: "1", projectKey: "SYN" },
        "jira.upload-owned-avatar",
      ),
    ).toBe(false);
    expect(
      validJiraIdentityAvatarReceipt(
        { ...USER, ...FILE, temporaryAvatar: true },
        "jira.upload-owned-avatar",
      ),
    ).toBe(false);
    expect(
      validJiraIdentityAvatarReceipt(
        { ...PROJECT, ...FILE, temporaryAvatar: true },
        "jira.upload-temporary-avatar",
      ),
    ).toBe(false);
    expect(
      validJiraIdentityAvatarReceipt(
        { ...PROJECT, avatarType: "user", avatarId: "9", avatarSelected: true },
        "jira.set-project-avatar",
      ),
    ).toBe(false);
  });
  it("copies only complete bounded own-data crop ACK metadata", () => {
    const temporaryCrop = { cropperOffsetX: 0, cropperOffsetY: 0, cropperWidth: 32 };
    const receipt = {
      ...PROJECT,
      ...FILE,
      temporaryAvatar: true as const,
      temporaryCrop,
      temporaryNeedsCropping: false,
    };
    const result = validJiraMutationAttempt(
      { ok: false, reason: "unavailable", receipt },
      "jira.upload-project-avatar",
    );
    expect(result.receipt).toEqual(receipt);
    expect(Object.isFrozen(result.receipt?.temporaryCrop)).toBe(true);
    temporaryCrop.cropperWidth = 1;
    expect(result.receipt?.temporaryCrop?.cropperWidth).toBe(32);
    expect(
      validJiraIdentityAvatarReceipt(
        { ...PROJECT, ...FILE, temporaryAvatar: true, temporaryCrop },
        "jira.upload-project-avatar",
      ),
    ).toBe(false);
    let reads = 0;
    Object.defineProperty(temporaryCrop, "cropperWidth", {
      enumerable: true,
      get: () => {
        reads++;
        return 32;
      },
    });
    expect(
      validJiraMutationAttempt(
        { ok: false, reason: "unavailable", receipt },
        "jira.upload-project-avatar",
      ),
    ).not.toHaveProperty("receipt");
    expect(reads).toBe(0);
  });
  it("shares the actual avatar source/content byte ceiling", () => {
    const receipt = { ...PROJECT, ...FILE, temporaryAvatar: true as const };
    expect(
      validJiraIdentityAvatarReceipt(
        { ...receipt, uploadBytes: JIRA_ATTACHMENT_MAX_BYTES },
        "jira.upload-project-avatar",
      ),
    ).toBe(true);
    for (const uploadBytes of [0, -1, 1.5, JIRA_ATTACHMENT_MAX_BYTES + 1])
      expect(
        validJiraIdentityAvatarReceipt({ ...receipt, uploadBytes }, "jira.upload-project-avatar"),
      ).toBe(false);
  });
});
