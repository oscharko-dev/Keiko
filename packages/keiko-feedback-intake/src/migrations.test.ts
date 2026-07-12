import { describe, expect, it } from "vitest";
import { applyFeedbackMigrations } from "./migrations.js";
import type { PgClientLike, PgQueryResult } from "./postgres-types.js";

class MigrationClient implements PgClientLike {
  readonly calls: string[] = [];
  released = false;

  constructor(private readonly versions: readonly number[] | undefined) {}

  query<Row extends object>(text: string): Promise<PgQueryResult<Row>> {
    this.calls.push(text);
    if (text.startsWith("SELECT to_regclass")) {
      return Promise.resolve({
        rows: [{ name: this.versions === undefined ? null : "feedback_schema_migrations" } as Row],
        rowCount: 1,
      });
    }
    if (text.startsWith("SELECT version")) {
      return Promise.resolve({
        rows: (this.versions ?? []).map((version) => ({ version }) as Row),
        rowCount: this.versions?.length ?? 0,
      });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  release(): void {
    this.released = true;
  }
}

const migrations = [
  { version: 1, source: "MIGRATION ONE" },
  { version: 2, source: "MIGRATION TWO" },
  { version: 3, source: "MIGRATION THREE" },
] as const;

async function run(versions: readonly number[] | undefined): Promise<MigrationClient> {
  const client = new MigrationClient(versions);
  await applyFeedbackMigrations({ connect: () => Promise.resolve(client) }, migrations);
  return client;
}

describe("feedback migration runner", () => {
  it("applies all migrations to an empty schema and only later migrations to older schemas", async () => {
    expect((await run(undefined)).calls).toEqual(
      expect.arrayContaining(["MIGRATION ONE", "MIGRATION TWO", "MIGRATION THREE", "COMMIT"]),
    );
    const upgraded = await run([1]);
    expect(upgraded.calls).not.toContain("MIGRATION ONE");
    expect(upgraded.calls).toContain("MIGRATION TWO");
    expect(upgraded.calls).toContain("MIGRATION THREE");
    const v2 = await run([1, 2]);
    expect(v2.calls).toContain("MIGRATION THREE");
  });

  it.each([{ versions: [2] }, { versions: [1, 3] }, { versions: [1, 2, 4] }])(
    "fails closed for gapped or unknown $versions",
    async ({ versions }) => {
      const client = new MigrationClient(versions);
      await expect(
        applyFeedbackMigrations({ connect: () => Promise.resolve(client) }, migrations),
      ).rejects.toThrow("Unsupported or non-contiguous");
      expect(client.calls).toContain("ROLLBACK");
      expect(client.released).toBe(true);
    },
  );
});
