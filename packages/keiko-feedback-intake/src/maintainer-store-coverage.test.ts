import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PostgresMaintainerAuthStore, verifyMaintainerCsrf } from "./maintainer-store.js";
import type { PgClientLike, PgPoolLike, PgQueryResult } from "./postgres-types.js";

const AT = new Date("2026-07-12T12:00:00.000Z");
const hash = (domain: string, value: string): Uint8Array =>
  createHash("sha256").update(domain).update("\0").update(value).digest();
const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  Buffer.from(left).equals(Buffer.from(right));

interface StoredTransaction {
  readonly stateHash: Uint8Array;
  readonly browserHash: Uint8Array;
  readonly nonce: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly expiresAt: Date;
}

interface StoredSession {
  readonly capabilityHash: Uint8Array;
  readonly csrfHash: Uint8Array;
  readonly issuer: string;
  readonly subject: string;
  readonly permissions: readonly string[];
  readonly policyVersion: string;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

class Client implements PgClientLike {
  released = false;
  transactionExpired = false;
  revoked = false;
  returnMismatchedCapability = false;
  readonly calls: { readonly text: string; readonly values: readonly unknown[] }[] = [];
  private transaction: StoredTransaction | undefined;
  private storedSession: StoredSession | undefined;

  query<Row extends object = Record<string, never>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    this.calls.push({ text, values });
    if (text.startsWith("SELECT count")) return this.result<Row>([{ count: "0" }]);
    if (text.startsWith("INSERT INTO feedback_oidc_transactions")) {
      this.transaction = {
        stateHash: values[0] as Uint8Array,
        browserHash: values[1] as Uint8Array,
        nonce: String(values[2]),
        verifier: String(values[3]),
        redirectUri: String(values[4]),
        expiresAt: new Date((values[5] as Date).getTime() + 300_000),
      };
      return this.result<Row>([]);
    }
    if (text.startsWith("DELETE FROM feedback_oidc_transactions"))
      return this.consumeTransaction<Row>(values);
    if (text.startsWith("INSERT INTO feedback_maintainer_sessions")) {
      this.storedSession = {
        capabilityHash: values[0] as Uint8Array,
        csrfHash: values[1] as Uint8Array,
        issuer: String(values[2]),
        subject: String(values[3]),
        permissions: values[4] as readonly string[],
        policyVersion: String(values[5]),
        idleExpiresAt: values[7] as Date,
        absoluteExpiresAt: values[8] as Date,
      };
      return this.result<Row>([]);
    }
    if (text.startsWith("UPDATE feedback_maintainer_sessions SET last_seen"))
      return this.readSession<Row>(values);
    if (text.startsWith("UPDATE feedback_maintainer_sessions SET revoked_at"))
      return this.revokeSession<Row>(values);
    return this.result<Row>([]);
  }

  private consumeTransaction<Row extends object>(
    values: readonly unknown[],
  ): Promise<PgQueryResult<Row>> {
    const stored = this.transaction;
    if (
      stored === undefined ||
      !sameBytes(stored.stateHash, values[0] as Uint8Array) ||
      !sameBytes(stored.browserHash, values[1] as Uint8Array)
    ) {
      return this.result<Row>([]);
    }
    this.transaction = undefined;
    return this.result<Row>([
      {
        nonce: stored.nonce,
        pkce_verifier: stored.verifier,
        redirect_uri: stored.redirectUri,
        expires_at: this.transactionExpired ? new Date(AT.getTime() - 1) : stored.expiresAt,
      },
    ]);
  }

  private readSession<Row extends object>(values: readonly unknown[]): Promise<PgQueryResult<Row>> {
    const stored = this.storedSession;
    const at = values[1] as Date;
    if (
      stored === undefined ||
      this.revoked ||
      !sameBytes(stored.capabilityHash, values[0] as Uint8Array) ||
      stored.policyVersion !== values[3] ||
      stored.idleExpiresAt <= at ||
      stored.absoluteExpiresAt <= at
    ) {
      return this.result<Row>([]);
    }
    return this.result<Row>([
      {
        capability_hash: this.returnMismatchedCapability
          ? new Uint8Array(stored.capabilityHash.byteLength)
          : stored.capabilityHash,
        csrf_hash: stored.csrfHash,
        issuer: stored.issuer,
        subject: stored.subject,
        permissions: stored.permissions,
        permission_policy_version: stored.policyVersion,
        idle_expires_at: stored.idleExpiresAt,
        absolute_expires_at: stored.absoluteExpiresAt,
        revoked_at: null,
      },
    ]);
  }

