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
    expect(source).toContain("assertUnreadable(libc, overwriteValues(libc))");
    expect(source).toContain("throw new Error('launch-secret-readable')");
    expect(source).toContain("throw new Error('process-arguments-unavailable')");
  });

  it("withholds the bindings from what the runtime's children inherit, and checks that", () => {
    expect(source).toContain("withholdFromChildren();");
    expect(source).toContain("throw new Error('launch-secret-inherited')");
    expect(source).toContain("name.startsWith('KEIKO_')");
  });

  it("is required for a native run to become ready", () => {
    expect(OPENCODE_NATIVE_REQUIRED_PLUGINS).toContainEqual({
      id: "keiko.launch-secrets",
      file: "keiko_launch_secrets.ts",
    });
  });
});
