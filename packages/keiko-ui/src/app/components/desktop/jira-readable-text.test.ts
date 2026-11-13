import { describe, expect, it } from "vitest";
import { jiraReadableText } from "./jira-readable-text";

describe("jiraReadableText", () => {
  it("drops the heading marker and keeps the heading text", () => {
    expect(jiraReadableText("h2. Ziel\nDas Ziel ist klar.")).toBe("Ziel\nDas Ziel ist klar.");
  });

  it("reads bullets, nesting, emphasis, monospace and links as plain text", () => {
    const wiki = [
      "h3. Scope",
      "* first *important* point",
      "** nested _detail_",
      "See {{config.json}} and [the guide|https://docs.example.test/guide] or [https://x.example.test].",
    ].join("\n");
    expect(jiraReadableText(wiki)).toBe(
      [
        "Scope",
        "• first important point",
        "  • nested detail",
        "See config.json and the guide (https://docs.example.test/guide) or https://x.example.test.",
      ].join("\n"),
    );
  });

  it("drops code and panel fences and colour macros but keeps their content", () => {
    const wiki = "{code:java}\nint a = 1;\n{code}\n{color:red}warning{color}\n----\nend";
    expect(jiraReadableText(wiki)).toBe("int a = 1;\nwarning\nend");
  });

  it("reads table rows as cells separated by a dot", () => {
    expect(jiraReadableText("||Name||Value||\n|alpha|1|")).toBe("Name · Value\nalpha · 1");
  });

  it("leaves text without wiki markup unchanged", () => {
    const plain = "A plain sentence with 2 * 3 = 6, a snake_case name and **markdown bold**.";
    expect(jiraReadableText(plain)).toBe(plain);
  });

  it("leaves a lone asterisk or underscore alone", () => {
    expect(jiraReadableText("price * quantity and file_name_ here")).toBe(
      "price * quantity and file_name_ here",
    );
  });
});
