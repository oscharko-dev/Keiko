import { DatabaseSync } from "node:sqlite";

// Body-free admission ledger. A reservation is durable BEFORE the network is entered; process
// loss therefore keeps its full charge. All connections arbitrate through one atomic SQL update.
export class ModelSpendStore {
  private readonly db: DatabaseSync;

  constructor(path: string, ceilingNanoUsd: number) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS model_spend (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        ceiling INTEGER NOT NULL CHECK (ceiling >= 0),
        charged INTEGER NOT NULL DEFAULT 0 CHECK (charged >= 0)
      ) STRICT;
    `);
    this.db
      .prepare("INSERT OR IGNORE INTO model_spend (id, ceiling) VALUES (1, ?)")
      .run(ceilingNanoUsd);
    // Reusing a ledger cannot silently enlarge its original accepted ceiling.
    this.db
      .prepare("UPDATE model_spend SET ceiling = MIN(ceiling, ?) WHERE id = 1")
      .run(ceilingNanoUsd);
  }

  reserve(nanoUsd: number): boolean {
    return (
      this.db
        .prepare(
          "UPDATE model_spend SET charged = charged + ? WHERE id = 1 AND charged <= ceiling - ?",
        )
        .run(nanoUsd, nanoUsd).changes === 1
    );
  }

  refund(nanoUsd: number): void {
    if (nanoUsd === 0) return;
    const result = this.db
      .prepare("UPDATE model_spend SET charged = charged - ? WHERE id = 1 AND charged >= ?")
      .run(nanoUsd, nanoUsd);
    if (result.changes !== 1) throw new TypeError("spend-ledger-invalid");
  }

  close(): void {
    this.db.close();
  }
}
