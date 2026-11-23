import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { upstreamStatusClass } from "./repositoryRelayActivity.js";
import {
  credentialByteForms,
  pipeBinaryBody,
  readBoundedBody,
  refuseCredentialEcho,
  RelayRefusal,
  rewritePackument,
  type ResponseBudget,
} from "./repositoryRelayResponse.js";

// #4522: edges of the relay's response handling that the end-to-end exchanges do not reach.
const BUDGET: ResponseBudget = { responseMaxBytes: 1024, charge: () => undefined };

function refusalOf(action: () => unknown): RelayRefusal | undefined {
  try {
    action();
  } catch (error) {
    return error instanceof RelayRefusal ? error : undefined;
  }
  return undefined;
}

async function asyncRefusalOf(action: () => Promise<unknown>): Promise<RelayRefusal | undefined> {
  try {
    await action();
  } catch (error) {
    return error instanceof RelayRefusal ? error : undefined;
  }
  return undefined;
}

describe("upstreamStatusClass (#4522)", () => {
  it.each([
    [200, "2xx"],
    [304, "3xx"],
    [404, "4xx"],
    [503, "5xx"],
    [199, undefined],
    [600, undefined],
  ] as const)("classifies %i as %s", (status, expected) => {
    expect(upstreamStatusClass(status)).toBe(expected);
  });
});

describe("bounded bodies (#4522)", () => {
  it("reads an empty body as no bytes and a body without a stream as none", async () => {
    expect(await readBoundedBody(new Response(null), 10, BUDGET)).toHaveLength(0);
    expect((await readBoundedBody(new Response("abc"), 10, BUDGET)).toString()).toBe("abc");
  });

  it("refuses a body larger than its bound", async () => {
    const refusal = await asyncRefusalOf(() =>
      readBoundedBody(new Response("x".repeat(20)), 10, BUDGET),
    );
    expect(refusal?.reason).toBe("response-too-large");
  });

  it("refuses a body larger than the response budget while streaming it", async () => {
    const refusal = await asyncRefusalOf(() =>
      pipeBinaryBody(
        new Response("x".repeat(2048)),
        { write: () => true } as unknown as ServerResponse,
        [],
        BUDGET,
      ),
    );
    expect(refusal?.reason).toBe("response-too-large");
  });

  it("streams nothing for a response without a body", async () => {
    expect(await pipeBinaryBody(new Response(null), {} as ServerResponse, [], BUDGET)).toBe(0);
  });
});

describe("credential echo scanning (#4522)", () => {
  it("refuses text that spells the credential and passes text that does not", () => {
    const forms = ["canary-secret-1"];
    const bytes = credentialByteForms(forms);
    expect(
      refusalOf(() => {
        refuseCredentialEcho(Buffer.from("a canary-secret-1 b"), forms, bytes);
      })?.reason,
    ).toBe("credential-in-response");
    expect(
      refusalOf(() => {
        refuseCredentialEcho(Buffer.from("nothing here"), forms, bytes);
      }),
    ).toBeUndefined();
  });

  it("refuses a body whose pending spelling outgrows any credential, as unbounded", () => {
    const forms = ["AB"];
    const text = `&#${"0".repeat(600 * 1024)}`;
    const refusal = refusalOf(() => {
      refuseCredentialEcho(Buffer.from(text), forms, credentialByteForms(forms));
    });
    expect(refusal?.reason).toBe("credential-spelling-unbounded");
  });
});

describe("rewritePackument (#4522)", () => {
  const UPSTREAM = "https://npm.example.test/registry/";
  const RELAY = "http://127.0.0.1:1/relay/";
  const rewrite = (document: unknown): ReturnType<typeof rewritePackument> =>
    rewritePackument(Buffer.from(JSON.stringify(document)), UPSTREAM, RELAY);

  it("moves a tarball under the upstream onto the relay and leaves another host alone", () => {
    const result = rewrite({
      versions: {
        "1.0.0": { dist: { tarball: `${UPSTREAM}pkg/-/pkg-1.0.0.tgz` } },
        "2.0.0": { dist: { tarball: "https://elsewhere.example.test/pkg-2.0.0.tgz" } },
      },
    });
    expect(result.rewritten).toBe(1);
    expect(result.body.toString()).toContain(`${RELAY}pkg/-/pkg-1.0.0.tgz`);
    expect(result.body.toString()).toContain("https://elsewhere.example.test/pkg-2.0.0.tgz");
  });

  // CodeRabbit on #4537: a literal prefix missed a tarball that names the same registry in another
  // spelling, so npm fetched it without the run's capability. Scheme and host compare
  // case-insensitively and a default port is the same origin; the path stays case-sensitive, and a
  // dot segment cannot climb out of the registry path.
  it.each([
    ["an upper-case host and scheme", "HTTPS://NPM.EXAMPLE.TEST/registry/pkg/-/pkg-1.0.0.tgz"],
    ["the explicit default port", "https://npm.example.test:443/registry/pkg/-/pkg-1.0.0.tgz"],
  ])("moves a tarball that spells the upstream with %s", (_name, tarball) => {
    const result = rewrite({ versions: { "1.0.0": { dist: { tarball } } } });
    expect(result.rewritten).toBe(1);
    expect(result.body.toString()).toContain(`${RELAY}pkg/-/pkg-1.0.0.tgz`);
  });

  it.each([
    ["another path case", "https://npm.example.test/REGISTRY/pkg/-/pkg-1.0.0.tgz"],
    ["a dot segment out of the path", "https://npm.example.test/registry/../other/pkg-1.0.0.tgz"],
    ["another port", "https://npm.example.test:8443/registry/pkg/-/pkg-1.0.0.tgz"],
    ["another scheme", "http://npm.example.test/registry/pkg/-/pkg-1.0.0.tgz"],
    ["no URL", "registry/pkg/-/pkg-1.0.0.tgz"],
  ])("leaves a tarball with %s alone", (_name, tarball) => {
    const result = rewrite({ versions: { "1.0.0": { dist: { tarball } } } });
    expect(result.rewritten).toBe(0);
    expect(result.body.toString()).not.toContain(RELAY);
  });

  it("passes a document whose versions or dist are not records through unchanged", () => {
    expect(rewrite({ name: "x" }).rewritten).toBe(0);
    expect(rewrite({ versions: ["a"] }).rewritten).toBe(0);
    expect(
      rewrite({ versions: { "1.0.0": "text", "2.0.0": { dist: "x" }, "3.0.0": null } }).rewritten,
    ).toBe(0);
    expect(rewrite({ versions: { "1.0.0": { dist: { tarball: 7 } } } }).rewritten).toBe(0);
  });

  it.each([
    ["an array", "[]"],
    ["null", "null"],
    ["a number", "7"],
    ["invalid JSON", "{"],
  ])("refuses %s as an invalid packument", (_name, text) => {
    const refusal = refusalOf(() => rewritePackument(Buffer.from(text), UPSTREAM, RELAY));
    expect(refusal?.reason).toBe("packument-invalid");
  });

  it("refuses bytes that are not UTF-8", () => {
    const refusal = refusalOf(() =>
      rewritePackument(Uint8Array.from([0xff, 0xfe, 0x7b]), UPSTREAM, RELAY),
    );
    expect(refusal?.reason).toBe("packument-invalid");
  });
});
