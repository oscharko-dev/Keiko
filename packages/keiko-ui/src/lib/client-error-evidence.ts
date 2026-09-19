// Extends the existing browser diagnostic sink with bounded, body-free runtime evidence.
import { recordClientDiagnosticLoss } from "./client-diagnostics";
import {
  clientErrorClass,
  isClientDiagnosticFrame,
  type ClientErrorEvidence,
} from "@oscharko-dev/keiko-contracts/runtime/diagnostics";

function safeProperty(error: unknown, key: string): unknown {
  if ((typeof error !== "object" || error === null) && typeof error !== "function")
    return undefined;
  try {
    return Reflect.get(error, key);
  } catch {
    recordClientDiagnosticLoss("errorsSuppressed");
    return undefined;
  }
}

function safeClass(error: unknown): string {
  try {
    return clientErrorClass(error);
  } catch {
    recordClientDiagnosticLoss("errorsSuppressed");
    return "Error";
  }
}

function frameLocation(line: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed.startsWith("at ")) {
    return trimmed.endsWith(")")
      ? trimmed.slice(trimmed.lastIndexOf("(") + 1, -1)
      : trimmed.slice(3);
  }
  const separator = trimmed.lastIndexOf("@");
  return separator < 0 ? undefined : trimmed.slice(separator + 1);
}

function safeFrame(line: string): string | undefined {
  const location = frameLocation(line);
  if (
    location === undefined ||
    (!location.startsWith("http://") && !location.startsWith("https://"))
  )
    return undefined;
  const coordinates = /:[0-9]{1,8}:[0-9]{1,8}$/u.exec(location);
  if (coordinates === null) return undefined;
  try {
    const url = new URL(location.slice(0, coordinates.index));
    if (url.origin !== globalThis.location.origin || url.search !== "" || url.hash !== "")
      return undefined;
    const frame = `dist/ui/static${url.pathname}${coordinates[0]}`;
    return isClientDiagnosticFrame(frame) ? frame : undefined;
  } catch {
    recordClientDiagnosticLoss("errorsSuppressed");
    return undefined;
  }
}

function safeFrames(error: unknown): string[] {
  const stack = safeProperty(error, "stack");
  if (typeof stack !== "string") return [];
  return stack
    .slice(0, 16_384)
    .split("\n")
    .slice(0, 64)
    .map(safeFrame)
    .filter((frame) => frame !== undefined)
    .slice(0, 8);
}

/** No raw message, origin, query string, function name or source path leaves this reducer. */
export function clientErrorEvidence(error: unknown): ClientErrorEvidence {
  let frames = safeFrames(error);
  const causeChain: string[] = [];
  const seen = new Set<unknown>([error]);
  let cause = safeProperty(error, "cause");
  while (cause !== undefined && !seen.has(cause) && causeChain.length < 5) {
    seen.add(cause);
    causeChain.push(safeClass(cause));
    // Prefer the original failing location over wrapper frames when the shared budget fills.
    frames = [...new Set([...safeFrames(cause), ...frames])].slice(0, 8);
    cause = safeProperty(cause, "cause");
  }
  return { errorClass: safeClass(error), frames, causeChain };
}
