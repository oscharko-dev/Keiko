import { describe, expect, it } from "vitest";
import { redact } from "./redaction.js";

// #4114: a diff view of the user's own repository keeps hunks that do not parse on their own
// readable under the credential floor, as standalone OpenCode shows them. Patch construction
// derives the physical line counts from the supplied fixture; no expectation is computed.
function patch(path: string, body: readonly string[]): string {
  const before = body.filter((line) => !line.startsWith("+")).length;
  const after = body.filter((line) => !line.startsWith("-")).length;
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${String(before)} +1,${String(after)} @@`,
    ...body,
  ]
    .map((line) => line + "\n")
    .join("");
}

const configuredSecret = ["fixture", "floor", "q41"].join("_");
const githubToken = "ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789";
// A made-up key block, assembled at run time so the source carries no private-key literal.
const keyLabel = ["RSA", "PRIVATE", "KEY"].join(" ");
const keyBlock = [
  `-----BEGIN ${keyLabel}-----`,
  ["MIIEowIBAAKCAQEA", "uZ9b5XyQ", "floorfixture"].join(""),
  `-----END ${keyLabel}-----`,
];
const rowRename = patch("stations.ts", [
  "-  { id: 0, elevationM: 0 },",
  "+  { id: 0, elevationMeters: 0 },",
  "   { id: 1, elevationM: 3 },",
]);

function floorRedact(
  input: string,
  secrets: readonly string[] = [],
): {
  readonly output: string;
  readonly fallbacks: number;
} {
  let fallbacks = 0;
  const output = redact(input, secrets, {
    unparsedDiffHunks: "credential-floor",
    onUnparsedDiffHunkFloor: () => {
      fallbacks += 1;
    },
  });
  return { output, fallbacks };
}

describe("unified diff credential floor for unparsed hunks (#4114)", () => {
  it("masks an unparsed hunk whole for every caller that does not opt in", () => {
    const output = redact(rowRename);
    expect(output).not.toContain("elevationMeters");
    expect(output).toContain("[REDACTED]");
    expect(redact(rowRename, [], { unparsedDiffHunks: "mask" })).toBe(output);
  });

  it("keeps an unparsed hunk readable under the credential floor", () => {
    const { output, fallbacks } = floorRedact(rowRename);
    expect(output).toBe(rowRename);
    expect(fallbacks).toBe(1);
  });

  it("keeps a deletion-only unparsed hunk readable", () => {
    const input = patch("rows.ts", [
      "-  { id: 0, elevationM: 0 },",
      "-  { id: 1, elevationM: 3 },",
    ]);
    const { output, fallbacks } = floorRedact(input);
    expect(output).toBe(input);
    expect(fallbacks).toBe(1);
  });

  it("still masks token shapes and configured secrets inside a floored hunk", () => {
    const input = patch("config.ts", [
      `-  { token: "${githubToken}" },`,
      `+  { token: "${configuredSecret}" },`,
      "   { id: 1 },",
    ]);
    const { output, fallbacks } = floorRedact(input, [configuredSecret]);
    expect(fallbacks).toBe(1);
    expect(output).not.toContain(githubToken);
    expect(output).not.toContain(configuredSecret);
    expect(output).toContain("   { id: 1 },\n");
    expect(output.split("\n")).toHaveLength(input.split("\n").length);
  });

  it("finds a private key that spans hunk lines and keeps the line structure", () => {
    const input = patch("keys.ts", ["   [", ...keyBlock.map((line) => "+" + line), "   ],"]);
    const { output, fallbacks } = floorRedact(input);
    expect(fallbacks).toBe(1);
    for (const line of keyBlock) expect(output).not.toContain(line);
    expect(output).toContain("   [\n");
    expect(output).toContain("   ],\n");
    expect(output.split("\n")).toHaveLength(input.split("\n").length);
  });

  it("masks a private literal found in another file of the same diff", () => {
    const value = ["floor", "private", "q77"].join("-");
    const input =
      patch("secret.ts", [`+const password = "${value}";`]) +
      patch("rows.ts", [`-  { id: 0, note: "${value}" },`, `+  { id: 0, note: "x" },`]);
    expect(redact(input)).not.toContain(value);
    const { output, fallbacks } = floorRedact(input);
    expect(fallbacks).toBe(1);
    expect(output).not.toContain(value);
    expect(output).toContain('+  { id: 0, note: "x" },\n');
  });

  it("does not fall back for a hunk that parses", () => {
    const input = patch("total.ts", [
      "-const total = a + b;",
      "+const total = a + b + c;",
      " export { total };",
    ]);
    const { output, fallbacks } = floorRedact(input);
    expect(output).toBe(input);
    expect(fallbacks).toBe(0);
  });

  it("keeps whole masking for a diff refused for its size", () => {
    const row = "-  { id: 0, elevationM: 0 },";
    const input = patch("huge.ts", [
      ...Array.from({ length: 80_000 }, () => row),
      "+  { id: 0, elevationMeters: 0 },",
    ]);
    const { output, fallbacks } = floorRedact(input);
    expect(fallbacks).toBe(0);
    expect(output).not.toContain("elevationMeters");
  });
});
