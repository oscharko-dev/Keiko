import type { UseCodingWorkbenchSafeActivityResult } from "@/lib/useCodingWorkbenchSafeActivity";

/**
 * How many messages of the conversation the person wrote, counted over the live feed. A message that
 * waited for the running turn becomes one of them the moment the runtime hands it to the model, so
 * a change of this count is the signal that the list of waiting messages may have shrunk: the
 * existing refresh signal, so nothing polls. `null` until the feed holds anything. Streamed answer
 * text is deliberately absent: it grows on every delta and changes no waiting message.
 */
export function deliveredMessageSignal(
  feed: UseCodingWorkbenchSafeActivityResult["feed"],
): number | null {
  if (feed === null) return null;
  let count = 0;
  for (const turn of feed.turns) {
    for (const message of turn.messages) {
      if (message.role === "user") count += 1;
    }
  }
  return count;
}
