/**
 * Static export (ADR-0011 D1): Next/React are build-time-only and the shipped runtime is the
 * node:http BFF, so the package gains zero runtime dependencies. Source maps are disabled so the
 * package-surface check (D6) ships no `.map` files; images are unoptimized because there is no Next
 * server at runtime to optimize them.
 */
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  productionBrowserSourceMaps: false,
  images: { unoptimized: true },
  reactStrictMode: true,
  // Pin the file-tracing root to this package so Next does not climb to the repo root and pull
  // unrelated workspace files into its trace.
  outputFileTracingRoot: here,
};

export default nextConfig;
