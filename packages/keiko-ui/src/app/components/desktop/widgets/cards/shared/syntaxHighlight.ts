// Lightweight multi-language tokenizer, ported from project/highlight.jsx.
// Heuristic — fast enough for in-card previews; not a full lexer.

export type Lang =
  | "js"
  | "ts"
  | "java"
  | "kotlin"
  | "py"
  | "go"
  | "rust"
  | "json"
  | "yaml"
  | "md"
  | "html"
  | "css"
  | "sql"
  | "sh"
  | "cobol"
  | "graphql"
  | "props"
  | "docker"
  | "code";

export type TokenKind =
  "com" | "str" | "num" | "lit" | "key" | "type" | "fn" | "key2" | "punct" | "head" | "id" | "ws";

export type Token = readonly [TokenKind, string];

const EXT_LANG: Readonly<Record<string, Lang>> = {
  jsx: "js",
  js: "js",
  mjs: "js",
  ts: "ts",
  tsx: "ts",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  py: "py",
  rb: "py",
  go: "go",
  rs: "rust",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  md: "md",
  markdown: "md",
  html: "html",
  xml: "html",
  css: "css",
  sql: "sql",
  sh: "sh",
  bash: "sh",
  cob: "cobol",
  cbl: "cobol",
  gradle: "js",
  graphql: "graphql",
  gql: "graphql",
  properties: "props",
  toml: "props",
  env: "props",
  dockerfile: "docker",
};

export function langOf(name: string): Lang {
  const n = name.toLowerCase();
  if (n === ".env" || n.startsWith(".env.")) return "props";
  if (n === "dockerfile" || n.startsWith("dockerfile")) return "docker";
  if (n.includes("docker-compose")) return "yaml";
  const parts = n.split(".");
  const ext = parts.length > 1 ? parts[parts.length - 1] : undefined;
  if (ext === undefined) return "code";
  return EXT_LANG[ext] ?? "code";
}

const CODE_KW: ReadonlySet<string> = new Set(
  (
    "const let var function return if else for while do switch case break " +
    "continue import from export default class extends implements interface " +
    "enum new async await yield of in typeof instanceof this super public " +
    "private protected static final readonly void int long double float " +
    "boolean char byte short val fun object data override companion package " +
    "def pass lambda try catch except finally throw throws raise with as " +
    "not and or is null nil None True False true false undefined struct " +
    "impl trait pub use mod match where select insert update delete create " +
    "table from join on group by order limit FROM RUN CMD ENV COPY WORKDIR " +
    "EXPOSE ENTRYPOINT AS"
  ).split(" "),
);

interface CommentStyle {
  readonly line: string | null;
  readonly block: readonly [string, string] | null;
}

function commentStyle(lang: Lang): CommentStyle {
  if (lang === "py" || lang === "sh" || lang === "yaml" || lang === "props" || lang === "docker") {
    return { line: "#", block: null };
  }
  if (lang === "sql") return { line: "--", block: ["/*", "*/"] };
  if (lang === "cobol") return { line: "*>", block: null };
  if (lang === "html") return { line: null, block: ["<!--", "-->"] };
  return { line: "//", block: ["/*", "*/"] };
}

function inlineMd(s: string): Token[] {
  const out: Token[] = [];
  s.split(/(`[^`]+`|\*\*[^*]+\*\*)/).forEach((p) => {
    if (p === "") return;
    if (p.startsWith("`")) out.push(["str", p]);
    else if (p.startsWith("**")) out.push(["type", p]);
    else out.push(["id", p]);
  });
  return out.length > 0 ? out : [["id", s]];
}

