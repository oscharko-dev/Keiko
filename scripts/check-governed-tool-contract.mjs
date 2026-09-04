#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isMainModule } from "./lib/is-main-module.mjs";
import {
  checkContractExamples,
  checkInventoryProbes,
  validateGovernedToolContract,
} from "./lib/governed-tool-contract.mjs";

export function checkGovernedToolContract(root = process.cwd()) {
  const contract = JSON.parse(
    readFileSync(join(root, "docs/architecture/governed-tool-contract.v1.json"), "utf8"),
  );
  return [
    ...validateGovernedToolContract(contract),
    ...checkContractExamples(contract),
    ...checkInventoryProbes(contract, root),
  ];
}
if (isMainModule(import.meta.url)) {
  const errors = checkGovernedToolContract();
  for (const error of errors) console.error(`governed-tool-contract: ${error}`);
  console.log(
    `governed-tool-contract: ${errors.length === 0 ? "PASS" : "FAIL"} — architecture only; no runtime qualification`,
  );
  process.exitCode = errors.length === 0 ? 0 : 1;
}

export function checkGovernedToolContractNegatives(root = process.cwd()) {
  const contract = JSON.parse(
    readFileSync(join(root, "docs/architecture/governed-tool-contract.v1.json"), "utf8"),
  );
  const mutations = JSON.parse(
    readFileSync(
      join(root, "tests/architecture/fixtures/governed-tool-contract/omissions.json"),
      "utf8",
    ),
  );
  const errors = [];
  for (const mutation of mutations) {
    const fixture = structuredClone(contract);
    const target = mutation.path.slice(0, -1).reduce((value, key) => value[key], fixture);
    Reflect.deleteProperty(target, mutation.path.at(-1));
    if (
      !validateGovernedToolContract(fixture).some((error) => error.startsWith(mutation.expected))
    ) {
      errors.push(`negative contract fixture did not fail: ${mutation.path.join(".")}`);
    }
  }
  if (mutations.length < 6) errors.push("missing architecture consistency negatives");
  return errors;
}
