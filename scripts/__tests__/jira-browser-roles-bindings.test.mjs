import { describe, expect, it } from "vitest";
import { verifyBrowserRoleBindings } from "../testing/jira-chat-lab/browser-roles-setup.mjs";

const ROLES = ["projectLead", "developer", "techLead"];

function fixture() {
  const actors = Object.fromEntries(
    ROLES.map((role) => [
      role,
      {
        key: `synthetic-${role}-key`,
        name: `synthetic-${role}`,
        tokenFile: `/private/session/secrets/${role}-token`,
      },
    ]),
  );
  const observations = Object.fromEntries(
    ROLES.map((role, index) => {
      const podId = `20000000-0000-4000-8000-00000000000${index + 1}`;
      const chatId = `synthetic-${role}-chat`;
      const label = `${role} Pod`;
      return [
        role,
        {
          expectedChatId: chatId,
          expectedLabel: label,
          chat: {
            id: chatId,
            title: "Synthetic Jira browser Chat",
            status: "open",
            jiraBindingGeneration: 2,
            jiraPodBinding: {
              podId,
              bindingGeneration: 2,
              authenticationGeneration: 1,
              connectedAtMs: 10,
            },
          },
          credential: {
            schemaVersion: "1",
            provider: "jira",
            deployment: "data-center",
            authScheme: "bearer-pat",
            authRef: `atlassian-cred:${String(index + 1).repeat(22)}`,
            generation: 1,
            createdAt: 10,
            displayName: label,
            baseUrl: "https://jira.example.invalid",
            livePod: {
              kind: "jira-live",
              podId,
              authenticationGeneration: 1,
              verificationRevision: 3,
              verificationInProgress: false,
              verificationStatus: "ok",
              capabilities: ["live-read", "live-write"],
            },
          },
        },
      ];
    }),
  );
  return { fixture: { actors }, observations };
}

