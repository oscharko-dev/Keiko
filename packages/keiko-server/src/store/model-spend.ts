import { DatabaseSync } from "node:sqlite";

/** How one construction reconciled the configured ceiling with the one the ledger already held. */
export type SpendCeilingDisposition = "unchanged" | "lowered" | "raised" | "raise-refused";

export interface SpendCeilingReconciliation {
  readonly disposition: SpendCeilingDisposition;
  /** The ceiling actually in force afterwards — not necessarily the configured one. */
  readonly ceilingNanoUsd: number;
  readonly configuredNanoUsd: number;
  readonly chargedNanoUsd: number;
}

// Body-free admission ledger. A reservation is durable BEFORE the network is entered; process
// loss therefore keeps its full charge. All connections arbitrate through one atomic SQL update.
export class ModelSpendStore {
  private readonly db: DatabaseSync;
  /**
   * What opening this ledger did to its ceiling. The caller MUST report it: a reused ledger whose
   * ceiling differs from the operator's configuration is the one state in which "budget exceeded"
   * is not explained by the configured number alone.
   */
  readonly reconciliation: SpendCeilingReconciliation;

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
    this.reconciliation = this.reconcileCeiling(ceilingNanoUsd);
  }

  /**
   * Applies the operator's configured ceiling to a ledger that may already hold a different one.
   *
   * A reduction always wins. A RAISE is accepted only on a healthy ledger, and never silently: the
   * caller records it (`gateway.spend.ceiling`). The configured value reaches this class from the
   * local operator's own environment and from nowhere else — never from model output, a request, or
   * repository content — so an operator raising their own limit is an authorization, not an attack.
   * Refusing it outright, as this ledger once did, left the only recovery in deleting a file the
   * operator was never told about, while the process kept reporting the configured ceiling it was
   * not using.
   *
   * `charged > ceiling` is the one state a raise may NOT clear. `exhaust` produces it when measured
   * provider cost broke a reservation's upper bound: the pricing that admitted the call is proven
   * untrustworthy, so the ledger is closed and must stay closed across restarts. A configured raise
   * would otherwise re-arm exactly the ledger that just proved it cannot bound its own spend.
   */
  private reconcileCeiling(configuredNanoUsd: number): SpendCeilingReconciliation {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT OR IGNORE INTO model_spend (id, ceiling) VALUES (1, ?)")
        .run(configuredNanoUsd);
      const row = this.db.prepare("SELECT ceiling, charged FROM model_spend WHERE id = 1").get();
      const held = Number(row?.ceiling);
      const charged = Number(row?.charged);
      if (!Number.isSafeInteger(held) || !Number.isSafeInteger(charged)) {
        throw new TypeError("spend-ledger-invalid");
      }
      const applied = this.applyCeiling(configuredNanoUsd, held, charged);
      this.db.exec("COMMIT");
      return applied;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private applyCeiling(
    configuredNanoUsd: number,
    held: number,
    chargedNanoUsd: number,
  ): SpendCeilingReconciliation {
    const settled = (
      disposition: SpendCeilingDisposition,
      ceilingNanoUsd: number,
    ): SpendCeilingReconciliation => {
      if (ceilingNanoUsd !== held) {
        this.db.prepare("UPDATE model_spend SET ceiling = ? WHERE id = 1").run(ceilingNanoUsd);
      }
      return { disposition, ceilingNanoUsd, configuredNanoUsd, chargedNanoUsd };
    };
    if (configuredNanoUsd < held) return settled("lowered", configuredNanoUsd);
    if (configuredNanoUsd === held) return settled("unchanged", held);
    if (chargedNanoUsd > held) return settled("raise-refused", held);
    return settled("raised", configuredNanoUsd);
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

  exhaust(additionalNanoUsd: number): void {
    this.db
      .prepare("UPDATE model_spend SET charged = charged + ?, ceiling = 0 WHERE id = 1")
      .run(additionalNanoUsd);
  }

  close(): void {
    this.db.close();
  }
}
