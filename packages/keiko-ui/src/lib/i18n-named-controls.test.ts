import { describe, expect, it } from "vitest";
import settingsMessages from "@/app/components/desktop/widgets/panels/settings-i18n.messages.json";
import { DE_LOCAL_KNOWLEDGE_MESSAGES } from "@/app/local-knowledge/local-knowledge-i18n.de";
import { EN_LOCAL_KNOWLEDGE_MESSAGES } from "@/app/local-knowledge/local-knowledge-i18n.en";
import { DE_MESSAGES } from "./i18n-messages.de";
import { EN_MESSAGES } from "./i18n-messages.en";
import { OPTIONAL_WIDGET_DE_MESSAGES } from "./i18n-messages.optional.de";
import { OPTIONAL_WIDGET_EN_MESSAGES } from "./i18n-messages.optional.en";

type Locale = "en" | "de";
type Catalog = Readonly<Record<string, string>>;

// A user-visible sentence that tells a person to open a window, menu or button must name it
// exactly as that control's own catalog entry reads in the same language, so a clerk never looks
// for a name that does not exist (#4371). Each row pairs a sentence with the catalog entry of the
// control it names; the expected name is read from that entry, never restated here, so a rename of
// the control fails this test.
const CORE: Record<Locale, Catalog> = { en: EN_MESSAGES, de: DE_MESSAGES };
const OPTIONAL: Record<Locale, Catalog> = {
  en: OPTIONAL_WIDGET_EN_MESSAGES,
  de: OPTIONAL_WIDGET_DE_MESSAGES,
};
const KNOWLEDGE: Record<Locale, Catalog> = {
  en: EN_LOCAL_KNOWLEDGE_MESSAGES,
  de: DE_LOCAL_KNOWLEDGE_MESSAGES,
};
const SETTINGS = settingsMessages as Readonly<Record<string, Readonly<Record<Locale, string>>>>;

type Source = "core" | "optional" | "knowledge";
type Row = {
  readonly source: Source;
  readonly key: string;
  // Each entry is [source, key] of a control whose visible label the sentence must contain.
  readonly names: readonly (readonly [Source | "settings", string])[];
};

const LOCAL_KNOWLEDGE_WINDOW = ["core", "window.type.localKnowledge.title"] as const;
const SETTINGS_WINDOW = ["core", "window.type.settings.title"] as const;
const MODELS_TAB = ["settings", "settings.tabs.models"] as const;

const ROWS: readonly Row[] = [
  {
    source: "core",
    key: "chat.error.jiraAuthentication.remediation",
    names: [LOCAL_KNOWLEDGE_WINDOW],
  },
  {
    source: "core",
    key: "chat.error.jiraPodVerification.message",
    names: [LOCAL_KNOWLEDGE_WINDOW],
  },
  {
    source: "core",
    key: "chat.error.jiraPodVerification.remediation",
    names: [LOCAL_KNOWLEDGE_WINDOW],
  },
  {
    source: "core",
    key: "chat.error.jiraPodUnavailable.remediation",
    names: [["optional", "chat.connectors.title"]],
  },
  {
    source: "core",
    key: "chat.error.jiraPodConnectionChanged.remediation",
    names: [["optional", "chat.connectors.title"]],
  },
  { source: "optional", key: "chat.jira.liveUnavailable", names: [LOCAL_KNOWLEDGE_WINDOW] },
  {
    source: "knowledge",
    key: "localKnowledge.detail.noSelection",
    names: [LOCAL_KNOWLEDGE_WINDOW],
  },
  {
    source: "knowledge",
    key: "localKnowledge.detail.notFound",
    names: [["knowledge", "localKnowledge.overview.backToPods"]],
  },
  {
    source: "core",
    key: "chat.error.modelNotReady.remediation",
    names: [SETTINGS_WINDOW, MODELS_TAB],
  },
  {
    source: "core",
    key: "gatewaySetup.unusable.unverifiedChat",
    names: [SETTINGS_WINDOW, MODELS_TAB],
  },
  { source: "optional", key: "chat.model.notReady", names: [SETTINGS_WINDOW, MODELS_TAB] },
  { source: "optional", key: "chat.error.modelNotReady", names: [SETTINGS_WINDOW, MODELS_TAB] },
  { source: "core", key: "chat.grounding.help", names: [["core", "window.type.files.title"]] },
];

function sentence(locale: Locale, source: Source, key: string): string {
  const catalogs = source === "core" ? CORE : source === "optional" ? OPTIONAL : KNOWLEDGE;
  const text = catalogs[locale][key];
  if (text === undefined) throw new TypeError(`Missing ${locale} text ${key}`);
  return text;
}

function label(locale: Locale, source: Source | "settings", key: string): string {
  if (source === "settings") {
    const entry = SETTINGS[key];
    if (entry === undefined) throw new TypeError(`Missing settings label ${key}`);
    return entry[locale];
  }
  return sentence(locale, source, key);
}

describe("controls named inside user-visible sentences", () => {
  it.each((["en", "de"] as const).flatMap((locale) => ROWS.map((row) => [locale, row] as const)))(
    "%s %j names its controls as their own labels read",
    (locale, row) => {
      const text = sentence(locale, row.source, row.key);
      for (const [source, key] of row.names) {
        expect(text, `${row.key} must name ${key}`).toContain(label(locale, source, key));
      }
    },
  );

  it.each(["en", "de"] as const)(
    "no %s sentence sends the person to a control name that does not exist",
    (locale) => {
      const stale =
        locale === "en"
          ? ["Knowledge Pods Hub", "Data sources menu"]
          : ["Knowledge Pods Hub", "Menü Datenquellen"];
      const texts = [CORE[locale], OPTIONAL[locale], KNOWLEDGE[locale]].flatMap((catalog) =>
        Object.values(catalog),
      );
      for (const name of stale) expect(texts.filter((text) => text.includes(name))).toEqual([]);
    },
  );
});
