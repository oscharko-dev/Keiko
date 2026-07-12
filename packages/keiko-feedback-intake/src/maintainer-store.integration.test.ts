import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresMaintainerAuthStore, maintainerCsrfToken } from "./maintainer-store.js";
import { clientAdapter, schemaRows, type ObservedQuery } from "./postgres-integration-helpers.js";
import { PostgresIntakeRepository, type PgClientLike } from "./postgres.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl === undefined ? it.skip : it;
const AT = new Date("2026-07-11T12:00:00.000Z");
const NONCE = "n".repeat(32);
const VERIFIER = "v".repeat(43);

async function migration(name: string): Promise<string> {
  return readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
}

describe("PostgreSQL maintainer authentication store", () => {
  integration(
    "binds one-time OIDC transactions and keeps bearer and CSRF capabilities out of storage",
    async (): Promise<void> => {
      const pool = new Pool({ connectionString: databaseUrl, max: 6 });
      const schema = `maintainer_auth_${randomUUID().replaceAll("-", "")}`;
      const observed: ObservedQuery[] = [];
      const setup = await pool.connect();
      try {
        await setup.query(`CREATE SCHEMA "${schema}"`);
        await setup.query(`SET search_path TO "${schema}"`);
        await setup.query(await migration("001_feedback_intake.sql"));
        await setup.query(await migration("002_feedback_review.sql"));
        await setup.query(await migration("003_feedback_publication.sql"));
        await setup.query(await migration("004_feedback_publication_worker.sql"));
      } finally {
        setup.release();
      }
      const connect = async (): Promise<PgClientLike> => {
        const client = await pool.connect();
        await client.query(`SET search_path TO "${schema}"`);
        return clientAdapter(client, observed);
      };
      const store = new PostgresMaintainerAuthStore({ connect }, 60_000, 120_000, 2_000);
      try {
        await expect(
          schemaRows(
            pool,
            schema,
            "INSERT INTO feedback_maintainer_sessions (capability_hash, csrf_hash, issuer, subject, permissions, permission_policy_version, created_at, last_seen_at, idle_expires_at, absolute_expires_at) VALUES ($1,$2,'https://idp.example/','too-long',ARRAY['feedback.review'],'policy-v1',$3,$3,$3::timestamptz + interval '1 minute',$3::timestamptz + interval '16 minutes')",
            [Buffer.alloc(32, 1), Buffer.alloc(32, 2), AT],
          ),
        ).rejects.toThrow();
        const browser = await store.createTransaction(
          "state-secret",
          NONCE,
          VERIFIER,
          "https://maintainer.example/v1/maintainer/auth/callback",
          AT,
        );
        await expect(
          store.consumeTransaction("state-secret", "wrong-browser", AT),
        ).resolves.toBeUndefined();
        await expect(store.consumeTransaction("state-secret", browser, AT)).resolves.toEqual({
          state: "state-secret",
          nonce: NONCE,
          verifier: VERIFIER,
          redirectUri: "https://maintainer.example/v1/maintainer/auth/callback",
        });
        await expect(
          store.consumeTransaction("state-secret", browser, AT),
        ).resolves.toBeUndefined();

        const created = await store.createSession(
          "https://idp.example/tenant/",
          "maintainer-1",
          ["feedback.review"],
          "policy-v1",
          AT,
        );
        expect(created.capability).toHaveLength(43);
        expect(created.csrfToken).toBe(maintainerCsrfToken(created.capability));
        const rows = await schemaRows<{
          readonly capability_hash: Buffer;
          readonly csrf_hash: Buffer;
        }>(pool, schema, "SELECT capability_hash, csrf_hash FROM feedback_maintainer_sessions");
        expect(rows).toHaveLength(1);
        expect(rows[0]?.capability_hash).toHaveLength(32);
        expect(rows[0]?.csrf_hash).toHaveLength(32);
        expect(JSON.stringify(rows)).not.toContain(created.capability);
        expect(JSON.stringify(rows)).not.toContain(created.csrfToken);

        await expect(
          store.session(created.capability, "wrong-policy", AT),
        ).resolves.toBeUndefined();
        await expect(store.session(created.capability, "policy-v1", AT)).resolves.toMatchObject({
          issuer: "https://idp.example/tenant/",
          subject: "maintainer-1",
          permissions: ["feedback.review"],
        });
        await expect(
          store.session(created.capability, "policy-v1", new Date(AT.getTime() + 120_000)),
        ).resolves.toBeUndefined();

        const rotated = await store.createSession(
          "https://idp.example/tenant/",
          "maintainer-1",
          ["feedback.review"],
          "policy-v1",
          AT,
        );
        const survivor = await store.createSession(
          "https://idp.example/tenant/",
          "maintainer-1",
          ["feedback.review"],
          "policy-v1",
          AT,
        );
        await Promise.all([
          store.session(rotated.capability, "policy-v1", new Date(AT.getTime() + 1_000)),
          store.revoke(rotated.capability, new Date(AT.getTime() + 1_000)),
        ]);
        await expect(
          store.session(rotated.capability, "policy-v1", new Date(AT.getTime() + 1_001)),
        ).resolves.toBeUndefined();
        await expect(
          store.session(survivor.capability, "policy-v1", new Date(AT.getTime() + 1_001)),
        ).resolves.toBeDefined();

        await store.createTransaction(
          "expired-state",
          "e".repeat(32),
          "x".repeat(43),
          "https://maintainer.example/v1/maintainer/auth/callback",
          AT,
        );
        await schemaRows(
          pool,
          schema,
          "INSERT INTO feedback_oidc_transactions (state_hash, browser_hash, nonce, pkce_verifier, redirect_uri, created_at, expires_at) SELECT decode(md5(gs::text) || md5(('browser-' || gs::text)), 'hex'), decode(md5(('left-' || gs::text)) || md5(('right-' || gs::text)), 'hex'), repeat('n', 32), repeat('v', 43), 'https://maintainer.example/v1/maintainer/auth/callback', $1, $1::timestamptz + interval '5 minutes' FROM generate_series(1, 10000) gs",
          [AT],
        );
        await expect(
          store.createTransaction(
            "capacity-state",
            NONCE,
            VERIFIER,
            "https://maintainer.example/v1/maintainer/auth/callback",
            AT,
          ),
        ).rejects.toThrow("OIDC transaction capacity unavailable");
        await schemaRows(
          pool,
          schema,
          "INSERT INTO feedback_maintainer_sessions (capability_hash, csrf_hash, issuer, subject, permissions, permission_policy_version, created_at, last_seen_at, idle_expires_at, absolute_expires_at) SELECT decode(md5(('session-left-' || gs::text)) || md5(('session-right-' || gs::text)), 'hex'), decode(md5(('csrf-left-' || gs::text)) || md5(('csrf-right-' || gs::text)), 'hex'), 'https://idp.example/tenant/', 'maintainer-' || gs::text, ARRAY['feedback.review'], 'policy-v1', $1, $1, $1::timestamptz + interval '1 minute', $1::timestamptz + interval '2 minutes' FROM generate_series(1, 10000) gs",
          [AT],
        );
        await expect(
          store.createSession(
            "https://idp.example/tenant/",
            "capacity-maintainer",
            ["feedback.review"],
            "policy-v1",
            AT,
          ),
        ).rejects.toThrow("Maintainer session capacity unavailable");
        await new PostgresIntakeRepository({ connect }).purge(new Date(AT.getTime() + 300_001));
        expect(
          await schemaRows(pool, schema, "SELECT state_hash FROM feedback_oidc_transactions"),
        ).toEqual([]);
        expect(
          await schemaRows(
            pool,
            schema,
            "SELECT capability_hash FROM feedback_maintainer_sessions",
          ),
        ).toEqual([]);
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await pool.end();
      }
    },
  );
});
