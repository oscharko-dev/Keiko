import { Buffer } from "node:buffer";
import type { IncomingMessage } from "node:http";

import type { RouteResult } from "./routes.js";

class FeedbackBodyTooLargeError extends Error {}

interface ParsedString {
  readonly value: string;
}

class JsonDuplicateKeyScanner {
  private index = 0;
  private depth = 0;

  public constructor(private readonly text: string) {}

  public accepts(): boolean {
    this.skipWhitespace();
    if (!this.parseValue()) return false;
    this.skipWhitespace();
    return this.index === this.text.length;
  }

  private skipWhitespace(): void {
    while (this.index < this.text.length && " \n\r\t".includes(this.text[this.index] ?? "")) {
      this.index += 1;
    }
  }

  private parseValue(): boolean {
    this.skipWhitespace();
    const current = this.text[this.index];
    if (current === "{") return this.parseObject();
    if (current === "[") return this.parseArray();
    if (current === '"') return this.parseString() !== undefined;
    if (current === "t") return this.parseLiteral("true");
    if (current === "f") return this.parseLiteral("false");
    if (current === "n") return this.parseLiteral("null");
    return this.isNumberStart(current) && this.parseNumber();
  }

  private isNumberStart(value: string | undefined): boolean {
    return value === "-" || (value !== undefined && value >= "0" && value <= "9");
  }

  private parseLiteral(value: string): boolean {
    if (!this.text.startsWith(value, this.index)) return false;
    this.index += value.length;
    return true;
  }

  private consumeDigits(): number {
    const start = this.index;
    while ((this.text[this.index] ?? "") >= "0" && (this.text[this.index] ?? "") <= "9") {
      this.index += 1;
    }
    return this.index - start;
  }

  private parseNumber(): boolean {
    if (this.text[this.index] === "-") this.index += 1;
    if (this.text[this.index] === "0") this.index += 1;
    else if (this.consumeDigits() === 0) return false;
    return this.parseFraction() && this.parseExponent();
  }

  private parseFraction(): boolean {
    if (this.text[this.index] !== ".") return true;
    this.index += 1;
    return this.consumeDigits() > 0;
  }

  private parseExponent(): boolean {
    if (this.text[this.index]?.toLowerCase() !== "e") return true;
    this.index += 1;
    if (this.text[this.index] === "+" || this.text[this.index] === "-") this.index += 1;
    return this.consumeDigits() > 0;
  }

  private parseString(): ParsedString | undefined {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const current = this.text[this.index];
      if (current === '"') return this.finishString(start);
      if (current === "\\" && !this.skipEscape()) return undefined;
      else if (current !== "\\") {
        if (current === undefined || current.charCodeAt(0) < 0x20) return undefined;
        this.index += 1;
      }
    }
    return undefined;
  }

  private skipEscape(): boolean {
    this.index += 1;
    const escaped = this.text[this.index];
    if (escaped === "u") {
      const digits = this.text.slice(this.index + 1, this.index + 5);
      if (digits.length !== 4 || !/^[0-9a-f]{4}$/iu.test(digits)) return false;
      this.index += 5;
      return true;
    }
    if (escaped === undefined || !'"\\/bfnrt'.includes(escaped)) return false;
    this.index += 1;
    return true;
  }

  private finishString(start: number): ParsedString | undefined {
    this.index += 1;
    try {
      const value: unknown = JSON.parse(this.text.slice(start, this.index));
      return typeof value === "string" ? { value } : undefined;
    } catch {
      return undefined;
    }
  }

  private parseObject(): boolean {
    if (!this.enterContainer()) return false;
    const keys = new Set<string>();
    this.index += 1;
    this.skipWhitespace();
    if (this.text[this.index] === "}") return this.closeContainer();
    while (this.index < this.text.length) {
      const key = this.parseString();
      if (key === undefined || keys.has(key.value)) return false;
      keys.add(key.value);
      this.skipWhitespace();
      if (this.text[this.index] !== ":") return false;
      this.index += 1;
      if (!this.parseValue()) return false;
      this.skipWhitespace();
      if (this.text[this.index] === "}") return this.closeContainer();
      if (this.text[this.index] !== ",") return false;
      this.index += 1;
      this.skipWhitespace();
    }
    return false;
  }

  private parseArray(): boolean {
    if (!this.enterContainer()) return false;
    this.index += 1;
    this.skipWhitespace();
    if (this.text[this.index] === "]") return this.closeContainer();
    while (this.index < this.text.length) {
      if (!this.parseValue()) return false;
      this.skipWhitespace();
      if (this.text[this.index] === "]") return this.closeContainer();
      if (this.text[this.index] !== ",") return false;
      this.index += 1;
    }
    return false;
  }

  private enterContainer(): boolean {
    this.depth += 1;
    return this.depth <= 64;
  }

  private closeContainer(): boolean {
    this.index += 1;
    this.depth -= 1;
    return true;
  }
}

function invalidFeedbackRequest(): RouteResult {
  return {
    status: 400,
    body: {
      error: { code: "FEEDBACK_REQUEST_INVALID", message: "The feedback request is invalid." },
    },
  };
}

function oversizedFeedbackRequest(): RouteResult {
  return {
    status: 413,
    body: { error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the size limit." } },
  };
}

async function readFeedbackBytes(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total <= maxBytes) chunks.push(chunk);
      else if (!capped) {
        capped = true;
        chunks.length = 0;
        reject(new FeedbackBodyTooLargeError());
        req.resume();
      }
    });
    req.on("end", () => {
      if (!capped) resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

export async function readStrictFeedbackJsonObject(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown> | RouteResult> {
  let bytes: Buffer;
  try {
    bytes = await readFeedbackBytes(req, maxBytes);
  } catch (error) {
    if (error instanceof FeedbackBodyTooLargeError) return oversizedFeedbackRequest();
    throw error;
  }
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return invalidFeedbackRequest();
  }
  if (raw.length === 0 || !new JsonDuplicateKeyScanner(raw).accepts()) {
    return invalidFeedbackRequest();
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : invalidFeedbackRequest();
  } catch {
    return invalidFeedbackRequest();
  }
}
