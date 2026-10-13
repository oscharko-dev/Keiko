import { describe, expect, it } from "vitest";
import { resolveQueryTargetDecision } from "./plan.js";

function decision(text: string): ReturnType<typeof resolveQueryTargetDecision> {
  return resolveQueryTargetDecision(
    { kind: "natural-language", text, caseSensitive: false, maxResults: 50, emittedAtMs: 1 },
    [],
  );
}

describe("one named file owns its explanatory predicate and coordinated objects", () => {
  it.each([
    "Explain src/session.ts and how it preserves elapsed limits.",
    "Please\t explain src/session.ts and how it preserves read, token\t and   elapsed budgets.",
    "Bitte erkläre lib/konto.ts und wie es Eingaben, Ausgaben   und\t Laufzeiten prüft.",
    "Explain src/channel.ts and how it preserves the original read, token and elapsed limits. Cite implementation lines. Keep the answer under 200 words.",
    "Explain how src/cache.ts preserves reads, tokens and elapsed limits.",
    "Explain how src/quota.ts preserves read, token and elapsed budgets.",
    "Describe lib/queue.ts and how it preserves read, token and elapsed limits.",
    "Describe how lib/queue.ts handles the original read and cached entries.",
    "Describe lib/queue.ts and how it validates input, output and cached records.",
    "Erkläre lib/konto.ts und wie es Eingaben, Ausgaben und Laufzeiten prüft.",
    "Explain src/cache.ts and how it separates learned knowledge from source evidence.",
    "Explain how src/cache.ts preserves elapsed limits from cached values.",
    "Explain how src/cache.ts handles all requests.",
    "Explain how src/cache.ts derives learned values from source evidence.",
  ])("binds the parsed same-file predicate: %s", (text) => {
    expect(decision(text).namedFileOnly).toBe(true);
    expect(decision(text).definitionRequested).toBe(false);
  });

  it.each([
    "Explain how src/cache.ts preserves elapsed limits in another folder.",
    "Explain (how src/cache.ts preserves elapsed limits in another folder).",
    "Explain how src/cache.ts validates values inside a directory.",
    "Explain how src/cache.ts validates values outside attached folders.",
    "Explain how src/cache.ts validates values from a repository.",
    "Explain how src/cache.ts validates values in a folder's records.",
    "Explain how src/cache.ts validates inputs across attached folders.",
    "Explain how src/cache.ts validates values within the selected workspace.",
    "Explain how src/cache.ts validates values from another component.",
    "Explain elapsed limits in another folder in src/cache.ts.",
    "Erkläre wie lib/konto.ts Werte innerhalb anderer Arbeitsbereiche prüft.",
    "Explain how src/session.ts preserves elapsed limits, describe pump delays.",
    "Please explain src/session.ts and how it preserves read, token\t and   read another file.",
    "Bitte erkläre lib/konto.ts und wie es Eingaben, Ausgaben   und\t die Steuerung Ausgänge prüft.",
    "Explain how src/session.ts preserves elapsed limits, find unrelated implementations.",
    "Explain how src/session.ts works, explain pump reset delays.",
    "Explain how src/quota.ts preserves timeouts, pump reset delays.",
    "Explain how src/session.ts preserves input explain pump delays.",
    "Explain how src/session.ts preserves elapsed limits and workers expire.",
    "Explain how src/session.ts preserves reads, tokens and workers expire.",
    "Explain how src/quota.ts preserves read, describe delays and elapsed budgets.",
    "Explain how src/quota.ts preserves read, token and read another file.",
    "Explain how src/quota.ts preserves read, token and elapsed budgets, read another file.",
    "Explain how src/quota.ts preserves read, token and elapsed budgets in another folder.",
    "Explain how src/session.ts preserves jobs, messages and describe.",
    "Explain how src/session.ts preserves the original read in other folders.",
    "Explain how src/session.ts handles the original read elsewhere.",
    "Explain how src/session.ts makes the controller read pump reset delays.",
    "Erkläre lib/konto.ts und wie es Eingaben, Ausgaben und Laufzeiten.",
    "Explain src/session.ts and how it preserves elapsed limits. Explain src/other.ts.",
    "Read src/session.ts and how it preserves elapsed limits.",
    "Explain src/session.ts and how another component preserves elapsed limits.",
    "Explain src/session.ts and how it works; then explain an independent topic.",
    "Explain src/session.ts and how it works and explain pump delays.",
    "Explain src/session.ts and how it works and the worker handles messages.",
    "Explain how src/session.ts preserves elapsed limits and a controller validates payloads.",
    "Explain src/session.ts and how it reads and explain pump delays.",
    "Explain src/session.ts and how it calls helpers elsewhere.",
    "Explain src/session.ts and how it compares with another module.",
    "Explain src/session.ts and src/cache.ts and how it preserves elapsed limits.",
    "Explain src/Policy.ts and src/policy.ts and how it preserves elapsed limits.",
    'Explain src/session.ts and how it handles "read and write".',
    'Explain src/session.ts, explain "elapsed limits".',
    "Explain src/session.ts and how it handles requests across other attached folders.",
    "Explain src/session.ts and how it handles request history.",
    "Explain src/session.ts and how it relates to its integration tests.",
  ])("retains independent, ambiguous and nonlocal work: %s", (text) => {
    expect(decision(text).namedFileOnly).toBeUndefined();
  });
});
