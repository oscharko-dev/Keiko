import { realpathSync } from "node:fs";
import { dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { DebugAdapterSpec } from "../providers/dapAdapterProviders.js";
import { createNodeDebugAdapterSpec } from "../providers/nodeDebugAdapter.js";

export function fakeDapAdapterScriptPath(): string {
  return fileURLToPath(new URL("./fake-dap-adapter.mjs", import.meta.url));
}

export function fakeNodeAdapterProvider(): DebugAdapterSpec {
  const executable = realpathSync(process.execPath);
  return Object.freeze({
    ...createNodeDebugAdapterSpec(
      basename(executable),
      [fakeDapAdapterScriptPath()],
      [dirname(executable)],
      "f".repeat(64),
    ),
    providerId: "fake-node",
  });
}
