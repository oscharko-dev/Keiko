import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sourcesUnder(directory: string, extensions: readonly string[]): readonly string[] {
  return readdirSync(join(process.cwd(), directory), { recursive: true, encoding: "utf8" })
    .filter((name) => extensions.some((extension) => name.endsWith(extension)))
    .map((name) => join(directory, name));
}

function missingSwitch(paths: readonly string[], startsProduct: RegExp): readonly string[] {
  return paths.filter((path) => {
    const source = readFileSync(join(process.cwd(), path), "utf8");
    return startsProduct.test(source) && !source.includes('KEIKO_OS_KEYCHAIN: "off"');
  });
}

// A Playwright server or a script started from a shell is a whole product process outside vitest.
// Without this entry it opens the real login keychain of whoever runs it (`realKeychainWithheld`).
describe("product processes started outside vitest", () => {
  it("turn the OS keychain off in every end-to-end config declaring its own server", () => {
    const configs = sourcesUnder("tests/e2e", [".ts"]);
    const ownServer = /webServer:\s*[[{]/u;
    expect(configs.some((path) => ownServer.test(readFileSync(path, "utf8")))).toBe(true);
    expect(missingSwitch(configs, ownServer)).toEqual([]);
  });

  it("turn the OS keychain off in every script that composes the product", () => {
    // `dev-bff.mjs` is what `npm run dev:start` runs on purpose: a person's own dev instance.
    const scripts = sourcesUnder("scripts", [".mjs"]).filter(
      (path) => !path.includes("__tests__") && !path.endsWith("dev-bff.mjs"),
    );
    const composesProduct = /buildUiHandlerDeps\(/u;
    expect(scripts.some((path) => readFileSync(path, "utf8").includes("buildUiHandlerDeps("))).toBe(
      true,
    );
    expect(missingSwitch(scripts, composesProduct)).toEqual([]);
  });
});
