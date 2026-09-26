// Partial declaration for scripts/lib/coding-issue-journey-evidence.mjs — only the pure platform
// mapping the live Playwright harness (tests/e2e/, part of the root tsconfig.json strict program)
// needs to read, so a receipt it writes reports the SAME "platform" string
// scripts/check-coding-issue-journey-evidence.mjs cross-references it against. Mirrors the sibling
// scripts/lib/qualification-evidence-receipt.d.mts pattern; not a restated copy of the lookup table
// itself, which stays owned by the .mjs source.

export function platformKeyFor(
  osName: string,
  archName: string,
): "macos-arm64" | "macos-x64" | "windows-x64" | "linux-x64" | undefined;
