import { describe, expect, it } from "vitest";
import { privateJiraCustodyFixture } from "../../../tests/support/jira-private-custody-fixture.js";
import {
  jiraPrivateSessionReference,
  jiraSessionBindingForInput,
} from "./jira-private-session-values.js";
import {
  JiraPrivateSessionError,
  type JiraPrivateSessionAccess,
} from "./jira-private-session-custody.js";

function sync<T>(
  run: (session: JiraPrivateSessionAccess) => T,
): (session: JiraPrivateSessionAccess) => Promise<T> {
  return (session) =>
    new Promise<T>((resolve) => {
      resolve(run(session));
    });
}
const COOKIE = { name: "JSESSIONID", value: ["synthetic", "session", "value"].join("-") };
const temporary = {
  actorKey: "actor-key",
  target: { kind: "project" as const, id: "7", key: "SYN" },
  uploadSha256: "a".repeat(64),
  uploadBytes: 8,
  crop: { cropperOffsetX: 0, cropperOffsetY: 0, cropperWidth: 32 },
  needsCropping: false,
};
describe("sealed task-bound private Jira session", () => {
  it("preserves exactly one temp slot across callbacks and returns cloned snapshot facts", async () => {
    const f = privateJiraCustodyFixture("jira.login");
    const binding = jiraSessionBindingForInput(f.binding);
    await f.sessions.withLease(
      binding,
      sync((session) => {
        expect(session.current()).toBeUndefined();
        session.establish(COOKIE);
        session.rememberTemporary(temporary);
        expect(session.cookieHeader()).toBe(`${COOKIE.name}=${COOKIE.value}`);
        expect(session.temporary()).toEqual(temporary);
        expect(session.temporary()).not.toBe(temporary);
      }),
    );
    await f.sessions.withLease(
      binding,
      sync((session) => {
        expect(session.temporary()).toEqual(temporary);
        session.rememberTemporary(undefined);
        expect(session.temporary()).toBeUndefined();
      }),
    );
    await f.sessions.withLease(
      binding,
      sync((session) => {
        expect(session.temporary()).toBeUndefined();
      }),
    );
  });
  it("holds exclusivity for the whole asynchronous callback across custody owners", async () => {
    const f = privateJiraCustodyFixture("jira.login");
    const binding = jiraSessionBindingForInput(f.binding);
    const other = f.fork().executionResolver.sessions;
    if (other === undefined) throw new TypeError("Missing private session owner");
    let release: () => void = () => {
      throw new TypeError("Missing test latch");
    };
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = f.sessions.withLease(binding, async () => {
      await held;
    });
    try {
      await expect(
        other.withLease(binding, () => Promise.resolve(undefined)),
      ).rejects.toMatchObject({
        code: "busy",
      });
    } finally {
      release();
      await first;
    }
    await expect(other.withLease(binding, () => Promise.resolve("released"))).resolves.toBe(
      "released",
    );
  });
  it("does not carry cookies or temp snapshots into another Pod binding or native actor", async () => {
    const f = privateJiraCustodyFixture("jira.login");
    const binding = jiraSessionBindingForInput(f.binding);
    await f.sessions.withLease(
      binding,
      sync((session) => {
        session.establish(COOKIE);
        session.rememberTemporary(temporary);
      }),
    );
    if (binding.context.kind !== "chat") throw new TypeError("Expected Chat fixture");
    const changed = {
      ...binding,
      context: { ...binding.context, bindingGeneration: binding.context.bindingGeneration + 1 },
    };
    await f.sessions.withLease(
      changed,
      sync((session) => {
        expect(session.current()).toBeUndefined();
      }),
    );
    await f.sessions.withLease(
      { ...binding, actorUserKey: "other-actor" },
      sync((session) => {
        expect(session.current()).toBeUndefined();
      }),
    );
  });
  it("retains the same session across messages on the same stable Pod binding without extending expiry", async () => {
    const f = privateJiraCustodyFixture("jira.login");
    const binding = jiraSessionBindingForInput(f.binding);
    await f.sessions.withLease(
      binding,
      sync((session) => {
        session.establish(COOKIE);
      }),
    );
    await f.sessions.withLease(
      {
        ...binding,
        authority: { runId: "new-accepted-turn", envelopeDigest: "e".repeat(64) },
        expiresAt: binding.expiresAt + 60_000,
      },
      sync((session) => {
        expect(session.current()?.expiresAt).toBe(binding.expiresAt);
      }),
    );
  });
  it("invalidates an interrupted owner marker rather than replaying an old cookie/temp slot", async () => {
    const f = privateJiraCustodyFixture("jira.login");
    const binding = jiraSessionBindingForInput(f.binding);
    await f.sessions.withLease(
      binding,
      sync((session) => {
        session.establish(COOKIE);
        session.rememberTemporary(temporary);
      }),
    );
    const ref = jiraPrivateSessionReference(binding);
    const raw = f.sealedPortEntries.get(ref);
    if (raw === undefined) throw new TypeError("Missing sealed record");
    f.sealedPortEntries.set(
      ref,
      raw.replace(
        '"kind":"jira-private-session"',
        '"kind":"jira-private-session","leaseId":"7765d9e4-fc9a-46d5-aea4-24880fec5e1e"',
      ),
    );
    await f.sessions.withLease(
      binding,
      sync((session) => {
        expect(session.current()).toBeUndefined();
        expect(() => session.cookieHeader()).toThrow(JiraPrivateSessionError);
      }),
    );
    expect(f.sealedPortEntries.get(ref)).not.toContain(COOKIE.value);
  });
  it("refuses cookie resolution after credential revision changes while allowing secret erasure", async () => {
    const f = privateJiraCustodyFixture("jira.login");
    const binding = jiraSessionBindingForInput(f.binding);
    await f.sessions.withLease(
      binding,
      sync((session) => {
        session.establish(COOKIE);
        f.custody.beginVerification(binding.authRef, binding.authenticationGeneration);
        expect(() => session.cookieHeader()).toThrow(JiraPrivateSessionError);
        session.invalidate();
      }),
    );
    expect(f.sealedPortEntries.get(jiraPrivateSessionReference(binding))).not.toContain(
      COOKIE.value,
    );
  });
  it("reclaims expired cookies and temp slots on real allocations, preserving active leases and credentials", async () => {
    const f = privateJiraCustodyFixture("jira.login");
    const binding = jiraSessionBindingForInput(f.binding);
    const oldReference = jiraPrivateSessionReference(binding);
    await f.sessions.withLease(binding, async (session) => {
      session.establish(COOKIE);
      session.rememberTemporary(temporary);
      f.advance(60_000);
      await f.sessions.withLease(
        { ...binding, actorUserKey: "next-actor", expiresAt: binding.expiresAt + 60_000 },
        () => Promise.resolve(undefined),
      );
      expect(f.sealedPortEntries.has(oldReference)).toBe(true); // The old callback still owns its kernel lease.
    });
    await f.sessions.withLease(
      { ...binding, actorUserKey: "third-actor", expiresAt: binding.expiresAt + 60_000 },
      () => Promise.resolve(undefined),
    );
    expect(f.sealedPortEntries.has(oldReference)).toBe(false);
    expect([...f.sealedPortEntries.values()].join("")).not.toContain(COOKIE.value);
    expect(f.custody.getMetadata(binding.authRef)?.authRef).toBe(binding.authRef);
  });
});
