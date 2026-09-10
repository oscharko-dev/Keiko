import { fileURLToPath } from "node:url";

// Resolves to the assembled JavaScript entry point both from src during tests and from dist at
// runtime. Gateway launches deliberately execute the built artifact: its presence is part of the
// package-surface proof and a missing artifact fails before the isolated child can start.
export const LINUX_GATEWAY_LAUNCHER_PATH = fileURLToPath(
  new URL("../dist/linux-gateway-launcher.js", import.meta.url),
);
