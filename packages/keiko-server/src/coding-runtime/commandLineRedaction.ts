/**
 * Masks the value of a credential-named option in one command line. The credential floor
 * (`redactCredentialShapes`) knows header, URL and token shapes but not `--password=value` or
 * `-Dpassword=value`, so the approval card applies this first and the floor second.
 *
 * Scope: the approval preview only. Widening the shared floor changes every content surface
 * (Chat, memory, history) and is a separate, ADR-0022 decision; this projection stays local to the
 * one line a person approves.
 *
 * The scan is a single linear pass: no regular expression with nested or overlapping quantifiers,
 * so a hostile line cannot cost more than its length.
 */

const MASK = "[REDACTED]";
const SENSITIVE_NAME = /(?:password|passwd|secret|token|api[_-]?key|credential|auth)/iu;

interface Token {
  readonly text: string;
  readonly space: boolean;
}

/** Splits into runs of whitespace and words; a quote keeps its whole span inside one word. */
function tokenize(line: string): readonly Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < line.length) {
    const start = index;
    const space = isSpace(line.charAt(index));
    let quote: string | undefined;
    while (index < line.length) {
      const char = line.charAt(index);
      if (quote === undefined && isSpace(char) !== space) break;
      if (!space && (char === '"' || char === "'")) {
        quote = quote === undefined ? char : quote === char ? undefined : quote;
      }
      index += 1;
    }
    tokens.push({ text: line.slice(start, index), space });
  }
  return tokens;
}

function isSpace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

/** The option name of `--name`, `--name=v`, `-Dname`, `-Dname=v`, or undefined for any other word. */
function optionName(
  word: string,
): { readonly name: string; readonly hasValue: boolean } | undefined {
  const body = word.startsWith("--") ? word.slice(2) : word.startsWith("-D") ? word.slice(2) : "";
  if (body.length === 0) return undefined;
  const equals = body.indexOf("=");
  return equals < 0
    ? { name: body, hasValue: false }
    : { name: body.slice(0, equals), hasValue: true };
}

function maskedWord(word: string): string {
  return `${word.slice(0, word.indexOf("=") + 1)}${MASK}`;
}

/** Returns the line with the value of every credential-named option replaced by a mask. */
export function redactCommandLineCredentials(line: string): string {
  const tokens = tokenize(line);
  let maskNext = false;
  return tokens
    .map((token) => {
      if (token.space) return token.text;
      const takesValue = maskNext;
      maskNext = false;
      // A following option is not the value: `--auth --verbose` masks nothing.
      if (takesValue && !token.text.startsWith("-")) return MASK;
      const option = optionName(token.text);
      if (option === undefined || !SENSITIVE_NAME.test(option.name)) return token.text;
      if (option.hasValue) return maskedWord(token.text);
      // `--password value`: only the double-dash spelling separates its value by a space.
      maskNext = token.text.startsWith("--");
      return token.text;
    })
    .join("");
}
