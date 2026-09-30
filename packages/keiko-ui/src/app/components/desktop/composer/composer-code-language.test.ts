import { describe, expect, it } from "vitest";
import { detectComposerCodeLanguage } from "./composer-code-language";

describe("fileless Composer code language detection", () => {
  it.each([
    ["typescript", "export interface Probe { readonly value: string; }"],
    ["javascript", "const answer = 42;"],
    ["java", "public class Probe {}"],
    ["go", "package main\nfunc main() {}"],
    ["rust", "fn main() {}"],
    ["python", "def probe():\n  return 42"],
    ["shell", "#!/bin/bash\necho hello"],
    ["sql", "SELECT name FROM users;"],
    ["html", "<div>hello</div>"],
    ["css", ".probe { color: red; }"],
    ["json", '{"count": 42}'],
    ["yaml", "server:\n  port: 1983"],
    ["markdown", "# Heading"],
  ])("recognizes %s syntax", (language, source) => {
    expect(detectComposerCodeLanguage(source)).toBe(language);
  });

  it("leaves unknown text unclassified and bounds the inspected prefix", () => {
    expect(detectComposerCodeLanguage("An ordinary sentence.")).toBeUndefined();
    expect(detectComposerCodeLanguage(" ".repeat(4_096) + "const answer = 42;")).toBeUndefined();
  });
});
