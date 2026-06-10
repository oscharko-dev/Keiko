import { describe, expect, it } from "vitest";
import { parseFigmaTarget } from "../figmaUrl.js";

describe("parseFigmaTarget — generic, deterministic", () => {
  it("parses a /design/ link with a node-id and normalises - to :", () => {
    const target = parseFigmaTarget(
      "https://www.figma.com/design/AbC123Key/My-Board?node-id=12-345&t=xyz",
    );
    expect(target).toEqual({ fileKey: "AbC123Key", nodeId: "12:345" });
  });

  it("parses the legacy /file/ link form", () => {
    const target = parseFigmaTarget("https://www.figma.com/file/KEY99/Whatever?node-id=0-1");
    expect(target).toEqual({ fileKey: "KEY99", nodeId: "0:1" });
  });

  it("keeps an already-colonised node-id intact", () => {
    const target = parseFigmaTarget("https://figma.com/design/K/Name?node-id=7:8");
    expect(target).toEqual({ fileKey: "K", nodeId: "7:8" });
  });

  it("accepts a board/section link without a www subdomain", () => {
    const target = parseFigmaTarget("https://figma.com/design/Key2/N?node-id=3-4");
    expect(target?.fileKey).toBe("Key2");
    expect(target?.nodeId).toBe("3:4");
  });

  it("rejects a whole-file link that has no node-id (never default to whole file)", () => {
    expect(parseFigmaTarget("https://www.figma.com/design/AbC123Key/My-Board")).toBeNull();
    expect(parseFigmaTarget("https://www.figma.com/design/AbC123Key/My-Board?t=xyz")).toBeNull();
  });

  it("rejects an empty node-id", () => {
    expect(parseFigmaTarget("https://www.figma.com/design/KEY/Name?node-id=")).toBeNull();
  });

  it("rejects non-figma hosts", () => {
    expect(parseFigmaTarget("https://evil.example.com/design/KEY/N?node-id=1-2")).toBeNull();
    expect(parseFigmaTarget("https://figma.com.evil.com/design/KEY/N?node-id=1-2")).toBeNull();
  });

  it("rejects malformed and non-design paths", () => {
    expect(parseFigmaTarget("not a url")).toBeNull();
    expect(parseFigmaTarget("https://www.figma.com/")).toBeNull();
    expect(parseFigmaTarget("https://www.figma.com/proto/KEY/N?node-id=1-2")).toBeNull();
    expect(parseFigmaTarget("https://www.figma.com/design/?node-id=1-2")).toBeNull();
  });

  it("rejects empty and non-string input", () => {
    expect(parseFigmaTarget("")).toBeNull();
    expect(parseFigmaTarget("   ")).toBeNull();
  });
});
