// A create diff of exactly `bytes` UTF-8 bytes in 250 added lines (inside the default changed-line
// bound of the bug workflow), so a byte boundary can be probed without touching any other limit.
// Shared by the workflow suites that exercise the governed patch cap (#4110).
export function createDiffOfBytes(path: string, bytes: number): string {
  const lineCount = 250;
  const header = `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${String(lineCount)} @@\n`;
  const payload = bytes - Buffer.byteLength(header, "utf8") - lineCount * 2;
  const base = Math.floor(payload / lineCount);
  const extra = payload - base * lineCount;
  const lines = Array.from(
    { length: lineCount },
    (_, index) => `+${"x".repeat(base + (index === lineCount - 1 ? extra : 0))}\n`,
  );
  const diff = `${header}${lines.join("")}`;
  if (Buffer.byteLength(diff, "utf8") !== bytes) throw new Error("fixture size drifted");
  return diff;
}
