import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RuleTester } from "oxlint/plugins-dev";
import { NON_COSMETIC_RULES } from "../../lib/code-quality-policy.mjs";
import { withCompiledPolicyPlugin } from "../../lib/code-quality-plugin.mjs";

async function qualifyCompiledFixtures(compiled) {
  const fixtures = [];
  let category;
  let current;
  RuleTester.describe = (name, method) => {
    const previous = category;
    category = name === "valid" || name === "invalid" ? name : category;
    try {
      method();
    } finally {
      category = previous;
    }
  };
  RuleTester.it = (_name, method) => {
    const counter =
      current[category === "valid" ? "safe" : category === "invalid" ? "bad" : "unclassified"];
    counter.total++;
    try {
      method();
      counter.passed++;
    } catch {
      counter.failed++;
    }
  };
  for (const id of NON_COSMETIC_RULES.filter((rule) => !rule.startsWith("oxc/"))) {
    const [plugin, name] = id.split("/");
    current = {
      id,
      safe: { total: 0, passed: 0, failed: 0 },
      bad: { total: 0, passed: 0, failed: 0 },
      unclassified: { total: 0, passed: 0, failed: 0 },
      loadFailed: false,
    };
    const directory = plugin === "anti-slop-effect" ? "src/effect/rules" : "src/rules";
    try {
      await import(pathToFileURL(join(compiled, directory, `${name}.test.js`)).href);
    } catch {
      current.loadFailed = true;
    }
    fixtures.push(current);
  }
  return fixtures;
}

export function qualifyPolicyFixtures() {
  return withCompiledPolicyPlugin((compiled) => {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), compiled], {
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    if (result.status !== 0 || result.stderr.length > 0)
      throw new TypeError("conformance-worker-failed");
    const fixtures = JSON.parse(result.stdout);
    if (
      fixtures.length !== 21 ||
      fixtures.some(
        (entry) =>
          entry.loadFailed ||
          entry.safe.total === 0 ||
          entry.bad.total === 0 ||
          entry.safe.failed > 0 ||
          entry.bad.failed > 0 ||
          entry.unclassified.total > 0,
      )
    ) {
      throw new TypeError("conformance-fixtures-failed");
    }
    return fixtures;
  });
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  console.log(JSON.stringify(await qualifyCompiledFixtures(process.argv[2])));
}
