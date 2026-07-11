#!/usr/bin/env node
import { startHostedFeedbackIntake } from "./runtime.js";

async function main(): Promise<void> {
  const runtime = await startHostedFeedbackIntake({ env: process.env });
  const stop = (): void => {
    void runtime.stop().then(
      () => {
        process.exitCode = 0;
      },
      () => {
        process.exitCode = 1;
      },
    );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

void main().catch(() => {
  process.exitCode = 1;
});
