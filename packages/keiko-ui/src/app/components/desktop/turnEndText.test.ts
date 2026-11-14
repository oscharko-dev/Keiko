import { beforeAll, describe, expect, it } from "vitest";
import {
  CHAT_TOOL_TURN_END_REASONS,
  CHAT_TURN_END_ITEM_STATES,
  type ChatToolTurnEnd,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { OPTIONAL_WIDGET_DE_MESSAGES } from "@/lib/i18n-messages.optional.de";
import { OPTIONAL_WIDGET_EN_MESSAGES } from "@/lib/i18n-messages.optional.en";
import { loadOptionalWidgetMessages, translateOptionalWidget } from "@/lib/optional-widget-i18n";
import { TURN_END_REASON_KEYS, TURN_END_STATE_KEYS, turnEndText } from "./turnEndText";

const CATALOGS = {
  en: OPTIONAL_WIDGET_EN_MESSAGES as Readonly<Record<string, string>>,
  de: OPTIONAL_WIDGET_DE_MESSAGES as Readonly<Record<string, string>>,
} as const;
const placeholders = (text: string): string[] => text.match(/\{\w+\}/gu)?.sort() ?? [];

describe("the turn ending texts (#4355)", () => {
  // A reason the server can state without a sentence in both languages fails here, so a tenth
  // reason cannot reach a person as a missing key.
  it.each(["en", "de"] as const)(
    "has a %s sentence for every closed reason and item state",
    (locale) => {
      for (const reason of CHAT_TOOL_TURN_END_REASONS) {
        const key = TURN_END_REASON_KEYS[reason];
        expect(CATALOGS[locale][key], `${locale} ${reason}`).toBeTruthy();
      }
      for (const state of CHAT_TURN_END_ITEM_STATES) {
        expect(CATALOGS[locale][TURN_END_STATE_KEYS[state]], `${locale} ${state}`).toBeTruthy();
      }
      expect(Object.keys(TURN_END_REASON_KEYS).sort()).toEqual(
        [...CHAT_TOOL_TURN_END_REASONS].sort(),
      );
      expect(Object.keys(TURN_END_STATE_KEYS).sort()).toEqual(
        [...CHAT_TURN_END_ITEM_STATES].sort(),
      );
    },
  );

  it("has a German text with the same placeholders, different from English, for every key", () => {
    const keys = Object.keys(CATALOGS.en).filter((key) => key.startsWith("chat.turnEnd."));
    expect(keys.length).toBeGreaterThan(20);
    for (const key of keys) {
      const en = CATALOGS.en[key] ?? "";
      const de = CATALOGS.de[key];
      expect(de, key).toBeTruthy();
      expect(placeholders(de ?? ""), key).toEqual(placeholders(en));
      // Item states and a few words may coincide across languages; sentences never do.
      if (en.length > 24) expect(de, key).not.toBe(en);
    }
    expect(
      Object.keys(CATALOGS.de)
        .filter((key) => key.startsWith("chat.turnEnd."))
        .sort(),
    ).toEqual(keys.sort());
  });

  beforeAll(async () => {
    await loadOptionalWidgetMessages("en");
  });

  it("keeps the English wording of the stored answer, receipt for receipt", () => {
    const end: ChatToolTurnEnd = {
      reason: "budget-exhausted",
      completed: [{ tool: "jira_create", key: "REQ-12" }],
      unconfirmed: [{ tool: "jira_edit", key: "REQ-4" }],
      unsettled: [{ tool: "jira_transition" }],
      notDone: [],
      moreCount: 2,
      readCount: 1,
      refusedCount: 1,
    };
    const text = turnEndText(end, (key, values) => translateOptionalWidget("en", key, values));
    expect(text).toContain(
      "This request was not finished: this turn used up its tool-call budget.",
    );
    expect(text).toContain("Completed in this turn:\n- jira_create REQ-12");
    expect(text).toContain(
      "Sent but not confirmed — check these in Jira before retrying:\n- jira_edit REQ-4",
    );
    expect(text).toContain(
      "Started but not settled — check these in Jira before retrying:\n- jira_transition",
    );
    expect(text).toContain("…and 2 more.");
    expect(text).toContain("Reads completed: 1. Refused or failed tool calls: 1.");
    expect(text).not.toContain("Not done");
  });
});