  private revokeSession<Row extends object>(
    values: readonly unknown[],
  ): Promise<PgQueryResult<Row>> {
    const stored = this.storedSession;
    if (stored !== undefined && sameBytes(stored.capabilityHash, values[0] as Uint8Array)) {
      this.revoked = true;
    }
    return this.result<Row>([]);
  }

  private result<Row extends object>(rows: readonly object[]): Promise<PgQueryResult<Row>> {
    return Promise.resolve({ rows: rows as readonly Row[], rowCount: rows.length });
  }

  release(): void {
    this.released = true;
  }
}

function store(client: Client): PostgresMaintainerAuthStore {
  const pool = {
    connect: (): Promise<PgClientLike> => Promise.resolve(client),
  } satisfies PgPoolLike;
  return new PostgresMaintainerAuthStore(pool, 60_000, 120_000);
}

describe("maintainer authentication store persistence", () => {
  it("binds one-time OIDC transactions and generated maintainer capabilities", async () => {
    const client = new Client();
    const subject = store(client);
    const browser = await subject.createTransaction(
      "state",
      "nonce",
      "verifier",
      "https://app.example/callback",
      AT,
    );
    expect(browser).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    await expect(subject.consumeTransaction("state", "wrong-browser", AT)).resolves.toBeUndefined();
    await expect(subject.consumeTransaction("state", browser, AT)).resolves.toEqual({
      state: "state",
      nonce: "nonce",
      verifier: "verifier",
      redirectUri: "https://app.example/callback",
    });

    const created = await subject.createSession(
      "https://issuer.example",
      "operator",
      ["feedback.review"],
      "policy-v1",
      AT,
    );
    const sessionInsert = client.calls.find((call) =>
      call.text.startsWith("INSERT INTO feedback_maintainer_sessions"),
    );
    expect(sessionInsert?.values[0]).toEqual(
      hash("keiko-maintainer-session-v1", created.capability),
    );
    expect(sessionInsert?.values[1]).toEqual(hash("keiko-maintainer-csrf-v1", created.csrfToken));
    await expect(subject.session("wrong-capability", "policy-v1", AT)).resolves.toBeUndefined();
    await expect(subject.session(created.capability, "wrong-policy", AT)).resolves.toBeUndefined();
    const identity = await subject.session(created.capability, "policy-v1", AT);
    expect(identity).toMatchObject({
      subject: "operator",
      permissions: ["feedback.review"],
      permissionPolicyVersion: "policy-v1",
    });
    expect(identity?.csrfHash).toEqual(hash("keiko-maintainer-csrf-v1", created.csrfToken));
    expect(verifyMaintainerCsrf(created.csrfToken, identity?.csrfHash ?? new Uint8Array())).toBe(
      true,
    );
    expect(verifyMaintainerCsrf("wrong-token", identity?.csrfHash ?? new Uint8Array())).toBe(false);
    client.returnMismatchedCapability = true;
    await expect(subject.session(created.capability, "policy-v1", AT)).resolves.toBeUndefined();
    client.returnMismatchedCapability = false;
    await expect(
      subject.session(created.capability, "policy-v1", new Date(AT.getTime() + 120_000)),
    ).resolves.toBeUndefined();
    await expect(subject.revoke(created.capability, AT)).resolves.toBeUndefined();
    await expect(subject.session(created.capability, "policy-v1", AT)).resolves.toBeUndefined();
    expect(client.revoked).toBe(true);
    expect(client.released).toBe(true);
  });

  it("rejects an expired one-time OIDC transaction", async () => {
    const client = new Client();
    const subject = store(client);
    const browser = await subject.createTransaction(
      "expired-state",
      "expired-nonce",
      "expired-verifier",
      "https://app.example/callback",
      AT,
    );
    client.transactionExpired = true;
    await expect(subject.consumeTransaction("expired-state", browser, AT)).resolves.toBeUndefined();
    expect(client.released).toBe(true);
  });
});
