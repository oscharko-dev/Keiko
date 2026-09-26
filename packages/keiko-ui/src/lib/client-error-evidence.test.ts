import { afterEach, describe, expect, it } from "vitest";
import { clientErrorEvidence } from "./client-error-evidence";
import { takeClientDiagnosticLoss } from "./client-diagnostics";
afterEach(() => {
  takeClientDiagnosticLoss();
});

const chunk = "/_next/static/chunks/1wntg-7ptuw73.js";
const frame = `dist/ui/static${chunk}`;
function errorAt(line: string): TypeError {
  const error = new TypeError("private device detail");
  error.stack = `TypeError: private device detail\n${line}`;
  return error;
}

describe("body-free browser error evidence", () => {
  it.each([
    `    at createRecorder (${location.origin}${chunk}:12:345)`,
    `createRecorder@${location.origin}${chunk}:12:345`,
    `@${location.origin}${chunk}:12:345`,
  ])("preserves only the shipped chunk coordinates from %s", (line) => {
    expect(clientErrorEvidence(errorAt(line))).toEqual({
      errorClass: "TypeError",
      frames: [`${frame}:12:345`],
      causeChain: [],
    });
  });

  it("retains constructor/start locations and a closed nested cause after the error is wrapped", () => {
    const cause = errorAt(`    at start (${location.origin}${chunk}:20:400)`);
    const error = new Error("private wrapper detail", { cause });
    error.stack = `Error: private wrapper detail\n    at renew (${location.origin}${chunk}:10:200)`;
    expect(clientErrorEvidence(error)).toEqual({
      errorClass: "Error",
      frames: [`${frame}:20:400`, `${frame}:10:200`],
      causeChain: ["TypeError"],
    });
  });

  it.each([
    `at start (https://private.invalid${chunk}:12:345)`,
    `at start (${location.origin}${chunk}?token=private:12:345)`,
    `at start (${location.origin}/Users/private/customer.js:12:345)`,
    `at start (file:///Users/private/customer.js:12:345)`,
    `at start (${location.origin}/_next/static/chunks/../private.js:12:345)`,
  ])("drops foreign URLs, paths and query strings: %s", (line) => {
    expect(clientErrorEvidence(errorAt(line)).frames).toEqual([]);
  });

  it("bounds cyclic causes and survives hostile reflective reads", () => {
    const error = new Error("private");
    error.cause = error;
    expect(clientErrorEvidence(error).causeChain).toEqual([]);
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf(): never {
          throw new Error("private prototype");
        },
        get(): never {
          throw new Error("private getter");
        },
      },
    );
    expect(clientErrorEvidence(hostile)).toEqual({
      errorClass: "Error",
      frames: [],
      causeChain: [],
    });
    expect(takeClientDiagnosticLoss()?.errorsSuppressed).toBeGreaterThan(0);
  });

  it("caps frames and cause depth and refuses foreign error names", () => {
    let error = new Error("private");
    for (let i = 0; i < 10; i++) error = new Error("private", { cause: error });
    error.name = "PrivateCustomerName";
    error.stack = `Error: private\n${Array.from({ length: 30 }, (_, i) => `at f (${location.origin}${chunk}:${i + 1}:5)`).join("\n")}`;
    const evidence = clientErrorEvidence(error);
    expect(evidence.errorClass).toBe("Error");
    expect(evidence.frames).toHaveLength(8);
    expect(evidence.causeChain).toHaveLength(5);
    expect(JSON.stringify(evidence)).not.toMatch(/private|PrivateCustomerName|https?:/);
  });

  it("identifies a chunk load failure without its URL", () => {
    const error = new Error("private chunk URL");
    error.name = "ChunkLoadError";
    expect(clientErrorEvidence(error).errorClass).toBe("ChunkLoadError");
  });
});

it("counts a hostile error name accessor without exposing its text", () => {
  const error = new Error("private");
  Object.defineProperty(error, "name", {
    get(): never {
      throw new Error("private accessor");
    },
  });
  expect(clientErrorEvidence(error).errorClass).toBe("Error");
  expect(takeClientDiagnosticLoss()?.errorsSuppressed).toBeGreaterThan(0);
});

it("keeps the native cause location when the wrapper fills the frame budget", () => {
  const cause = errorAt(`at native (${location.origin}${chunk}:999:42)`);
  const wrapper = new Error("wrapper", { cause });
  wrapper.stack = `Error\n${Array.from({ length: 8 }, (_, i) => `at wrapper (${location.origin}${chunk}:${i + 1}:5)`).join("\n")}`;
  const evidence = clientErrorEvidence(wrapper);
  expect(evidence.frames).toHaveLength(8);
  expect(evidence.frames).toContain(`${frame}:999:42`);
});
