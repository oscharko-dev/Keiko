import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const E2E_ROOT = join(process.cwd(), "tests", "e2e");
const OWN_WEB_SERVER = /webServer:\s*[[{]/u;

function typeScriptFiles(): readonly string[] {
  return readdirSync(E2E_ROOT, { recursive: true, encoding: "utf8" }).filter((name) =>
    name.endsWith(".ts"),
  );
}

// A Playwright server is a whole product process outside vitest. Without this entry it would open
// the real login keychain of whoever runs the suite (see `realKeychainWithheld`).
describe("end-to-end server environments", () => {
  it("find the configs they guard", () => {
    const declaring = typeScriptFiles().filter((name) =>
      OWN_WEB_SERVER.test(readFileSync(join(E2E_ROOT, name), "utf8")),
    );
    expect(declaring.length).toBeGreaterThan(0);
  });

  it("turn the OS keychain off wherever a config declares its own server", () => {
    const missing = typeScriptFiles().filter((name) => {
      const source = readFileSync(join(E2E_ROOT, name), "utf8");
      return OWN_WEB_SERVER.test(source) && !source.includes('KEIKO_OS_KEYCHAIN: "off"');
    });
    expect(missing).toEqual([]);
  });
});
