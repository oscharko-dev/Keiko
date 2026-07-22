import type { IncomingMessage } from "node:http";
import { PassThrough, Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  readBoundedRequestBody,
  RequestBodyCancelledError,
  RequestBodyTooLargeError,
} from "./bounded-request-body.js";

function asRequest(stream: PassThrough | Readable): IncomingMessage {
  return stream as unknown as IncomingMessage;
}

function expectNoBodyListeners(req: IncomingMessage): void {
  expect(req.listenerCount("data")).toBe(0);
  expect(req.listenerCount("end")).toBe(0);
  expect(req.listenerCount("error")).toBe(0);
  expect(req.listenerCount("close")).toBe(0);
}

function expectTerminalErrorSink(req: IncomingMessage): void {
  expect(req.listenerCount("data")).toBe(0);
  expect(req.listenerCount("end")).toBe(1);
  expect(req.listenerCount("error")).toBe(1);
  expect(req.listenerCount("close")).toBe(1);
}

describe("bounded request body", () => {
  it("reads a bounded body and releases every owned listener", async () => {
    const req = asRequest(Readable.from([Buffer.from("hello")]));

    await expect(readBoundedRequestBody(req, 5)).resolves.toBe("hello");

    expectNoBodyListeners(req);
  });

  it("settles an aborted body, drains it, and absorbs one late request error", async () => {
    const stream = new PassThrough();
    const req = asRequest(stream);
    const controller = new AbortController();
    const removeAbortListener = vi.spyOn(controller.signal, "removeEventListener");
    const resume = vi.spyOn(req, "resume");
    const outcome = readBoundedRequestBody(req, 128_000, controller.signal);
    const resumeCallsBeforeBody = resume.mock.calls.length;
    stream.write(Buffer.from('{"content":"partial'));

    controller.abort("client disconnected");

    await expect(outcome).rejects.toBeInstanceOf(RequestBodyCancelledError);
    expect(resume).toHaveBeenCalledTimes(resumeCallsBeforeBody + 1);
    expectTerminalErrorSink(req);
    expect(() => stream.emit("error", new Error("late request failure"))).not.toThrow();
    expectTerminalErrorSink(req);
    const ended = new Promise<void>((resolve) => {
      stream.once("end", resolve);
    });
    stream.end();
    await ended;
    expectNoBodyListeners(req);
    expect(removeAbortListener).toHaveBeenCalledOnce();
  });

  it("rejects and drains an oversized body while absorbing one late request error", async () => {
    const stream = new PassThrough();
    const req = asRequest(stream);
    const resume = vi.spyOn(req, "resume");
    const outcome = readBoundedRequestBody(req, 4);
    const resumeCallsBeforeBody = resume.mock.calls.length;

    stream.write(Buffer.from("12345"));

    await expect(outcome).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    expect(resume).toHaveBeenCalledTimes(resumeCallsBeforeBody + 1);
    expectTerminalErrorSink(req);
    expect(() => stream.emit("error", new Error("late request failure"))).not.toThrow();
    expectTerminalErrorSink(req);
    const ended = new Promise<void>((resolve) => {
      stream.once("end", resolve);
    });
    stream.end();
    await ended;
    expectNoBodyListeners(req);
  });

  it("retains the terminal sink after the primary request error until close", async () => {
    const stream = new PassThrough();
    const req = asRequest(stream);
    const primaryError = new Error("primary request failure");
    const outcome = readBoundedRequestBody(req, 128_000);

    stream.emit("error", primaryError);

    await expect(outcome).rejects.toBe(primaryError);
    expectTerminalErrorSink(req);
    expect(() => stream.emit("error", new Error("secondary request failure"))).not.toThrow();
    expectTerminalErrorSink(req);
    const closed = new Promise<void>((resolve) => {
      stream.once("close", resolve);
    });
    stream.destroy();
    await closed;
    expectNoBodyListeners(req);
  });

  it("releases the terminal error sink when an already-aborted stream closes", async () => {
    const stream = new PassThrough();
    const req = asRequest(stream);
    const controller = new AbortController();
    controller.abort("already disconnected");

    await expect(readBoundedRequestBody(req, 128_000, controller.signal)).rejects.toBeInstanceOf(
      RequestBodyCancelledError,
    );

    expectTerminalErrorSink(req);
    const closed = new Promise<void>((resolve) => {
      stream.once("close", resolve);
    });
    stream.destroy();
    await closed;
    expectNoBodyListeners(req);
  });

  it("retains the terminal sink while a destroyed request still has a pending error", async () => {
    const stream = new PassThrough();
    const req = asRequest(stream);
    const controller = new AbortController();
    controller.abort("already disconnected");
    Object.defineProperty(req, "destroyed", { configurable: true, value: true });
    Object.defineProperty(req, "closed", { configurable: true, value: false });

    await expect(readBoundedRequestBody(req, 128_000, controller.signal)).rejects.toBeInstanceOf(
      RequestBodyCancelledError,
    );

    expectTerminalErrorSink(req);
    expect(() => stream.emit("error", new Error("pending destroy failure"))).not.toThrow();
    stream.emit("close");
    expectNoBodyListeners(req);
  });
});
