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
        finish(undefined, JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch {
        finish(new MaintainerRequestError("body"));
      }
    });
    req.on("error", () => finish(new MaintainerRequestError("body")));
  });
}