describe("three role Chat/Pod authentication bindings", () => {
  it("retains PL after Dev and TL observations despite identical generic Chat titles", () => {
    const f = fixture();
    const before = verifyBrowserRoleBindings(f.fixture, f.observations);
    const observedAgain = structuredClone(f.observations);
    observedAgain.developer.chat.title = "A harmless renamed developer Chat";
    const after = verifyBrowserRoleBindings(f.fixture, observedAgain, before);

    expect(after).toEqual(before);
    expect(after.roles.projectLead.chatId).toBe(f.observations.projectLead.chat.id);
    expect(after.roles.projectLead.podId).toBe(f.observations.projectLead.credential.livePod.podId);
    expect(Object.isFrozen(after)).toBe(true);
    expect(Object.isFrozen(after.roles.projectLead)).toBe(true);
  });

  it("projects only opaque references, counters and digests without native or credential bodies", () => {
    const f = fixture();
    const snapshot = verifyBrowserRoleBindings(f.fixture, f.observations);
    const serialized = JSON.stringify(snapshot);

    for (const role of ROLES) {
      expect(snapshot.roles[role].principalDigest).toMatch(/^[a-f\d]{64}$/u);
      expect(snapshot.roles[role].patFileDigest).toMatch(/^[a-f\d]{64}$/u);
      expect(snapshot.roles[role].authRefDigest).toMatch(/^[a-f\d]{64}$/u);
      expect(serialized).not.toContain(f.fixture.actors[role].key);
      expect(serialized).not.toContain(f.fixture.actors[role].tokenFile);
      expect(serialized).not.toContain(f.observations[role].credential.authRef);
      expect(serialized).not.toContain(f.observations[role].credential.baseUrl);
    }
    expect(serialized).not.toContain("displayName");
    expect(serialized).not.toContain("capabilities");
  });

  it.each(["key", "name", "tokenFile"])("rejects a shared actor/PAT identity field: %s", (key) => {
    const f = fixture();
    f.fixture.actors.developer[key] = f.fixture.actors.projectLead[key];
    expect(() => verifyBrowserRoleBindings(f.fixture, f.observations)).toThrow(TypeError);
  });

  it.each([
    [
      "Chat",
      (f) => {
        f.observations.developer.chat.id = f.observations.projectLead.chat.id;
        f.observations.developer.expectedChatId = f.observations.projectLead.expectedChatId;
      },
    ],
    [
      "Pod",
      (f) => {
        const id = f.observations.projectLead.credential.livePod.podId;
        f.observations.developer.credential.livePod.podId = id;
        f.observations.developer.chat.jiraPodBinding.podId = id;
      },
    ],
    [
      "credential",
      (f) => {
        f.observations.developer.credential.authRef = f.observations.projectLead.credential.authRef;
      },
    ],
  ])("rejects separate role observations that share one %s", (_name, change) => {
    const f = fixture();
    change(f);
    expect(() => verifyBrowserRoleBindings(f.fixture, f.observations)).toThrow(TypeError);
  });

  it.each([
    [
      "failed verification",
      (item) => {
        item.credential.livePod.verificationStatus = "auth-failed";
      },
    ],
    [
      "unfinished verification",
      (item) => {
        item.credential.livePod.verificationInProgress = true;
      },
    ],
    [
      "absent revision",
      (item) => {
        item.credential.livePod.verificationRevision = 0;
      },
    ],
    [
      "missing write capability",
      (item) => {
        item.credential.livePod.capabilities = ["live-read"];
      },
    ],
    [
      "wrong credential generation",
      (item) => {
        item.credential.generation = 2;
      },
    ],
    [
      "wrong Pod generation",
      (item) => {
        item.credential.livePod.authenticationGeneration = 2;
      },
    ],
    [
      "wrong Chat generation",
      (item) => {
        item.chat.jiraPodBinding.authenticationGeneration = 2;
      },
    ],
    [
      "wrong binding generation",
      (item) => {
        item.chat.jiraBindingGeneration = 4;
      },
    ],
    [
      "wrong observed Chat",
      (item) => {
        item.expectedChatId = "different-chat";
      },
    ],
    [
      "wrong Pod label",
      (item) => {
        item.expectedLabel = "different Pod";
      },
    ],
    [
      "closed Chat",
      (item) => {
        item.chat.status = "closed";
      },
    ],
    [
      "missing binding",
      (item) => {
        delete item.chat.jiraPodBinding;
      },
    ],
    [
      "legacy credential",
      (item) => {
        item.credential.authScheme = "basic-api-token";
      },
    ],
  ])("refuses an unready or mismatched actual DTO: %s", (_name, change) => {
    const f = fixture();
    change(f.observations.projectLead);
    expect(() => verifyBrowserRoleBindings(f.fixture, f.observations)).toThrow(TypeError);
  });

  it.each(["key", "name", "tokenFile"])(
    "rejects a changed seeded principal/PAT field: %s",
    (key) => {
      const f = fixture();
      const before = verifyBrowserRoleBindings(f.fixture, f.observations);
      f.fixture.actors.projectLead[key] += "-changed";
      expect(() => verifyBrowserRoleBindings(f.fixture, f.observations, before)).toThrow(TypeError);
    },
  );

  it.each([
    [
      "verification revision",
      (item) => {
        item.credential.livePod.verificationRevision += 1;
      },
    ],
    [
      "credential",
      (item) => {
        item.credential.authRef = `atlassian-cred:${"9".repeat(22)}`;
      },
    ],
    [
      "authentication generation",
      (item) => {
        item.credential.generation += 1;
        item.credential.livePod.authenticationGeneration += 1;
        item.chat.jiraPodBinding.authenticationGeneration += 1;
      },
    ],
    [
      "binding generation",
      (item) => {
        item.chat.jiraBindingGeneration += 1;
        item.chat.jiraPodBinding.bindingGeneration += 1;
      },
    ],
    [
      "retargeted Pod",
      (item) => {
        const podId = "20000000-0000-4000-8000-000000000009";
        item.credential.livePod.podId = podId;
        item.chat.jiraPodBinding.podId = podId;
      },
    ],
    [
      "replacement Chat",
      (item) => {
        item.chat.id += "-replacement";
        item.expectedChatId = item.chat.id;
      },
    ],
  ])("rejects a changed identity between opening roles and PL8: %s", (_name, change) => {
    const f = fixture();
    const before = verifyBrowserRoleBindings(f.fixture, f.observations);
    change(f.observations.projectLead);
    expect(() => verifyBrowserRoleBindings(f.fixture, f.observations, before)).toThrow(TypeError);
  });

  it("refuses incomplete observations instead of accepting a partial role set", () => {
    const f = fixture();
    delete f.observations.techLead;
    expect(() => verifyBrowserRoleBindings(f.fixture, f.observations)).toThrow(TypeError);
  });
});
