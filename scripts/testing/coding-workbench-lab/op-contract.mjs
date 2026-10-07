// A lab tool that reads the Activity Log by operation and field name has a contract with the
// registry: when product code renames an operation or a field, the tool would print zeros without
// any error. This module compares a tool's declared contract with the generated op catalog
// (docs/observability/op-catalog.generated.json), so that drift fails loudly: at the tool's start
// and in a unit test that reads the committed catalog.
//
// A contract is { "<operation>": ["<registered field>", ...] }. Envelope fields (ts,
// correlationId, parentCorrelationId, durationMs, errorKind) are not registered fields and are not
// part of it. `prefixes` name operation families a tool matches by prefix: at least one registered
// operation must carry each.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, errorMessage } from "./lab-common.mjs";

export const OP_CATALOG_PATH = join(
  REPO_ROOT,
  "docs",
  "observability",
  "op-catalog.generated.json",
);

export function readOpCatalog(path = OP_CATALOG_PATH) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `cannot read the op catalog (${errorMessage(error)}); run the lab tools from a Keiko checkout`,
      { cause: error },
    );
  }
  return JSON.parse(text);
}

/** The registered operations of a catalog as Map<operation, Set<registered field name>>. */
export function registeredOperations(catalog) {
  const operations = catalog?.typedRegistry?.operations;
  if (!Array.isArray(operations)) {
    throw new TypeError("the op catalog has no typedRegistry.operations list");
  }
  return new Map(
    operations.map((operation) => [operation.op, new Set(Object.keys(operation.fields ?? {}))]),
  );
}

/** What the registry no longer carries of a contract, one sentence each; empty means no drift. */
export function contractDrift(contract, catalog, prefixes = []) {
  const registered = registeredOperations(catalog);
  const problems = [];
  for (const [operation, fields] of Object.entries(contract)) {
    const known = registered.get(operation);
    if (known === undefined) {
      problems.push(`operation ${operation} is not registered`);
      continue;
    }
    for (const field of fields) {
      if (!known.has(field)) problems.push(`field ${field} is not registered on ${operation}`);
    }
  }
  for (const prefix of prefixes) {
    if (![...registered.keys()].some((operation) => operation.startsWith(prefix))) {
      problems.push(`no registered operation starts with ${prefix}`);
    }
  }
  return problems;
}

/** Throws when the registry has drifted from what `tool` reads; the message names every name. */
export function assertOperationContract(tool, contract, prefixes = [], catalog = readOpCatalog()) {
  const problems = contractDrift(contract, catalog, prefixes);
  if (problems.length === 0) return;
  throw new Error(
    `${tool} reads Activity Log names the registry does not carry: ${problems.join("; ")}. Update its contract from docs/observability/op-catalog.generated.json`,
  );
}
