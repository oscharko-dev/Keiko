import { describe, expect, it } from "vitest";
import { redact } from "./redaction.js";

// The content threshold keeps ordinary text readable (credential floor only). A Git path record is
// masked when it is non-canonical, but only where a patch identifies the context or the line is a
// quoted token holding an escape that decodes in a spelling Git never writes.
const BODY = "--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-b\n+c\n";

describe("non-canonical Git path records are masked only in a diff context", () => {
  it.each([
    ["prose with a quoted word and a tail", 'copy from "x" is how a file is duplicated\n'],
    ["prose naming a UNC share", "rename to \\\\srv\\share\n"],
    ["prose naming a Windows path", "rename from C:\\work\\notes.txt to the archive\n"],
  ])("leaves %s readable", (_label, text) => {
    expect(redact(text)).toBe(text);
  });

  it("leaves prose readable after a fenced patch closed, and after its last hunk", () => {
    const prose = 'copy from "the docs" when sharing the example\n';
    const patch = `diff --git a/x.js b/x.js\n${BODY}`;
    expect(redact(`\`\`\`diff\n${patch}\`\`\`\n${prose}`)).toContain(prose);
    expect(redact(`${patch}\n${prose}`)).toContain(prose);
    const renameOnly =
      'diff --git a/x.js b/y.js\nrename from x.js\nrename to "caf\\303\\251\\147.js"\n';
    expect(redact(`\`\`\`diff\n${renameOnly}\`\`\`\n`)).not.toContain("\\147");
  });

  it("still masks a non-canonical record inside a diff", () => {
    const text = `diff --git a/x.js b/x.js\nrename from a.js\nrename to "caf\\303\\251\\147.js"\n${BODY}`;
    const redacted = redact(text);
    expect(redacted).not.toContain("\\147");
    expect(redacted).toContain("[REDACTED]");
  });

  it("still masks a quoted non-canonical record with no patch around it", () => {
    expect(redact('rename to "caf\\303\\251\\147.js"\n')).toBe("[REDACTED]\n");
  });

  it("keeps canonical quoted records of a CRLF diff", () => {
    const text = [
      'diff --git "a/caf\\303\\251.js" "b/caf\\303\\251-2.js"',
      "similarity index 90%",
      'rename from "caf\\303\\251.js"',
      'rename to "caf\\303\\251-2.js"',
      ...BODY.split("\n"),
    ].join("\r\n");
    const redacted = redact(text);
    expect(redacted).toContain('rename to "caf\\303\\251-2.js"\r\n');
    expect(redacted).toContain('rename from "caf\\303\\251.js"\r\n');
    expect(redacted).not.toContain("[REDACTED]");
  });
});
