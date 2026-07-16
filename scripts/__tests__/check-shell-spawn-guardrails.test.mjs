import { describe, expect, it } from "vitest";

import { scanSource } from "../check-shell-spawn-guardrails.mjs";

// ADR-0137 D5: the guardrail must be precise — provably safe `shell: false` constructs never
// require suppression markers, while every other shell option value still demands one nearby.
describe("shell spawn guardrail scan", () => {
  it.each([
    ["spaced false option", 'spawnSync(command, args, { shell: false, stdio: "inherit" });'],
    ["compact false option", "spawnSync(command, args, {shell:false});"],
    ["false option inside generated source text", '    "    shell: false,",'],
    [
      "false option inside a single-line generated spawn",
      "    '  { cwd: plan.root, env: process.env, shell: false, stdio: \"inherit\" },',",
    ],
  ])("accepts %s without a marker", (_label, line) => {
    expect(scanSource(`${line}\n`, "scripts/example.mjs")).toEqual([]);
  });

  it.each([
    ["true option", "spawnSync(npmCommand, args, { shell: true });"],
    ["computed option", "spawnSync(command, args, { shell: useShell });"],
    ["falsey-looking identifier", "spawnSync(command, args, { shell: falseish });"],
  ])("flags %s without a marker", (_label, line) => {
    expect(scanSource(`${line}\n`, "scripts/example.mjs")).toEqual([
      "scripts/example.mjs:1 uses a shell spawn option without SECURITY-SHELL-OK:",
    ]);
  });

  it("accepts a shell option justified by a marker within the lookback window", () => {
    const source = [
      "// SECURITY-SHELL-OK: npm-only Windows .cmd compatibility.",
      "spawnSync(npmCommand, args, { shell: true });",
      "",
    ].join("\n");
    expect(scanSource(source, "scripts/example.mjs")).toEqual([]);
  });

  it("flags a shell option whose marker sits beyond the lookback window", () => {
    const filler = Array.from({ length: 9 }, (_, index) => `const filler${String(index)} = 0;`);
    const source = [
      "// SECURITY-SHELL-OK: too far away to justify the spawn below.",
      ...filler,
      "spawnSync(npmCommand, args, { shell: true });",
      "",
    ].join("\n");
    expect(scanSource(source, "scripts/example.mjs")).toEqual([
      "scripts/example.mjs:11 uses a shell spawn option without SECURITY-SHELL-OK:",
    ]);
  });
});
