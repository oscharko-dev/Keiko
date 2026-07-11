import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FeedbackMaintainerPermissionV1 } from "@oscharko-dev/keiko-contracts/feedback-maintainer";
import { acquirePostgresClient } from "./postgres-client.js";
import type { PgPoolLike } from "./postgres-types.js";

interface TransactionRow {
  readonly nonce: string;
  readonly pkce_verifier: string;
  readonly redirect_uri: string;
  readonly expires_at: Date;
}

interface SessionRow {
  readonly capability_hash: Uint8Array;
  readonly csrf_hash: Uint8Array;
  readonly issuer: string;
  readonly subject: string;
  readonly permissions: readonly FeedbackMaintainerPermissionV1[];
  readonly permission_policy_version: string;
  readonly idle_expires_at: Date;
  readonly absolute_expires_at: Date;
  readonly revoked_at: Date | null;
}

export interface ConsumedOidcTransaction {
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly redirectUri: string;
}

export interface CreatedMaintainerSession {
  readonly capability: string;
  readonly csrfToken: string;
  readonly absoluteExpiresAt: Date;
}

export interface MaintainerSessionIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly permissions: readonly FeedbackMaintainerPermissionV1[];
  readonly permissionPolicyVersion: string;
  readonly csrfHash: Uint8Array;
  readonly absoluteExpiresAt: Date;
}

function digest(domain: string, value: string): Uint8Array {
  return createHash("sha256").update(domain).update("\0").update(value).digest();
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function randomCapability(): string {
  return randomBytes(32).toString("base64url");
}

export class PostgresMaintainerAuthStore {
  constructor(
    private readonly pool: PgPoolLike,
    private readonly idleMs: number,
    private readonly absoluteMs: number,
    private readonly deadlineMs = 5_000,
  ) {}

  async createTransaction(
    state: string,
    nonce: string,
    verifier: string,
    redirectUri: string,
    at: Date,
  ): Promise<string> {
    const browserCapability = randomCapability();
    const client = await acquirePostgresClient(this.pool, this.deadlineMs);
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [2_075_001]);
      const count = await client.query<{ readonly count: string }>(
        "SELECT count(*)::text AS count FROM feedback_oidc_transactions WHERE expires_at > $1",
        [at],
      );
      if (Number(count.rows[0]?.count ?? "10000") >= 10_000) {
        throw new Error("OIDC transaction capacity unavailable");
      }
      await client.query(
        "INSERT INTO feedback_oidc_transactions (state_hash, browser_hash, nonce, pkce_verifier, redirect_uri, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$6::timestamptz + interval '5 minutes')",
        [
          digest("keiko-oidc-state-v1", state),
          digest("keiko-oidc-browser-v1", browserCapability),
          nonce,
          verifier,
          redirectUri,
          at,
        ],
      );
      await client.query("COMMIT");
      return browserCapability;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async consumeTransaction(
    state: string,
    browserCapability: string,
    at: Date,
  ): Promise<ConsumedOidcTransaction | undefined> {
    const client = await acquirePostgresClient(this.pool, this.deadlineMs);
    try {
      const result = await client.query<TransactionRow>(
        "DELETE FROM feedback_oidc_transactions WHERE state_hash = $1 AND browser_hash = $2 RETURNING nonce, pkce_verifier, redirect_uri, expires_at",
        [digest("keiko-oidc-state-v1", state), digest("keiko-oidc-browser-v1", browserCapability)],
      );
      const row = result.rows[0];
      if (row === undefined || row.expires_at <= at) return undefined;
      return {
        state,
        nonce: row.nonce,
        verifier: row.pkce_verifier,
        redirectUri: row.redirect_uri,
      };
    } finally {
      client.release();
    }
  }

  async createSession(
    issuer: string,
    subject: string,
    permissions: readonly FeedbackMaintainerPermissionV1[],
    policyVersion: string,
    at: Date,
  ): Promise<CreatedMaintainerSession> {
    const capability = randomCapability();
    const csrfToken = maintainerCsrfToken(capability);
    const absoluteExpiresAt = new Date(at.getTime() + this.absoluteMs);
    const idleExpiresAt = new Date(
      Math.min(at.getTime() + this.idleMs, absoluteExpiresAt.getTime()),
    );
    const client = await acquirePostgresClient(this.pool, this.deadlineMs);
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [2_075_002]);
      const count = await client.query<{ readonly count: string }>(
        "SELECT count(*)::text AS count FROM feedback_maintainer_sessions WHERE revoked_at IS NULL AND idle_expires_at > $1 AND absolute_expires_at > $1",
        [at],
      );
      if (Number(count.rows[0]?.count ?? "10000") >= 10_000) {
        throw new Error("Maintainer session capacity unavailable");
      }
      await client.query(
        "INSERT INTO feedback_maintainer_sessions (capability_hash, csrf_hash, issuer, subject, permissions, permission_policy_version, created_at, last_seen_at, idle_expires_at, absolute_expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9)",
        [
          digest("keiko-maintainer-session-v1", capability),
          digest("keiko-maintainer-csrf-v1", csrfToken),
          issuer,
          subject,
          permissions,
          policyVersion,
          at,
          idleExpiresAt,
          absoluteExpiresAt,
        ],
      );
      await client.query("COMMIT");
      return { capability, csrfToken, absoluteExpiresAt };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async session(
    capability: string,
    policyVersion: string,
    at: Date,
  ): Promise<MaintainerSessionIdentity | undefined> {
    const capabilityHash = digest("keiko-maintainer-session-v1", capability);
    const client = await acquirePostgresClient(this.pool, this.deadlineMs);
    try {
      const idle = new Date(at.getTime() + this.idleMs);
      const result = await client.query<SessionRow>(
        "UPDATE feedback_maintainer_sessions SET last_seen_at = $2, idle_expires_at = LEAST($3, absolute_expires_at) WHERE capability_hash = $1 AND revoked_at IS NULL AND permission_policy_version = $4 AND idle_expires_at > $2 AND absolute_expires_at > $2 RETURNING capability_hash, csrf_hash, issuer, subject, permissions, permission_policy_version, idle_expires_at, absolute_expires_at, revoked_at",
        [capabilityHash, at, idle, policyVersion],
      );
      const row = result.rows[0];
      if (row === undefined || !equal(row.capability_hash, capabilityHash)) return undefined;
      return {
        issuer: row.issuer,
        subject: row.subject,
        permissions: row.permissions,
        permissionPolicyVersion: row.permission_policy_version,
        csrfHash: row.csrf_hash,
        absoluteExpiresAt: row.absolute_expires_at,
      };
    } finally {
      client.release();
    }
  }

  async revoke(capability: string, at: Date): Promise<void> {
    const client = await acquirePostgresClient(this.pool, this.deadlineMs);
    try {
      await client.query(
        "UPDATE feedback_maintainer_sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE capability_hash = $1",
        [digest("keiko-maintainer-session-v1", capability), at],
      );
    } finally {
      client.release();
    }
  }
}

export function verifyMaintainerCsrf(token: string, expectedHash: Uint8Array): boolean {
  return equal(digest("keiko-maintainer-csrf-v1", token), expectedHash);
}

export function maintainerCsrfToken(capability: string): string {
  return Buffer.from(digest("keiko-maintainer-csrf-token-v1", capability)).toString("base64url");
}
