import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createGeneratedOpenCodeLaunchSecretsPlugin } from "./opencodeNativeLaunchSecrets.js";
import { OPENCODE_NATIVE_REQUIRED_PLUGINS } from "./opencodeNativePluginReadiness.js";

// The behaviour is proved against the pinned runtime in opencodeNativeQualification.real.test.ts,
// where bun:ffi exists; these pin what a change of this source could quietly drop.
describe("launch secrets plugin source", () => {
  const source = createGeneratedOpenCodeLaunchSecretsPlugin();

  it.each([
    "OPENCODE_SERVER_PASSWORD",
    "OPENCODE_CONFIG_CONTENT",
    "KEIKO_MODEL_GATEWAY_CAPABILITY",
    "KEIKO_TOOL_FACADE_CAPABILITY",
  ])("overwrites %s", (name) => {
    expect(source).toContain(`"${name}"`);
  });

  it("reads the kernel's answer back and fails the plugin when a value survived", () => {
    // The values the runtime still holds count too: a build whose C environment no longer names them
    // must not pass with nothing to compare.
    expect(source).toContain("assertUnreadable(libc, [...overwriteValues(libc), ...known])");
    expect(source).toContain("throw new Error('launch-secret-readable')");
    expect(source).toContain("throw new Error('process-arguments-unavailable')");
  });

  it("withholds the bindings from what the runtime's children inherit, and checks that", () => {
    expect(source).toContain("withholdFromChildren();");
    expect(source).toContain("throw new Error('launch-secret-inherited')");
    expect(source).toContain("name.startsWith('KEIKO_')");
  });

  // A plugin set reloads from its first changed revision and a new location loads its own, so setup
  // can run twice in one runtime. The runtime reads these names again when it reloads its
  // configuration: a second setup must not lose them, and they must stay hidden from a spread.
  it("keeps every withheld binding readable by name across a second setup", () => {
    const script = [
      "Object.defineProperty(process, 'platform', { value: 'linux' });",
      source.replace(/^import .*bun:ffi.*$/mu, "").replace("export default {", "const plugin = {"),
      "await plugin.setup();",
      "await plugin.setup();",
      "console.log(JSON.stringify({",
      "  byName: [process.env.OPENCODE_SERVER_PASSWORD, process.env.KEIKO_EXAMPLE],",
      "  spread: Object.keys({ ...process.env }),",
      "  ordinary: process.env.ORDINARY,",
      "}));",
    ].join("\n");
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: {
        OPENCODE_SERVER_PASSWORD: "synthetic-password",
        KEIKO_EXAMPLE: "synthetic-binding",
        ORDINARY: "kept",
      },
    });
    expect(run.status).toBe(0);
    const answer = JSON.parse(run.stdout) as {
      readonly byName: readonly string[];
      readonly spread: readonly string[];
      readonly ordinary: string;
    };
    expect(answer.byName).toEqual(["synthetic-password", "synthetic-binding"]);
    expect(answer.ordinary).toBe("kept");
    expect(answer.spread).toContain("ORDINARY");
    expect(answer.spread).not.toContain("OPENCODE_SERVER_PASSWORD");
    expect(answer.spread).not.toContain("KEIKO_EXAMPLE");
  });

  it("is required for a native run to become ready", () => {
    expect(OPENCODE_NATIVE_REQUIRED_PLUGINS).toContainEqual({
      id: "keiko.launch-secrets",
      file: "keiko_launch_secrets.ts",
    });
  });
});
