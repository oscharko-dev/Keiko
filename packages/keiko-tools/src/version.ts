// Package version constant. Pinned to 0.1.0 because the tools surface is internal and
// versioned via the umbrella keiko package. Bump on any breaking-shape change to the public
// barrel (errors, ports, types) so consumers can detect divergence in tests.
export const KEIKO_TOOLS_VERSION = "0.1.0" as const;
