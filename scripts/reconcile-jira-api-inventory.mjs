#!/usr/bin/env node
// Refresh constrained implementation mappings; never invent acceptance or runtime qualification.
import { writeFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { resolve } from "node:path";
import { format } from "prettier";
import { readJsonFile } from "./lib/json.mjs";
import {
  readJiraNativeRegistry,
  reconcileJiraImplementation,
} from "./lib/jira-api-implementation.mjs";

export async function reconcileJiraApiInventory(
  file = new URL("../docs/local-knowledge/jira-api-coverage/operations.json", import.meta.url),
) {
  const ledger = reconcileJiraImplementation(readJsonFile(file), readJiraNativeRegistry());
  writeFileSync(
    file,
    await format(JSON.stringify(ledger, null, 2), { parser: "json", printWidth: 100 }),
  );
  return ledger.currentRegistry.nativeOperationCount;
}
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    if (process.argv.length !== 2) throw new TypeError("No command arguments are accepted");
    const count = await reconcileJiraApiInventory();
    process.stdout.write(
      `Reconciled ${count} constrained native tool mappings; runtime qualification unchanged.\n`,
    );
  } catch (error) {
    process.stderr.write(
      `Jira inventory reconciliation failed: ${error instanceof Error ? error.message : "invalid-input"}\n`,
    );
    process.exitCode = 1;
  }
}
