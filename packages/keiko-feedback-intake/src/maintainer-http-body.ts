import type { IncomingMessage } from "node:http";
import { MaintainerRequestError } from "./maintainer-http-error.js";

export async function readMaintainerBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error: Error | undefined, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined) resolve(value);
      else reject(error);
    };
    const timer = setTimeout(() => {
      req.destroy();
      finish(new MaintainerRequestError("body"));
    }, 5_000);
    req.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > 16_384) {
        req.pause();
        req.destroy();
        finish(new MaintainerRequestError("body"));
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        finish(undefined, parseMaintainerJson(Buffer.concat(chunks)));
      } catch {
        finish(new MaintainerRequestError("body"));
      }
    });
    req.on("error", () => {
      finish(new MaintainerRequestError("body"));
    });
  });
}

function parseMaintainerJson(bytes: Uint8Array): unknown {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (source.startsWith("\uFEFF") || hasDuplicateKeys(source)) {
    throw new MaintainerRequestError("body");
  }
  return JSON.parse(source) as unknown;
}

// The bounded scanner keeps duplicate-key rejection auditable at the trust boundary.
// eslint-disable-next-line complexity
function hasDuplicateKeys(source: string): boolean {
  const scopes: Set<string>[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") scopes.push(new Set());
    else if (character === "}") scopes.pop();
    else if (character === '"' && scopes.length > 0) {
      const end = quotedEnd(source, index + 1);
      if (end === undefined) return false;
      let cursor = end + 1;
      while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
      if (source[cursor] === ":" && duplicateKey(source, index, end, scopes.at(-1))) return true;
      index = end;
    }
  }
  return false;
}

function quotedEnd(source: string, start: number): number | undefined {
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "\\") index += 1;
    else if (source[index] === '"') return index;
  }
  return undefined;
}

function duplicateKey(
  source: string,
  start: number,
  end: number,
  scope: Set<string> | undefined,
): boolean {
  const key = JSON.parse(source.slice(start, end + 1)) as string;
  if (scope?.has(key) === true) return true;
  scope?.add(key);
  return false;
}
