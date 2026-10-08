import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { unregisteredFailurePathViolations } from "../check-error-observability.mjs";

const workerSource = () =>
  readFileSync("packages/keiko-server/src/support-report-worker.ts", "utf8");

describe("exact closed Coding Workbench validation boundaries", () => {
  it.each([
    ["packages/keiko-contracts/src/opencode-service-host.ts", "dataRecord"],
    ["packages/keiko-sandbox/src/seatbelt-execution-root.ts", "copyRuntimeGatewayFilesystem"],
    [
      "packages/keiko-server/src/coding-runtime/opencodeServiceHostArtifact.ts",
      "closedHostEnvironment",
    ],
    [
      "packages/keiko-server/src/coding-runtime/secureWorkspaceTextRead.ts",
      "decodeSnapshotHelperResponse",
    ],
  ])("accepts only the exact reviewed file and owner: %s", (path, owner) => {
    const source = readFileSync(path, "utf8");
    expect(source).toContain(`function ${owner}(`);
    expect(unregisteredFailurePathViolations(source, path)).not.toContainEqual(
      expect.objectContaining({ owner }),
    );
    const lost = `function ${owner}() { try { prepare(); } catch { return undefined; } }`;
    expect(unregisteredFailurePathViolations(lost, "packages/fixture/src/other.ts")).toHaveLength(
      1,
    );
    expect(
      unregisteredFailurePathViolations(lost.replace(owner, "unrelatedOwner"), path),
    ).toHaveLength(1);
  });
});

describe("typed asynchronous failure propagation", () => {
  it("recognizes the intrinsic Promise reject callback with the caught error", () => {
    const source = `function dispatch(reject: Parameters<ConstructorParameters<PromiseConstructor>[0]>[1]) {
      try { prepare(); } catch (error) { reject(error); }
    }`;
    expect(unregisteredFailurePathViolations(source)).toEqual([]);
  });

  it("recognizes the actual main-thread rejection seam without adding a failure-path waiver", () => {
    const source = readFileSync("packages/keiko-server/src/support-report-job.ts", "utf8");
    expect(unregisteredFailurePathViolations(source)).toEqual([]);
    expect(
      unregisteredFailurePathViolations(source.replace("reject(error);", "void error;")),
    ).toHaveLength(1);
  });

  it.each([
    "function dispatch(reject: (error: unknown) => void) { try { prepare(); } catch (error) { reject(error); } }",
    "function dispatch(reject: Parameters<ConstructorParameters<PromiseConstructor>[0]>[0]) { try { prepare(); } catch (error) { reject(error); } }",
    'function dispatch(reject: Parameters<ConstructorParameters<PromiseConstructor>[0]>[1]) { try { prepare(); } catch (error) { reject("lost"); } }',
    "function dispatch(reject: Parameters<ConstructorParameters<PromiseConstructor>[0]>[1]) { try { prepare(); } catch (error) { ((reject) => reject(error))(() => {}); } }",
    "try { prepare(); } catch (error) { parentPort.postMessage(error); }",
    "try { prepare(); } catch (error) { parentPort.postMessage({ message: error.message }); }",
  ])("keeps unverified callbacks and raw transport observable: %s", (source) => {
    expect(unregisteredFailurePathViolations(source)).toHaveLength(1);
  });

  it("recognizes the actual typed, body-free worker failure transport", () => {
    expect(unregisteredFailurePathViolations(workerSource())).toEqual([]);
  });

  it.each([
    ["frames: keikoStackFrames(error)", "frames: [String(error)]"],
    ["causeChain: causeChain(error)", "causeChain: [String(error)]"],
    ['? error.reason : "unavailable"', '? String(error) : "unavailable"'],
    ['from "node:worker_threads"', 'from "customer-port"'],
    ['from "@oscharko-dev/keiko-activity-log"', 'from "customer-reducer"'],
  ])("rejects a raw field or unowned transport/reducer: %s", (original, replacement) => {
    const source = workerSource();
    expect(source).toContain(original);
    expect(unregisteredFailurePathViolations(source.replace(original, replacement))).toHaveLength(
      1,
    );
  });

  it("rejects raw error transport and a serializer that adds customer text", () => {
    const source = workerSource();
    expect(
      unregisteredFailurePathViolations(
        source.replace("serializeSupportReportWorkerFailure(error)", "error"),
      ),
    ).toHaveLength(1);
    expect(
      unregisteredFailurePathViolations(
        source.replace("ok: false,", "ok: false, message: error.message,"),
      ),
    ).toHaveLength(1);
  });
});
