import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { rootCertificates } from "node:tls";

export interface GatewayFetchOptions extends RequestInit {
  readonly fetchImpl?: typeof fetch | undefined;
  readonly useCaFallback?: boolean | undefined;
}

function headersFromNode(headers: Record<string, string | string[] | undefined>): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) out.append(name, item);
    } else if (value !== undefined) {
      out.set(name, value);
    }
  }
  return out;
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const normalized = new Headers(headers);
  normalized.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isMissingIssuerError(error: unknown): boolean {
  const cause = isRecord(error) ? error.cause : undefined;
  const candidates = [error, cause];
  return candidates.some((item) => {
    if (!isRecord(item)) return false;
    return item.code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY";
  });
}

function usesHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

function extraCaCertificates(): readonly string[] {
  const path = process.env.NODE_EXTRA_CA_CERTS;
  if (path === undefined || path.trim().length === 0) {
    return [];
  }
  try {
    return [readFileSync(path, "utf8")];
  } catch {
    return [];
  }
}

function caBundle(): readonly string[] {
  return [...rootCertificates, ...extraCaCertificates()];
}

function bodyToString(body: BodyInit | null | undefined): string | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  throw new TypeError("gateway HTTP fallback supports string request bodies only");
}

function fetchWithCaBundle(url: string, init: RequestInit): Promise<Response> {
  const body = bodyToString(init.body);
  const headers = headersToRecord(init.headers);
  return new Promise<Response>((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: init.method ?? "GET",
        headers,
        ca: [...caBundle()],
        signal: init.signal ?? undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode ?? 500,
              statusText: res.statusMessage ?? "",
              headers: headersFromNode(res.headers),
            }),
          );
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

export async function gatewayFetch(
  url: string,
  options: GatewayFetchOptions = {},
): Promise<Response> {
  const { fetchImpl, useCaFallback = fetchImpl === undefined, ...init } = options;
  const doFetch = fetchImpl ?? globalThis.fetch;
  try {
    return await doFetch(url, init);
  } catch (error) {
    if (useCaFallback && usesHttps(url) && isMissingIssuerError(error)) {
      return fetchWithCaBundle(url, init);
    }
    throw error;
  }
}
