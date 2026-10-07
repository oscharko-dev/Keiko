import type { Entry } from "../ledger.ts";
import { parseCsv } from "../csv.ts";
import { bankBImporter } from "./bank-b.ts";

/** A bank export format that can be turned into ledger entries. */
export interface Importer {
  readonly id: string;
  readonly describe: string;
  parse(text: string): Entry[];
}

/** The native ledger CSV export (see docs/FORMAT.md). */
export const ledgerCsvImporter: Importer = {
  id: "ledger-csv",
  describe: "Ledger CSV export (comma-separated, ISO dates, decimal point)",
  parse: parseCsv,
};

export const IMPORTERS: readonly Importer[] = [ledgerCsvImporter, bankBImporter];

/** Finds an importer by id; throws with the known ids when none matches. */
export function importerFor(id: string): Importer {
  const importer = IMPORTERS.find((candidate) => candidate.id === id);
  if (importer === undefined) {
    throw new Error(`Unknown import format "${id}" (known: ${IMPORTERS.map((i) => i.id).join(", ")})`);
  }
  return importer;
}
