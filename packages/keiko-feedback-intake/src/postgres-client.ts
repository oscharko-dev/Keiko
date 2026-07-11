import type { PgClientLike, PgPoolLike } from "./postgres-types.js";

export function isRetryablePostgresError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ["40001", "23505"].includes(String((error as { readonly code?: unknown }).code))
  );
}

export function acquirePostgresClient(pool: PgPoolLike, timeoutMs: number): Promise<PgClientLike> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error("PostgreSQL acquisition deadline exceeded"));
    }, timeoutMs);
    void pool.connect().then(
      (client) => {
        if (settled) {
          client.release();
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(client);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("PostgreSQL acquisition failed"));
      },
    );
  });
}
