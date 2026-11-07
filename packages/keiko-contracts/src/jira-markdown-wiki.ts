import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";

/** Parser types stay private: consumers share the projected Jira text, never a second syntax tree. */
interface Node {
  readonly token: Token;
  readonly children: Node[];
}
interface Projection {
  readonly text: string;
  readonly convertedHeadingCount: number;
}
const MAX_CHARS = 32768;
const MAX_NESTING = 64;
const INLINE_MARKERS: Readonly<Record<string, string>> = {
  strong_open: "*",
  em_open: "_",
  s_open: "-",
};
const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
// Deliberate input validation, matching the existing rich-text field control-character boundary.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const parser = new MarkdownIt("commonmark", {
  html: true,
  linkify: false,
  typographer: false,
}).enable(["table", "strikethrough"]);
// markdown-it exposes this parser bound, although its separately published Options omits it.
Object.assign(parser.options, { maxNesting: MAX_NESTING });
// Parse every link so the writer can refuse unsafe destinations, instead of silently treating
// a refused Markdown URL as ordinary text. Nothing in this module renders HTML or fetches links.
parser.validateLink = (): boolean => true;

class UnsupportedMarkdown extends Error {}
function requireSupported(condition: boolean): asserts condition {
  if (!condition) throw new UnsupportedMarkdown("Unsupported Jira Markdown structure");
}

function tree(tokens: readonly Token[]): Node[] {
  const root: Node[] = [];
  const stack = [root];
  for (const token of tokens) {
    // Refuse before the parser's own recursion ceiling would turn deeper structure into prose.
    requireSupported(token.level < MAX_NESTING - 2);
    if (token.nesting === -1) stack.pop();
    else {
      const node = { token, children: [] };
      stack.at(-1)?.push(node);
      if (token.nesting === 1) stack.push(node.children);
    }
  }
  return root;
}

