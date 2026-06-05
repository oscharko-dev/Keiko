import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const contractsMemoryBarrel = fileURLToPath(
  new URL("../keiko-contracts/src/memory-barrel.ts", import.meta.url),
);

// node:sqlite is a Node 22 built-in surfaced behind `--experimental-sqlite`. Surfacing the flag
// on the per-package vitest runner matches the keiko-server/store pattern so the test runner does
// not depend on a parent process having set the flag.
export default defineConfig({
  resolve: {
    alias: {
      "@oscharko-dev/keiko-contracts/memory": contractsMemoryBarrel,
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    execArgv: ["--experimental-sqlite", "--disable-warning=ExperimentalWarning"],
  },
});
