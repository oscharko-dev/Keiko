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
  | "com"
  | "str"
  | "num"
  | "lit"
  | "key"
  | "type"
  | "fn"
  | "key2"
  | "punct"
  | "head"
  | "id"
  | "ws";

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

function tokenizeLine(line: string, state: LineState, cs: CommentStyle): Token[] {
  const toks: Token[] = [];
  let i = 0;
  if (state.inBlock && cs.block !== null) {
    const end = line.indexOf(cs.block[1]);
    if (end === -1) {
      toks.push(["com", line]);
      return toks;
    }
    toks.push(["com", line.slice(0, end + cs.block[1].length)]);
    i = end + cs.block[1].length;
    state.inBlock = false;
  }
  while (i < line.length) {
    const rest = line.slice(i);
    if (cs.line !== null && rest.startsWith(cs.line)) {
      toks.push(["com", rest]);
      break;
    }
    if (cs.block !== null && rest.startsWith(cs.block[0])) {
      const end = line.indexOf(cs.block[1], i + cs.block[0].length);
      if (end === -1) {
        toks.push(["com", rest]);
        state.inBlock = true;
        break;
      }
      toks.push(["com", line.slice(i, end + cs.block[1].length)]);
      i = end + cs.block[1].length;
      continue;
    }
    const sm = /^(?:"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)/.exec(rest);
    if (sm !== null && sm[0].length > 1) {
      toks.push(["str", sm[0]]);
      i += sm[0].length;
      continue;
    }
    if (/^\d/.test(rest)) {
      const nm = /^\d[\w.]*/.exec(rest);
      const matched = nm?.[0] ?? rest.charAt(0);
      toks.push(["num", matched]);
      i += matched.length;
      continue;
    }
    const im = /^[@A-Za-z_$][\w$]*/.exec(rest);
    if (im !== null) {
      const w = im[0];
      let cls: TokenKind = "id";
      if (CODE_KW.has(w)) cls = "key";
      else if (w.startsWith("@")) cls = "type";
      else if (/^[A-Z]/.test(w)) cls = "type";
      else if (line.charAt(i + w.length) === "(") cls = "fn";
      toks.push([cls, w]);
      i += w.length;
      continue;
    }
    const wm = /^\s+/.exec(rest);
    if (wm !== null) {
      toks.push(["ws", wm[0]]);
      i += wm[0].length;
      continue;
    }
    const pm = /^[^\w\s$@]+/.exec(rest);
    if (pm !== null) {
      toks.push(["punct", pm[0]]);
      i += pm[0].length;
      continue;
    }
    toks.push(["id", rest.charAt(0)]);
    i += 1;
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
