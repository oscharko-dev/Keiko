import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { promisify } from "node:util";
import { brotliCompress, gzip } from "node:zlib";
import { securityHeaders } from "./maintainer-http-response.js";

export const MAINTAINER_UI_PATH = "/maintainer/";

type Asset =
  | "maintainer-ui.html"
  | "maintainer-ui.css"
  | "maintainer-ui.js"
  | "maintainer-ui-copy.js"
  | "maintainer-ui-dom.js"
  | "maintainer-ui-detail.js"
  | "maintainer-ui-publication.js"
  | "keiko-tokens.css"
  | "keiko-semantic-tokens.css";

interface UiAsset {
  readonly filename: Asset;
  readonly contentType: string;
}

const ASSETS: Readonly<Record<string, UiAsset>> = {
  "/maintainer/": { filename: "maintainer-ui.html", contentType: "text/html; charset=utf-8" },
  "/maintainer/app.css": { filename: "maintainer-ui.css", contentType: "text/css; charset=utf-8" },
  "/maintainer/app.js": {
    filename: "maintainer-ui.js",
    contentType: "text/javascript; charset=utf-8",
  },
  "/maintainer/maintainer-ui-copy.js": {
    filename: "maintainer-ui-copy.js",
    contentType: "text/javascript; charset=utf-8",
  },
  "/maintainer/maintainer-ui-dom.js": {
    filename: "maintainer-ui-dom.js",
    contentType: "text/javascript; charset=utf-8",
  },
  "/maintainer/maintainer-ui-detail.js": {
    filename: "maintainer-ui-detail.js",
    contentType: "text/javascript; charset=utf-8",
  },
  "/maintainer/maintainer-ui-publication.js": {
    filename: "maintainer-ui-publication.js",
    contentType: "text/javascript; charset=utf-8",
  },
  "/maintainer/tokens.css": {
    filename: "keiko-tokens.css",
    contentType: "text/css; charset=utf-8",
  },
  "/maintainer/semantic-tokens.css": {
    filename: "keiko-semantic-tokens.css",
    contentType: "text/css; charset=utf-8",
  },
};

interface EncodedAsset {
  readonly identity: Buffer;
  readonly br: Buffer;
  readonly gzip: Buffer;
}

const content = new Map<Asset, Promise<EncodedAsset>>();
const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);

function assetBytes(asset: Asset): Promise<EncodedAsset> {
  const existing = content.get(asset);
  if (existing !== undefined) return existing;
  const loading = readFile(new URL(`../assets/${asset}`, import.meta.url)).then(
    async (identity): Promise<EncodedAsset> => ({
      identity,
      br: await compressBrotli(identity),
      gzip: await compressGzip(identity),
    }),
  );
  content.set(asset, loading);
  return loading;
}

function acceptedEncoding(value: string | undefined): "br" | "gzip" | "identity" {
  if (value === undefined || value.length > 256) return "identity";
  const accepted = value
    .toLowerCase()
    .split(",")
    .map((part) => part.trim());
  const allows = (name: string): boolean =>
    accepted.some(
      (part) => part === name || (part.startsWith(`${name};`) && !/q=0(?:\.0*)?$/u.test(part)),
    );
  if (allows("br")) return "br";
  return allows("gzip") ? "gzip" : "identity";
}

function redirect(res: ServerResponse): void {
  res.writeHead(308, { ...securityHeaders(), Location: MAINTAINER_UI_PATH });
  res.end();
}

export async function serveMaintainerUi(
  method: string | undefined,
  pathname: string,
  res: ServerResponse,
  acceptEncoding?: string,
): Promise<boolean> {
  if (pathname === "/maintainer") {
    if (method === "GET" || method === "HEAD") redirect(res);
    else res.writeHead(405, securityHeaders()).end();
    return true;
  }
  const asset = ASSETS[pathname];
  if (asset === undefined) return false;
  if (method !== "GET" && method !== "HEAD") {
    res.writeHead(405, securityHeaders());
    res.end();
    return true;
  }
  const encoded = await assetBytes(asset.filename);
  const encoding = acceptedEncoding(acceptEncoding);
  const bytes = encoded[encoding];
  res.writeHead(200, {
    ...securityHeaders(),
    "Content-Type": asset.contentType,
    "Content-Length": String(bytes.byteLength),
    Vary: "Accept-Encoding",
    ...(encoding === "identity" ? {} : { "Content-Encoding": encoding }),
  });
  res.end(method === "HEAD" ? undefined : bytes);
  return true;
}
