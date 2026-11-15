import { beforeAll, describe, expect, it } from "vitest";
import {
  CHAT_TOOL_BATCH_TOOL_NAME,
  CHAT_TOOL_TURN_END_REASONS,
  CHAT_TURN_END_ITEM_STATES,
  chatTurnEndAnswerFingerprint,
  type ChatToolTurnEnd,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { JIRA_MUTATION_OPERATIONS } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { OPTIONAL_WIDGET_DE_MESSAGES } from "@/lib/i18n-messages.optional.de";
import { OPTIONAL_WIDGET_EN_MESSAGES } from "@/lib/i18n-messages.optional.en";
import {
  loadOptionalWidgetMessages,
  translateOptionalWidget,
  type OptionalWidgetTranslate,
} from "@/lib/optional-widget-i18n";
import {
  TURN_END_REASON_KEYS,
  TURN_END_STATE_KEYS,
  receiptToolLabel,
  turnEndText,
} from "./turnEndText";

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

  const en: OptionalWidgetTranslate = (key, values) => translateOptionalWidget("en", key, values);
  const de: OptionalWidgetTranslate = (key, values) => translateOptionalWidget("de", key, values);

  it("words the ending receipt for receipt with the labels the Jira cards use, never a tool id", async () => {
    await loadOptionalWidgetMessages("de");
    const end: ChatToolTurnEnd = {
      reason: "budget-exhausted",
      answer: chatTurnEndAnswerFingerprint("x"),
      completed: [{ tool: "jira_create", key: "REQ-12" }],
      unconfirmed: [{ tool: "jira_edit", key: "REQ-4" }],
      unsettled: [{ tool: "jira_transition" }],
      notDone: [],
      moreCount: 2,
      readCount: 1,
      refusedCount: 1,
    };
    for (const [t, locale] of [
      [en, "en"],
      [de, "de"],
    ] as const) {
      const text = turnEndText(end, t);
      const labels = ["jira_create", "jira_edit", "jira_transition"].map((tool) =>
        receiptToolLabel(tool, t),
      );
      expect(text, locale).toContain(`${t("chat.turnEnd.completed")}\n- ${labels[0]} REQ-12`);
      expect(text, locale).toContain(`${t("chat.turnEnd.unconfirmed")}\n- ${labels[1]} REQ-4`);
      expect(text, locale).toContain(`${t("chat.turnEnd.unsettled")}\n- ${labels[2]}`);
      expect(text, locale).not.toMatch(/jira_[a-z_]+/u);
      expect(text, locale).toContain(t("chat.turnEnd.more", { count: "2" }));
      expect(text, locale).not.toContain(t("chat.turnEnd.notDone"));
    }
    const text = turnEndText(end, en);
    expect(text).toContain(
      "This request was not finished. This turn used up its tool-call budget.",
    );
    expect(text).toContain("Reads completed: 1. Refused or failed actions: 1.");
  });

  // A tool that can appear in a receipt has a label in both languages; one without a label reads as
  // one neutral word and never as its id.
  it("labels every tool that can appear in a receipt, in both languages", async () => {
    await Promise.all([loadOptionalWidgetMessages("en"), loadOptionalWidgetMessages("de")]);
    const writes = [
      ...JIRA_MUTATION_OPERATIONS.map((operation) => operation.replace(/[.-]/gu, "_")),
      CHAT_TOOL_BATCH_TOOL_NAME,
    ];
    expect(writes.length).toBeGreaterThan(5);
    for (const tool of writes) {
      for (const t of [en, de]) {
        const label = receiptToolLabel(tool, t);
        expect(label.length, tool).toBeGreaterThan(2);
        expect(label, tool).not.toBe(tool);
        expect(label, tool).not.toMatch(/^[a-z]+_[a-z_]+$/u);
      }
    }
    expect(receiptToolLabel("mcp_some_unknown_tool", en)).toBe("Jira action");
    expect(receiptToolLabel("mcp_some_unknown_tool", de)).toBe("Jira-Aktion");
  });

  it("reads as normal sentences in German for every reason: a full stop after the lead, no tool jargon", async () => {
    await loadOptionalWidgetMessages("de");
    for (const reason of CHAT_TOOL_TURN_END_REASONS) {
      const text = turnEndText(
        {
          reason,
          answer: chatTurnEndAnswerFingerprint("x"),
          completed: [],
          unconfirmed: [],
          unsettled: [],
          notDone: [],
          moreCount: 0,
          readCount: 0,
          refusedCount: 0,
        },
        de,
      );
      const lead = text.split("\n")[0] ?? "";
      expect(lead, reason).toMatch(/^Diese Anfrage wurde nicht abgeschlossen\. [A-ZÄÖÜ]/u);
      expect(lead, reason).not.toContain(": ");
      expect(text, reason).not.toMatch(/Tool|Knowledge-Pods-Hub/u);
    }
    expect(de("chat.turnEnd.reason.authenticationFailed")).toContain("Zugangs-Token");
  });
});