function mdLines(code: string): Token[][] {
  return code.split("\n").map<Token[]>((line) => {
    if (/^#{1,6}\s/.test(line)) return [["head", line]];
    if (/^\s*```/.test(line)) return [["com", line]];
    const lm = /^(\s*)([-*+]|\d+\.)(\s)/.exec(line);
    if (lm !== null) {
      const lead = lm[1] ?? "";
      const marker = lm[2] ?? "";
      const trailWs = lm[3] ?? "";
      return [
        ["ws", lead],
        ["key", marker],
        ["ws", trailWs],
        ...inlineMd(line.slice(lm[0].length)),
      ];
    }
    return inlineMd(line);
  });
}

function jsonLines(code: string): Token[][] {
  return code.split("\n").map<Token[]>((line) => {
    const toks: Token[] = [];
    let i = 0;
    while (i < line.length) {
      const rest = line.slice(i);
      const sm = /^"(?:[^"\\]|\\.)*"/.exec(rest);
      if (sm !== null) {
        const tail = line.slice(i + sm[0].length);
        const isKey = /^\s*:/.test(tail);
        toks.push([isKey ? "key2" : "str", sm[0]]);
        i += sm[0].length;
        continue;
      }
      const nm = /^-?\d[\d.eE+\-]*/.exec(rest);
      if (nm !== null) {
        toks.push(["num", nm[0]]);
        i += nm[0].length;
        continue;
      }
      const lm = /^(true|false|null)\b/.exec(rest);
      if (lm !== null) {
        toks.push(["lit", lm[0]]);
        i += lm[0].length;
        continue;
      }
      const wm = /^\s+/.exec(rest);
      if (wm !== null) {
        toks.push(["ws", wm[0]]);
        i += wm[0].length;
        continue;
      }
      toks.push(["punct", rest.charAt(0)]);
      i += 1;
    }
    return toks;
  });
}

interface LineState {
  inBlock: boolean;
}

interface TokenChunk {
  readonly token: Token;
  readonly length: number;
}

interface TokenStep extends TokenChunk {
  readonly stop: boolean;
}

interface MatchContext {
  readonly line: string;
  readonly i: number;
  readonly rest: string;
  readonly cs: CommentStyle;
  readonly state: LineState;
}

type TokenMatcher = (ctx: MatchContext) => TokenStep | null;

// Consumes the rest of an already-open block comment carried over from a previous line.
function continueOpenBlockComment(
  line: string,
  state: LineState,
  cs: CommentStyle,
): TokenChunk | null {
  if (!state.inBlock || cs.block === null) return null;
  const end = line.indexOf(cs.block[1]);
  if (end === -1) {
    return { token: ["com", line], length: line.length };
  }
  const closeIndex = end + cs.block[1].length;
  state.inBlock = false;
  return { token: ["com", line.slice(0, closeIndex)], length: closeIndex };
}

function matchLineComment(ctx: MatchContext): TokenStep | null {
  if (ctx.cs.line === null || !ctx.rest.startsWith(ctx.cs.line)) return null;
  return { token: ["com", ctx.rest], length: ctx.rest.length, stop: true };
}

function matchBlockCommentOpen(ctx: MatchContext): TokenStep | null {
  const { cs, rest, line, i, state } = ctx;
  if (cs.block === null || !rest.startsWith(cs.block[0])) return null;
  const end = line.indexOf(cs.block[1], i + cs.block[0].length);
  if (end === -1) {
    state.inBlock = true;
    return { token: ["com", rest], length: rest.length, stop: true };
  }
  const closeIndex = end + cs.block[1].length;
  return { token: ["com", line.slice(i, closeIndex)], length: closeIndex - i, stop: false };
}

function matchString(ctx: MatchContext): TokenStep | null {
  const sm = /^(?:"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)/.exec(ctx.rest);
  if (sm === null || sm[0].length <= 1) return null;
  return { token: ["str", sm[0]], length: sm[0].length, stop: false };
}

function matchNumber(ctx: MatchContext): TokenStep | null {
  if (!/^\d/.test(ctx.rest)) return null;
  const nm = /^\d[\w.]*/.exec(ctx.rest);
  const matched = nm?.[0] ?? ctx.rest.charAt(0);
  return { token: ["num", matched], length: matched.length, stop: false };
}

function classifyIdentifier(word: string, line: string, i: number): TokenKind {
  if (CODE_KW.has(word) || CODE_KW.has(word.toLowerCase())) return "key";
  if (word.startsWith("@")) return "type";
  if (/^[A-Z]/.test(word)) return "type";
  if (line.charAt(i + word.length) === "(") return "fn";
  return "id";
}

function matchIdentifier(ctx: MatchContext): TokenStep | null {
  const im = /^[@A-Za-z_$][\w$]*/.exec(ctx.rest);
  if (im === null) return null;
  const w = im[0];
  const cls = classifyIdentifier(w, ctx.line, ctx.i);
  return { token: [cls, w], length: w.length, stop: false };
}

function matchWhitespace(ctx: MatchContext): TokenStep | null {
  const wm = /^\s+/.exec(ctx.rest);
  if (wm === null) return null;
  return { token: ["ws", wm[0]], length: wm[0].length, stop: false };
}

function matchPunctuation(ctx: MatchContext): TokenStep | null {
  const pm = /^[^\w\s$@"']+/.exec(ctx.rest);
  if (pm === null) return null;
  return { token: ["punct", pm[0]], length: pm[0].length, stop: false };
}

const TOKEN_MATCHERS: readonly TokenMatcher[] = [
  matchLineComment,
  matchBlockCommentOpen,
  matchString,
  matchNumber,
  matchIdentifier,
  matchWhitespace,
  matchPunctuation,
];

// Tries each matcher in priority order; falls back to a single raw character.
function nextToken(ctx: MatchContext): TokenStep {
  for (const matcher of TOKEN_MATCHERS) {
    const step = matcher(ctx);
    if (step !== null) return step;
  }
  return { token: ["id", ctx.rest.charAt(0)], length: 1, stop: false };
}

function tokenizeLine(line: string, state: LineState, cs: CommentStyle): Token[] {
  const toks: Token[] = [];
  let i = 0;
  const opening = continueOpenBlockComment(line, state, cs);
  if (opening !== null) {
    toks.push(opening.token);
    i = opening.length;
  }
  while (i < line.length) {
    const step = nextToken({ line, i, rest: line.slice(i), cs, state });
    toks.push(step.token);
    i += step.length;
    if (step.stop) break;
  }
  return toks;
}

function codeLines(code: string, lang: Lang): Token[][] {
  const cs = commentStyle(lang);
  const state: LineState = { inBlock: false };
  const out: Token[][] = [];
  for (const line of code.split("\n")) {
    out.push(tokenizeLine(line, state, cs));
  }
  return out;
}

export function highlightLines(code: string, lang: Lang): Token[][] {
  if (lang === "md") return mdLines(code);
  if (lang === "json") return jsonLines(code);
  return codeLines(code, lang);
}
