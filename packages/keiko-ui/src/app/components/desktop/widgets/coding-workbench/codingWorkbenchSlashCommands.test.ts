import { describe, expect, it } from "vitest";

import {
  commandNameSet,
  filterCommands,
  insertCommand,
  slashSubmission,
  slashTokenAtCursor,
  startsLikeCommand,
} from "./codingWorkbenchSlashCommands";

describe("the slash token of the draft", () => {
  it("opens while the caret is inside the first token of a draft that starts with a slash", () => {
    expect(slashTokenAtCursor("/", 1)).toEqual({ query: "", end: 1 });
    expect(slashTokenAtCursor("/rev", 4)).toEqual({ query: "rev", end: 4 });
    // Anywhere inside the first token, behind the slash, the whole token is the query.
    expect(slashTokenAtCursor("/review", 3)).toEqual({ query: "review", end: 7 });
    expect(slashTokenAtCursor("/review", 7)).toEqual({ query: "review", end: 7 });
    // The caret may stand at the end of the token, right before the whitespace that ends it.
    expect(slashTokenAtCursor("/review the changes", 7)).toEqual({ query: "review", end: 7 });
    expect(slashTokenAtCursor("/a.b_c:d-e", 5)).toEqual({ query: "a.b_c:d-e", end: 10 });
  });

  it("is closed once whitespace has been typed or the caret leaves the first token", () => {
    expect(slashTokenAtCursor("/review ", 8)).toBeNull();
    expect(slashTokenAtCursor("/review the changes", 12)).toBeNull();
    expect(slashTokenAtCursor("/review\nmore", 12)).toBeNull();
    expect(slashTokenAtCursor("/review", 0)).toBeNull();
    expect(slashTokenAtCursor("/review", -1)).toBeNull();
    expect(slashTokenAtCursor("/review", 99)).toBeNull();
  });

  it("never opens for a draft that does not start with a slash, a path or a token that is no name", () => {
    expect(slashTokenAtCursor("", 0)).toBeNull();
    expect(slashTokenAtCursor("review", 6)).toBeNull();
    expect(slashTokenAtCursor(" /review", 8)).toBeNull();
    expect(slashTokenAtCursor("say /review", 11)).toBeNull();
    expect(slashTokenAtCursor("/usr/bin", 8)).toBeNull();
    expect(slashTokenAtCursor("/a@b", 4)).toBeNull();
    expect(slashTokenAtCursor("//", 2)).toBeNull();
    expect(slashTokenAtCursor(`/${"a".repeat(65)}`, 66)).toBeNull();
    expect(slashTokenAtCursor(`/${"a".repeat(64)}`, 65)).not.toBeNull();
  });
});

describe("filtering the offered commands", () => {
  const commands = [
    { name: "init" },
    { name: "review" },
    { name: "Preview-docs" },
    { name: "x.review" },
  ];

  it("keeps every command for an empty query, in the listing's order", () => {
    expect(filterCommands(commands, "")).toEqual(commands);
  });

  it("ignores case and lists name prefixes before names that merely contain the text", () => {
    expect(filterCommands(commands, "REV").map((command) => command.name)).toEqual([
      "review",
      "Preview-docs",
      "x.review",
    ]);
    expect(filterCommands(commands, "i").map((command) => command.name)).toEqual([
      "init",
      "review",
      "Preview-docs",
      "x.review",
    ]);
    expect(filterCommands(commands, "zzz")).toEqual([]);
  });

  it("keeps the options it was given, descriptions included", () => {
    const options = [
      { name: "init", description: "Set up" },
      { name: "review", description: "Check" },
    ];
    expect(filterCommands(options, "rev")).toEqual([{ name: "review", description: "Check" }]);
  });
});

describe("choosing a command", () => {
  it("writes the command and a separating space, with the caret behind the space", () => {
    expect(insertCommand("/re", { query: "re", end: 3 }, "review")).toEqual({
      value: "/review ",
      cursor: 8,
    });
    expect(insertCommand("/", { query: "", end: 1 }, "init")).toEqual({
      value: "/init ",
      cursor: 6,
    });
  });

  it("keeps the text after the token and reuses an existing separator instead of doubling it", () => {
    expect(insertCommand("/re some text", { query: "re", end: 3 }, "review")).toEqual({
      value: "/review some text",
      cursor: 8,
    });
    expect(insertCommand("/re\nsecond line", { query: "re", end: 3 }, "review")).toEqual({
      value: "/review\nsecond line",
      cursor: 8,
    });
  });
});

describe("reading a submitted draft as a command", () => {
  const offered = commandNameSet([{ name: "init" }, { name: "review" }]);

  it("recognizes a bare command and a command with text, passing the trimmed text on", () => {
    expect(slashSubmission("/review", offered)).toEqual({
      command: { name: "review" },
      text: "",
    });
    expect(slashSubmission("/review   ", offered)).toEqual({
      command: { name: "review" },
      text: "",
    });
    expect(slashSubmission("/review  the last commit \n", offered)).toEqual({
      command: { name: "review" },
      text: "the last commit",
    });
    expect(slashSubmission("/init\nand explain", offered)).toEqual({
      command: { name: "init" },
      text: "and explain",
    });
  });

  it("keeps everything after the command, a second slash command or a mention included", () => {
    expect(slashSubmission("/review /init @src/app.ts", offered)).toEqual({
      command: { name: "review" },
      text: "/init @src/app.ts",
    });
  });

  it("reads a name that is not offered, a differently cased one and a path as ordinary text", () => {
    expect(slashSubmission("/foo bar", offered)).toBeNull();
    expect(slashSubmission("/foo", offered)).toBeNull();
    expect(slashSubmission("/Review", offered)).toBeNull();
    expect(slashSubmission("/revie", offered)).toBeNull();
    expect(slashSubmission("/review-all", offered)).toBeNull();
    expect(slashSubmission("/usr/bin/env", offered)).toBeNull();
    expect(slashSubmission("/", offered)).toBeNull();
  });

  it("reads a draft that does not open with the command as ordinary text", () => {
    expect(slashSubmission(" /review", offered)).toBeNull();
    expect(slashSubmission("please /review", offered)).toBeNull();
    expect(slashSubmission("", offered)).toBeNull();
    expect(slashSubmission("/review", new Set())).toBeNull();
  });

  it("never reads a name that only looks inherited as offered", () => {
    expect(slashSubmission("/constructor", offered)).toBeNull();
    expect(slashSubmission("/__proto__", offered)).toBeNull();
  });
});

describe("a draft that opens like a command", () => {
  it("is one for a name-shaped first token, offered or not", () => {
    expect(startsLikeCommand("/review")).toBe(true);
    expect(startsLikeCommand("/anything at all")).toBe(true);
    expect(startsLikeCommand("/a.b-c")).toBe(true);
  });

  it("is not one for ordinary text, a bare slash or a path", () => {
    expect(startsLikeCommand("")).toBe(false);
    expect(startsLikeCommand("/")).toBe(false);
    expect(startsLikeCommand("/ review")).toBe(false);
    expect(startsLikeCommand("review")).toBe(false);
    expect(startsLikeCommand("/usr/bin")).toBe(false);
    expect(startsLikeCommand(" /review")).toBe(false);
  });
});
