import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createStreamingRedactor, redact } from "./redaction.js";

const PRIVATE_VALUE = "fixture_value_q82";
const SOURCES = [
  ["typed assignment", `const password: string = "${PRIVATE_VALUE}";`, "ts", true],
  ["escaped JSON key", `{"pass\\u0077ord":"${PRIVATE_VALUE}","public":"kept"}`, "json", true],
  ["ordinary assignment", `const password = "${PRIVATE_VALUE}";`, "ts", true],
  ["public interface", "interface Input { password: string; }", "ts", false],
  ["public parameter", "function reserve(token: string) { return token; }", "ts", false],
] as const;

function representations(source: string, language: string): readonly string[] {
  return [
    `Example \`${source}\` done.`,
    `Example \`\`${source}\`\` done.`,
    `\`\`\`${language}\n${source}\n\`\`\`\n`,
    source,
  ];
}

function assertStreaming(
  text: string,
  expected: string,
  privateExpected: boolean,
  partitionGroup?: number,
): void {
  const partitions = [
    Array.from({ length: text.length }, (_, index) => text.slice(index, index + 1)),
    ...Array.from({ length: text.length - 1 }, (_, index) => [
      text.slice(0, index + 1),
      text.slice(index + 1),
    ]),
  ];
  for (const [index, parts] of partitions.entries()) {
    if (partitionGroup !== undefined && index % 4 !== partitionGroup) continue;
    const stream = createStreamingRedactor(redact);
    let actual = "";
    for (const part of parts) {
      actual += stream.push(part);
      if (privateExpected) expect(actual).not.toContain(PRIVATE_VALUE);
    }
    actual += stream.finish();
    if (privateExpected) expect(actual).not.toContain(PRIVATE_VALUE);
    expect(actual).toBe(expected);
  }
}

describe("source-aware redaction across Markdown inline boundaries", () => {
  it.each(["Public prose! ", "&copy; public prose "])(
    "bounds overlapping unresolved hints (%j) under the existing two-second child deadline",
    (body) => {
      const input = Array.from({ length: 1_500 }, (_, index) => "`".repeat(index + 1) + body).join(
        " ",
      );
      const moduleUrl = new URL("../dist/redaction.js", import.meta.url).href;
      const script = `import {readFileSync} from 'node:fs';
        const {redact}=await import(${JSON.stringify(moduleUrl)});
        const text=readFileSync(0,'utf8');
        process.stdout.write(JSON.stringify({unchanged:redact(text)===text}));`;
      const result: unknown = JSON.parse(
        execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
          encoding: "utf8",
          input,
          timeout: 2_000,
          killSignal: "SIGKILL",
        }),
      );
      expect(result).toEqual({ unchanged: true });
    },
  );

  it.each(SOURCES)(
    "projects complete %s through the same language owner",
    (_, source, language, privateExpected) => {
      for (const text of representations(source, language)) {
        const result = redact(text);
        if (privateExpected) expect(result).not.toContain(PRIVATE_VALUE);
        else expect(result).toBe(text);
        expect(redact(result)).toBe(result);
        assertStreaming(text, result, privateExpected);
      }
    },
  );

  it.each(["`", "``"])("retains private context in a multiline %s span", (ticks) => {
    const source = `const password: string = "${PRIVATE_VALUE}";\nconst visible = 1;`;
    const text = `Example ${ticks}${source}${ticks} done.\n`;
    const result = redact(text);
    expect(result).not.toContain(PRIVATE_VALUE);
    expect(result).toContain("const visible = 1;");
    assertStreaming(text, result, true);
  });

  it.each(["`", "``"])("protects typed source after an unresolved %s hint", (ticks) => {
    const text = `Example ${ticks}const password: string = "${PRIVATE_VALUE}";\n`;
    const result = redact(text);
    expect(result).not.toContain(PRIVATE_VALUE);
    expect(redact(result)).toBe(result);
    assertStreaming(text, result, true);
  });

  it.each(["`", "``"])("keeps strict plain credential handling inside %s", (ticks) => {
    const text = `Example ${ticks}token: ${PRIVATE_VALUE}${ticks} done.\n`;
    const result = redact(text);
    expect(result).not.toContain(PRIVATE_VALUE);
    assertStreaming(text, result, true);
  });

  it("does not treat a sensitive word alone in an unresolved scalar hint as a value", () => {
    const text = "Explain `&copy; password field\n";
    expect(redact(text)).toBe(text);
    assertStreaming(text, text, false);
  });

  it.each(["&copy; public prose", "import"])(
    "does not lose private source after a declined %s hint",
    (prefix) => {
      const text = `Example \`${prefix} \`\`const password: string = "${PRIVATE_VALUE}";\n`;
      const result = redact(text);
      expect(result).not.toContain(PRIVATE_VALUE);
      assertStreaming(text, result, true);
    },
  );

  it.each(
    ["`", "``"].flatMap((ticks) =>
      (
        [
          ["before", `PUBLIC: visible\nconst password: string = "${PRIVATE_VALUE}";\n`],
          ["after", `const password: string = "${PRIVATE_VALUE}";\nPUBLIC: visible\n`],
        ] as const
      ).flatMap(([position, body]) =>
        Array.from({ length: 4 }, (_, group) => ({ ticks, position, body, group })),
      ),
    ),
  )(
    "projects every source with public data $position inside $ticks (partition group $group)",
    ({ ticks, body, group }) => {
      const text = `Example ${ticks}${body}${ticks} public tail.\n`;
      const result = redact(text);
      expect(result).not.toContain(PRIVATE_VALUE);
      expect(result).toContain("public tail.");
      assertStreaming(text, result, true, group);
    },
  );

  it.each(["`", "``"])("discards unresolved %s context when its consumer cancels", (ticks) => {
    const cancelled = createStreamingRedactor(redact);
    expect(cancelled.push("Public sentence.\n")).toBe("Public sentence.\n");
    expect(cancelled.push(`Example ${ticks}const password: string = "${PRIVATE_VALUE}";\n`)).toBe(
      "",
    );
    expect(cancelled.push("const visible = 1;\n")).toBe("");
    expect(cancelled.observe().pendingChars).toBeGreaterThan(0);
    // Cancelled consumers discard this instance instead of authorizing finish().
    const replacement = createStreamingRedactor(redact);
    expect(replacement.push("A new public sentence.\n") + replacement.finish()).toBe(
      "A new public sentence.\n",
    );
  });
});