function literal(text: string): string {
  // Wiki's doubled backslash is a hard break, not a qualified literal-backslash encoding.
  requireSupported(!text.includes("\\"));
  return text.replaceAll(/[*_+^~{}[\]!|#?>-]/gu, (character) => `\\${character}`);
}
function linkTarget(token: Token): string {
  const target = token.attrGet("href") ?? "";
  requireSupported(token.attrGet("title") === null && !/[\s[\]|{}\\]/u.test(target));
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new UnsupportedMarkdown("Unsupported Jira Markdown destination");
  }
  requireSupported(LINK_PROTOCOLS.has(url.protocol) && url.username === "" && url.password === "");
  return target;
}

function inlineNode(node: Node): string {
  const { token, children } = node;
  if (token.type === "text") return literal(token.content);
  if (token.type === "softbreak") return "\n";
  if (token.type === "hardbreak") return "\\\\\n";
  if (token.type === "code_inline") {
    requireSupported(!/[{}\r\n]/u.test(token.content));
    return `{{${literal(token.content)}}}`;
  }
  const content = children.map(inlineNode).join("");
  if (token.type === "link_open") return `[${content}|${linkTarget(token)}]`;
  const marker = INLINE_MARKERS[token.type];
  requireSupported(marker !== undefined && content.length > 0 && !content.includes("\n"));
  return `${marker}${content}${marker}`;
}
function inline(node: Node): string {
  requireSupported(node.token.type === "inline");
  return tree(node.token.children ?? [])
    .map(inlineNode)
    .join("");
}

/** GFM drops excess cells. Refuse that lossy case before writing the parser's table projection. */
function tableCellCount(line: string): number {
  const text = line.trim();
  let count = 1;
  let escaped = false;
  let finalDelimiter = false;
  for (let index = 0; index < text.length; index++) {
    const character = text.charAt(index);
    finalDelimiter = character === "|" && !escaped;
    if (finalDelimiter && index > 0) count++;
    escaped = character === "\\" && !escaped;
  }
  return finalDelimiter ? count - 1 : count;
}

class WikiWriter {
  public convertedHeadingCount = 0;
  public constructor(private readonly lines: readonly string[]) {}

  public blocks(nodes: readonly Node[], list = ""): string {
    // Blank lines delimit top-level wiki blocks but would terminate a nested wiki list.
    return nodes.map((node) => this.block(node, list)).join(list === "" ? "\n\n" : "\n");
  }

  private block(node: Node, list: string): string {
    switch (node.token.type) {
      case "paragraph_open":
        return this.paragraph(node, list);
      case "heading_open":
        return this.heading(node, list);
      case "bullet_list_open":
        return this.list(node, `${list}*`);
      case "ordered_list_open":
        return this.orderedList(node, list);
      case "fence":
      case "code_block":
        requireSupported(list === "");
        return this.code(node.token);
      case "blockquote_open":
        return this.quote(node, list);
      case "hr":
        requireSupported(list === "");
        return "----";
      case "table_open":
        requireSupported(list === "");
        return this.table(node);
      default:
        throw new UnsupportedMarkdown("Unsupported Jira Markdown block");
    }
  }

  private orderedList(node: Node, list: string): string {
    requireSupported((node.token.attrGet("start") ?? "1") === "1");
    return this.list(node, `${list}#`);
  }

  private quote(node: Node, list: string): string {
    requireSupported(list === "" && node.children.length === 1);
    requireSupported(node.children[0]?.token.type === "paragraph_open");
    return `{quote}\n${this.blocks(node.children)}\n{quote}`;
  }

  private paragraph(node: Node, list: string): string {
    requireSupported(node.children.length === 1 && node.children[0] !== undefined);
    const content = inline(node.children[0]);
    requireSupported(list === "" || !content.includes("\n"));
    // A literal Markdown paragraph must not become a native Jira heading.
    return list === "" ? content.replace(/^(h[1-6]|bq)\.[ \t]/gmu, "$1\\. ") : `${list} ${content}`;
  }

  private heading(node: Node, list: string): string {
    requireSupported(list === "" && node.children.length === 1 && node.children[0] !== undefined);
    const content = inline(node.children[0]);
    requireSupported(content.length > 0 && content.length <= 200 && !content.includes("\n"));
    this.convertedHeadingCount++;
    return `${node.token.tag}. ${content}`;
  }

  private list(node: Node, marker: string): string {
    return node.children
      .map((item) => {
        requireSupported(item.token.type === "list_item_open");
        requireSupported(item.children[0]?.token.type === "paragraph_open");
        requireSupported(
          item.children
            .slice(1)
            .every(
              (child) =>
                child.token.type === "bullet_list_open" || child.token.type === "ordered_list_open",
            ),
        );
        return this.blocks(item.children, marker);
      })
      .join("\n");
  }

  private code(token: Token): string {
    requireSupported(!token.content.includes("{code}"));
    const language = token.info.trim();
    requireSupported(language === "" || /^[\w+#.-]{1,32}$/u.test(language));
    if (token.type === "fence") this.requireClosedFence(token);
    const opening = language === "" ? "{code}" : `{code:${language}}`;
    return `${opening}\n${token.content}{code}`;
  }

  private requireClosedFence(token: Token): void {
    requireSupported((token.map?.[1] ?? 0) - (token.map?.[0] ?? 0) >= 2);
    const last = this.lines[(token.map?.[1] ?? 0) - 1] ?? "";
    const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(last)?.[1];
    requireSupported(closing !== undefined);
    requireSupported(
      closing.length >= token.markup.length &&
        closing === token.markup.charAt(0).repeat(closing.length),
    );
  }

  private table(node: Node): string {
    return node.children
      .flatMap((section) =>
        section.children.map((row) => {
          const source = this.lines[row.token.map?.[0] ?? -1] ?? "";
          requireSupported(tableCellCount(source) === row.children.length);
          const separator = section.token.type === "thead_open" ? "||" : "|";
          const cells = row.children.map((cell) => {
            requireSupported(cell.token.attrs === null && cell.children.length === 1);
            const child = cell.children[0];
            requireSupported(child !== undefined);
            return inline(child) || " ";
          });
          return `${separator}${cells.join(separator)}${separator}`;
        }),
      )
      .join("\n");
  }
}

/**
 * A bounded, explicit Markdown-to-wiki writer over the existing CommonMark parser. Native strings
 * never enter this function. Unsupported structures fail as a whole; no partly converted value
 * can reach template checks, approval or Jira. Only the supported writer's literal tokens escape.
 */
export function projectMarkdownToJiraWiki(text: string): Projection | undefined {
  if (text.length > MAX_CHARS || CONTROL.test(text)) return undefined;
  const normalized = text.replace(/\r\n?/gu, "\n");
  // Mixing native block macros into an explicit Markdown document is ambiguous. Native input
  // remains available and preserves those blocks, including embedded Markdown, byte for byte.
  if (/^\s*\{(?:code|noformat)(?::[^}]*)?\}/mu.test(normalized)) return undefined;
  try {
    const writer = new WikiWriter(normalized.split("\n"));
    const projected = writer.blocks(tree(parser.parse(normalized, {})));
    if (projected.length > MAX_CHARS) return undefined;
    return { text: projected, convertedHeadingCount: writer.convertedHeadingCount };
  } catch (error) {
    if (error instanceof UnsupportedMarkdown) return undefined;
    throw error;
  }
}
