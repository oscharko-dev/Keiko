import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const path = join(
  process.env.KEIKO_STATE_DIR,
  `fixture-bootstrap-${process.env.KEIKO_UI_LAUNCH_ID}.json`,
);
let observation = { phase: "module-evaluation" };
function observe(update) {
  observation = { ...observation, ...update, at: Date.now() };
  try {
    writeFileSync(path, JSON.stringify(observation), { mode: 0o600 });
  } catch {
    // The native owner may already have removed a stopped fixture; diagnostics grant no authority.
  }
}
observe({});
process.on("uncaughtExceptionMonitor", (error) =>
  observe({ messageSha256: createHash("sha256").update(error.message).digest("hex") }),
);
process.on("exit", (exitCode) => observe({ exitCode }));

await import("./test-support.app-handoff-root.mjs");
