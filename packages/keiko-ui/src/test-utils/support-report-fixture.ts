import { Blob } from "node:buffer";
import { webcrypto } from "node:crypto";
import { URL } from "node:url";
import type { DesktopSupportReportResponse } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { prepareLocalSupportReport } from "../lib/support-report-local";

/** Uses the real browser producer; never reconstructs the envelope or digest formula. */
export async function canonicalSupportReportFixture(): Promise<DesktopSupportReportResponse> {
  const globals = { Blob, crypto: webcrypto, URL };
  const descriptors = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  let prepared: Awaited<ReturnType<typeof prepareLocalSupportReport>> | undefined;
  try {
    for (const [key, value] of Object.entries(globals))
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    prepared = await prepareLocalSupportReport(new AbortController().signal);
    return prepared.report;
  } finally {
    try {
      prepared?.download.dispose();
    } finally {
      for (const [key, descriptor] of descriptors) {
        if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
        else Object.defineProperty(globalThis, key, descriptor);
      }
    }
  }
}
