// Behaviour tests for the shared HTTP req/res test builders (GEN-DX-002). These pin the superset
// contract the four migrated suites rely on: a real Readable body, a real writable/EventEmitter
// response, header capture, opt-in body capture, and writeHead recording.

import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { mockRequest, mockResponse } from "./_support.js";

describe("mockRequest", () => {
  it("produces a genuine Readable body consumable via data/end events", async () => {
    const req = mockRequest({ body: '{"hello":"world"}' });
    const text = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on("end", () => {
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
      req.on("error", reject);
    });
    expect(text).toBe('{"hello":"world"}');
  });

  it("is consumable via async iteration (for await)", async () => {
    const req = mockRequest({ body: "streamed" });
    let text = "";
    for await (const chunk of req as unknown as AsyncIterable<Buffer>) {
      text += chunk.toString("utf8");
    }
    expect(text).toBe("streamed");
  });

  it("yields an empty body and defaults to GET when no body is given", async () => {
    const req = mockRequest();
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/");
    const chunks: Buffer[] = [];
    for await (const chunk of req as unknown as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    expect(Buffer.concat(chunks).toString("utf8")).toBe("");
  });

  it("defaults to POST when a body is present and honours explicit method/url", () => {
    expect(mockRequest({ body: "x" }).method).toBe("POST");
    const req = mockRequest({ method: "PUT", url: "/api/thing?q=1" });
    expect(req.method).toBe("PUT");
    expect(req.url).toBe("/api/thing?q=1");
  });

  it("lower-cases header names to match Node's IncomingMessage.headers", () => {
    const req: IncomingMessage = mockRequest({ headers: { "Content-Type": "application/json" } });
    expect(req.headers["content-type"]).toBe("application/json");
  });
});

describe("mockResponse", () => {
  it("captures setHeader into a lower-cased Map and returns the response for chaining", () => {
    const { res, headers } = mockResponse();
    const returned = res.setHeader("Content-Type", "text/html");
    expect(returned).toBe(res);
    expect(headers.get("content-type")).toBe("text/html");
  });

  it("records writeHead status and headers, and updates statusCode", () => {
    const { res, statusCode, headers, writeHeadCalls } = mockResponse();
    res.writeHead(201, { Location: "/created" });
    expect(statusCode()).toBe(201);
    expect(headers.get("location")).toBe("/created");
    expect(writeHeadCalls).toEqual([{ statusCode: 201, headers: { Location: "/created" } }]);
  });

  it("is a real writable stream that a createReadStream-style pipe can target", async () => {
    const { res, body } = mockResponse({ captureBody: true });
    const { Readable } = await import("node:stream");
    Readable.from([Buffer.from("piped-bytes")]).pipe(res);
    await new Promise<void>((resolve) => {
      res.on("finish", resolve);
    });
    expect(body()).toBe("piped-bytes");
  });

  it("does not capture body bytes when captureBody is false (default) but still accepts writes", () => {
    const { res, body } = mockResponse();
    res.write("ignored");
    res.end("also-ignored");
    expect(body()).toBe("");
  });

  it("behaves as an EventEmitter with a real writableEnded getter (disconnect guard)", () => {
    const { res } = mockResponse();
    let closedWhileNotEnded = false;
    res.on("close", () => {
      if (!res.writableEnded) closedWhileNotEnded = true;
    });
    expect(res.writableEnded).toBe(false);
    res.emit("close");
    expect(closedWhileNotEnded).toBe(true);
  });
});
