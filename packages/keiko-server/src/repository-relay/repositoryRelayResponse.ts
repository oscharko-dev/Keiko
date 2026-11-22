import type { ServerResponse } from "node:http";
import {
  createSecretSpellingStreamRedactor,
  SecretSpellingOverflowError,
} from "@oscharko-dev/keiko-security";
import type { RepositoryRelayReason } from "./repositoryRelayActivity.js";

/**
 * How a repository relay hands an upstream body to the run (#4522): checked for a credential echo
 * before the run receives the bytes that spell it, streamed with back-pressure, and bounded.
 *
 * A text file (a POM, metadata, a packument) is read whole, scanned in every spelling a parser
 * restores, and only then written. A binary file streams through a rolling window that holds back
 * the last `longest form - 1` bytes of everything it has seen, so a credential that spans two chunks
 * is found before the first of its bytes is released. In both cases a match refuses the response:
 * the relay never rewrites an artifact, because a changed artifact is a corrupted one.
 */
export class RelayRefusal extends Error {
  public constructor(
    public readonly status: number,
    public readonly reason: RepositoryRelayReason,
  ) {
    super(reason);
    this.name = "RelayRefusal";
  }
}

/** The credential forms as bytes, for the rolling scan; the same forms the text scan reads. */
export function credentialByteForms(forms: readonly string[]): readonly Buffer[] {
  return [...new Set(forms.filter((form) => form.length > 0))].map((form) =>
    Buffer.from(form, "utf8"),
  );
}

const PRINTABLE_ASCII = /^[\x20-\x7E]+$/u;
const TEXT_SCAN_SLICE_CHARS = 256 * 1024;

function containsForm(bytes: Uint8Array, byteForms: readonly Buffer[]): boolean {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return byteForms.some((form) => buffer.includes(form));
}

// The text a parser would restore from a spelling (JSON escapes, URL encoding, HTML references) is
// only searchable for printable ASCII forms; a form with other characters keeps its raw byte scan.
function spellingScanner(forms: readonly string[]): (text: string) => boolean {
  const redactor = createSecretSpellingStreamRedactor(
    forms.filter((form) => PRINTABLE_ASCII.test(form)),
  );
  return (text) => {
    try {
      for (let index = 0; index < text.length; index += TEXT_SCAN_SLICE_CHARS)
        redactor.push(text.slice(index, index + TEXT_SCAN_SLICE_CHARS));
      redactor.finish();
      return redactor.redactedCount() > 0;
    } catch (error) {
      if (error instanceof SecretSpellingOverflowError)
        throw new RelayRefusal(502, "credential-spelling-unbounded");
      throw error;
    }
  };
}

/** Throws a refusal when `text` spells a credential, in any form `forms` and the byte scan know. */
export function refuseCredentialEcho(
  bytes: Uint8Array,
  forms: readonly string[],
  byteForms: readonly Buffer[],
  reason: "credential-in-response" | "credential-in-response-header" = "credential-in-response",
): void {
  const text = new TextDecoder("utf-8").decode(bytes);
  if (containsForm(bytes, byteForms) || spellingScanner(forms)(text))
    throw new RelayRefusal(502, reason);
}

/** A forwarded header value that spells the credential refuses the whole response. */
export function refuseCredentialInHeader(
  value: string,
  forms: readonly string[],
  byteForms: readonly Buffer[],
): void {
  refuseCredentialEcho(
    Buffer.from(value, "utf8"),
    forms,
    byteForms,
    "credential-in-response-header",
  );
}

async function writeChunk(response: ServerResponse, chunk: Uint8Array): Promise<void> {
  if (chunk.byteLength === 0 || response.write(chunk)) return;
  await new Promise<void>((resolve) => {
    const settle = (): void => {
      response.off("drain", settle);
      response.off("close", settle);
      resolve();
    };
    response.once("drain", settle);
    response.once("close", settle);
  });
}

export interface ResponseBudget {
  /** The most one response may carry. */
  readonly responseMaxBytes: number;
  /** Charges the binding's total; throws a refusal when that is exhausted. */
  readonly charge: (bytes: number) => void;
}

function chargeChunk(budget: ResponseBudget, total: number, size: number): number {
  const next = total + size;
  if (next > budget.responseMaxBytes) throw new RelayRefusal(502, "response-too-large");
  budget.charge(size);
  return next;
}

/**
 * Streams a binary body to the run with back-pressure. Returns the upstream byte count. A match
 * ends the response where it is (the caller destroys the connection); nothing that could be part of
 * a credential was written before it.
 */
export async function pipeBinaryBody(
  upstream: Response,
  response: ServerResponse,
  byteForms: readonly Buffer[],
  budget: ResponseBudget,
): Promise<number> {
  if (upstream.body === null) return 0;
  const holdBack = Math.max(0, ...byteForms.map((form) => form.length)) - 1;
  let carry: Buffer = Buffer.alloc(0);
  let total = 0;
  for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
    total = chargeChunk(budget, total, chunk.byteLength);
    const window = Buffer.concat([carry, chunk]);
    if (containsForm(window, byteForms)) throw new RelayRefusal(502, "credential-in-response");
    const keep = Math.min(holdBack, window.length);
    await writeChunk(response, window.subarray(0, window.length - keep));
    carry = Buffer.from(window.subarray(window.length - keep));
  }
  await writeChunk(response, carry);
  return total;
}

/** Reads a whole body up to `maxBytes`; a larger one is refused. */
export async function readBoundedBody(
  upstream: Response,
  maxBytes: number,
  budget: ResponseBudget,
): Promise<Buffer> {
  if (upstream.body === null) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
    total = chargeChunk(budget, total, chunk.byteLength);
    if (total > maxBytes) throw new RelayRefusal(502, "response-too-large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function distOf(version: unknown): Record<string, unknown> | undefined {
  if (!isRecord(version)) return undefined;
  return isRecord(version.dist) ? version.dist : undefined;
}

/**
 * The packument with every `versions.*.dist.tarball` that starts with the upstream base URL moved
 * onto the relay's base URL, so the tarball is fetched through the relay as well. Another tarball
 * URL is left as it is. The count is the number of rewritten URLs.
 */
export function rewritePackument(
  body: Uint8Array,
  upstreamBase: string,
  relayBase: string,
): { readonly body: Buffer; readonly rewritten: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    // Reported as the closed refusal `packument-invalid`; the document's text is never kept.
    throw new RelayRefusal(502, "packument-invalid");
  }
  if (!isRecord(parsed)) throw new RelayRefusal(502, "packument-invalid");
  let rewritten = 0;
  const versions = parsed.versions;
  if (isRecord(versions)) {
    for (const version of Object.values(versions)) {
      const dist = distOf(version);
      const tarball = dist?.tarball;
      if (dist !== undefined && typeof tarball === "string" && tarball.startsWith(upstreamBase)) {
        dist.tarball = `${relayBase}${tarball.slice(upstreamBase.length)}`;
        rewritten += 1;
      }
    }
  }
  return { body: Buffer.from(JSON.stringify(parsed), "utf8"), rewritten };
}
