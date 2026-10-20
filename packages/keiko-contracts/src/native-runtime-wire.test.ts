import { describe, expect, it } from "vitest";
import {
  encodeAppEnvironmentPacket,
  encodeLaunchPacket,
  type NativeRuntimeLaunchPacketInput,
} from "./native-runtime-wire.js";

const paths = { executable: "/runtime/node", cwd: "/workspace" };
const request: NativeRuntimeLaunchPacketInput = {
  recoveryHandle: "a".repeat(32),
  args: [],
  env: {},
};

describe("native runtime wire limits", () => {
  it("carries a bounded large app environment separately from the generic launch", () => {
    const env = Object.fromEntries(
      Array.from({ length: 140 }, (_, i) => [`KEY_${String(i)}`, "value"]),
    );
    const packet = encodeAppEnvironmentPacket(env);
    expect(packet.subarray(0, 4).toString()).toBe("KAE1");
    expect(packet.readUInt16LE(14)).toBe(140);
    expect(packet.includes(Buffer.from("KEY_139=value"))).toBe(true);
    expect(() => {
      encodeLaunchPacket({ ...request, env }, paths);
    }).toThrow();
  });

  it.each([
    { VALUE: "nul\0value" },
    { VALUE: "x".repeat(16385) },
    { "BAD=NAME": "value" },
    Object.fromEntries(Array.from({ length: 4097 }, (_, i) => [`KEY_${String(i)}`, "value"])),
    Object.fromEntries(
      Array.from({ length: 140 }, (_, i) => [`KEY_${String(i)}`, "x".repeat(1024)]),
    ),
  ])("refuses invalid or oversized app data before native spawning (%#)", (env) => {
    expect(() => {
      encodeAppEnvironmentPacket(env);
    }).toThrow();
  });

  it("retains the generic 64-entry environment limit", () => {
    const env = Object.fromEntries(
      Array.from({ length: 64 }, (_, i) => [`KEY_${String(i)}`, "value"]),
    );
    expect(() => {
      encodeLaunchPacket({ ...request, env }, paths);
    }).not.toThrow();
    expect(() => {
      encodeLaunchPacket({ ...request, env: { ...env, EXTRA: "value" } }, paths);
    }).toThrow();
  });

  it("refuses individually oversized values and aggregate packets", () => {
    expect(() => {
      encodeLaunchPacket({ ...request, env: { VALUE: "x".repeat(16385) } }, paths);
    }).toThrow();
    const env = Object.fromEntries(
      Array.from({ length: 64 }, (_, i) => [`KEY_${String(i)}`, "x".repeat(2048)]),
    );
    expect(() => {
      encodeLaunchPacket({ ...request, env }, paths);
    }).toThrow();
  });

  it.each([
    { ...request, recoveryHandle: "A".repeat(32) },
    { ...request, args: ["nul\0argument"] },
    { ...request, env: { "BAD-NAME": "value" } },
    { ...request, env: { VALUE: "nul\0value" } },
  ])("refuses a malformed packet before an owner is spawned (%#)", (input) => {
    expect(() => {
      encodeLaunchPacket(input, paths);
    }).toThrow();
  });

  it("keeps path length validation separate from the argument limit", () => {
    expect(() => {
      encodeLaunchPacket(request, { ...paths, executable: `/runtime/${"x".repeat(5000)}` });
    }).not.toThrow();
    expect(() => {
      encodeLaunchPacket({ ...request, args: ["x".repeat(4097)] }, paths);
    }).toThrow();
  });
});
