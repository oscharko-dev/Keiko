#!/usr/bin/env node
import { runCli } from "./runner.js";

// runCli returns a number for synchronous commands and a Promise<number> for the async
// `run` command. Promise.resolve normalises both before exiting with the resulting code.
void Promise.resolve(
  runCli(
    process.argv.slice(2),
    {
      out: (text: string): void => {
        process.stdout.write(text);
      },
      err: (text: string): void => {
        process.stderr.write(text);
      },
    },
    process.env,
  ),
).then((code) => {
  process.exit(code);
});
