import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runs a lab command when its module is the process entry point. A failure ends as one body-free
 * `incomplete` line naming only the error type, never its message.
 */
export async function runLabCliWhenMain(moduleUrl, operation, main) {
  if (!process.argv[1] || resolve(process.argv[1]) !== fileURLToPath(moduleUrl)) return;
  await main(process.argv.slice(2)).catch((error) => {
    console.log(
      JSON.stringify({
        operation,
        status: "incomplete",
        errorType: error instanceof Error ? error.name : "unknown",
      }),
    );
    process.exitCode = 1;
  });
}
