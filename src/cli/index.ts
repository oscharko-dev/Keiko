#!/usr/bin/env node
import { runCli } from "@oscharko-dev/keiko-cli";

// Re-export shim: the CLI command modules now live in @oscharko-dev/keiko-cli
// (issue #168, ADR-0019). This file remains the entry the published bin points
// at (`bin: dist/cli/index.js` in the root package.json) and is the only
// `src/cli/` file with a shebang. runCli returns a number for synchronous
// commands and a Promise<number> for the async `run` command; Promise.resolve
// normalises both before exiting with the resulting code.

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
