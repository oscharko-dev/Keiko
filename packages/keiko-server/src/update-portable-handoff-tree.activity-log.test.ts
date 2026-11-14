import { describe, expect, it } from "vitest";
import { portableHandoffOperationFrom } from "./update-portable-handoff-tree.js";

// #4351: a tree attestation reports its failure to the operation's sink. An operation that named
// none lost that line as an unwired port; it now reports to the process sink.
describe("a portable handoff operation", () => {
  it("always carries the sink its tree attestation reports to", () => {
    const operation = portableHandoffOperationFrom({ deadline: Date.now() + 60_000 });
    expect(typeof operation.securityLogSink.write).toBe("function");
  });

  it("keeps a narrower sink its composition names", () => {
    const securityLogSink = { write: (): void => undefined };
    expect(
      portableHandoffOperationFrom({ deadline: Date.now() + 60_000, securityLogSink })
        .securityLogSink,
    ).toBe(securityLogSink);
  });
});
