// Preloaded with `node --import` into a measured child process: on exit it writes the process's
// peak resident set size, in bytes, to the file named by KEIKO_PEAK_RSS_FILE. Node reports
// `maxRSS` in kibibytes on every platform. Without the variable it does nothing.

import { writeFileSync } from "node:fs";

const target = process.env.KEIKO_PEAK_RSS_FILE;

if (typeof target === "string" && target !== "") {
  process.on("exit", () => {
    writeFileSync(target, `${process.resourceUsage().maxRSS * 1024}\n`);
  });
}
