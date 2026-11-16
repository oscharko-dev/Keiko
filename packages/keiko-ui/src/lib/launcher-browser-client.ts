"use client";
import { bffFetchJson } from "./http";

/** A content-free request. Launcher proof travels only through the native browser opener. */
export async function openLauncherBrowser(): Promise<void> {
  const result = await bffFetchJson<unknown>(
    "/api/coding-workbench/app-session/open-browser",
    {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify({ origin: window.location.origin }),
      signal: AbortSignal.timeout(10_000),
    },
    { repairSession: false },
  );
  if (
    result === null ||
    typeof result !== "object" ||
    !("state" in result) ||
    result.state !== "opened"
  )
    throw new TypeError("Browser launch unavailable.");
}
