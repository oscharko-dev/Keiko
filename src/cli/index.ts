#!/usr/bin/env node
import { runCli } from "./runner.js";

process.exit(
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
);
