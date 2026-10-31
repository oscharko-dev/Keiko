import { useLocale, type MessageValues } from "@/lib/i18n";

/**
 * Copy of the Jira issue template tools (#4177), English and German. It lives beside the tools,
 * like the updater copy, so the shared message catalogs stay untouched.
 */
const EN = {
  "chat.skills.jira.title": "Jira issue templates",
  "chat.skills.jira.description":
    "A template is a skill with a Jira front matter. Keiko checks every issue create, edit and chosen workflow transition against it before anything is sent to Jira, in every mode.",
  "chat.skills.jira.pod": "Jira Pod",
  "chat.skills.jira.podRequired": "Connect a ready Jira Pod to validate a template or propose one.",
  "chat.skills.jira.empty":
    "No Jira issue templates yet. Upload a Markdown skill with a Jira template front matter, or propose one from a project below.",
  "chat.skills.jira.invalid": "Needs repair",
  "chat.skills.jira.validate": "Validate against Jira",
  "chat.skills.jira.validating": "Validating…",
  "chat.skills.jira.valid": "The template matches the Jira instance.",
  "chat.skills.jira.syntax": "The template is malformed ({codes}). Fix it and upload it again.",
  "chat.skills.jira.finding.unknown-project": "Project {subject} does not exist or is not visible.",
  "chat.skills.jira.finding.unknown-issue-type":
    "Issue type {subject} does not exist in the project.",
  "chat.skills.jira.finding.unknown-field":
    "Field {subject} does not exist. Writes it governs will be refused.",
  "chat.skills.jira.finding.ambiguous-field":
    "Several fields are named {subject}. Use the field id to be exact.",
  "chat.skills.jira.finding.unknown-link-type": "Link type {subject} does not exist.",
  "chat.skills.jira.finding.unknown-transition-target":
    "{subject} is not a status of the project. A transition name or id cannot be checked here.",
  "chat.skills.jira.projectKey": "Project key",
  "chat.skills.jira.propose": "Propose from project",
  "chat.skills.jira.proposing": "Reading project…",
  "chat.skills.jira.proposalNone": "No template could be derived from this project.",
  "chat.skills.jira.proposalTitle": "Proposed for {issueType} ({count} issues sampled)",
  "chat.skills.jira.save": "Save as skill",
  "chat.skills.jira.error":
    "Jira or the template library could not be read. Check the Pod and try again.",
  "chat.skills.loading": "Loading…",
} as const;

type CopyKey = keyof typeof EN;

const DE: Readonly<Record<CopyKey, string>> = {
  "chat.skills.jira.title": "Jira-Vorlagen",
  "chat.skills.jira.description":
    "Eine Vorlage ist ein Skill mit Jira-Front-Matter. Keiko prüft jedes Anlegen, Bearbeiten und gewählte Workflow-Übergänge dagegen, bevor etwas an Jira gesendet wird, in jedem Modus.",
  "chat.skills.jira.pod": "Jira-Pod",
  "chat.skills.jira.podRequired":
    "Verbinde einen bereiten Jira-Pod, um eine Vorlage zu prüfen oder vorzuschlagen.",
  "chat.skills.jira.empty":
    "Noch keine Jira-Vorlagen. Lade einen Markdown-Skill mit Jira-Vorlagen-Front-Matter hoch oder schlage unten eine aus einem Projekt vor.",
  "chat.skills.jira.invalid": "Muss korrigiert werden",
  "chat.skills.jira.validate": "Gegen Jira prüfen",
  "chat.skills.jira.validating": "Wird geprüft…",
  "chat.skills.jira.valid": "Die Vorlage passt zur Jira-Instanz.",
  "chat.skills.jira.syntax":
    "Die Vorlage ist fehlerhaft ({codes}). Korrigiere sie und lade sie erneut hoch.",
  "chat.skills.jira.finding.unknown-project":
    "Das Projekt {subject} existiert nicht oder ist nicht sichtbar.",
  "chat.skills.jira.finding.unknown-issue-type":
    "Der Vorgangstyp {subject} existiert im Projekt nicht.",
  "chat.skills.jira.finding.unknown-field":
    "Das Feld {subject} existiert nicht. Davon betroffene Schreibvorgänge werden abgelehnt.",
  "chat.skills.jira.finding.ambiguous-field":
    "Mehrere Felder heißen {subject}. Verwende die Feld-ID, um eindeutig zu sein.",
  "chat.skills.jira.finding.unknown-link-type": "Der Verknüpfungstyp {subject} existiert nicht.",
  "chat.skills.jira.finding.unknown-transition-target":
    "{subject} ist kein Status des Projekts. Ein Übergangsname oder eine ID lässt sich hier nicht prüfen.",
  "chat.skills.jira.projectKey": "Projektschlüssel",
  "chat.skills.jira.propose": "Aus Projekt vorschlagen",
  "chat.skills.jira.proposing": "Projekt wird gelesen…",
  "chat.skills.jira.proposalNone": "Aus diesem Projekt ließ sich keine Vorlage ableiten.",
  "chat.skills.jira.proposalTitle": "Vorschlag für {issueType} ({count} Vorgänge geprüft)",
  "chat.skills.jira.save": "Als Skill speichern",
  "chat.skills.jira.error":
    "Jira oder die Vorlagenbibliothek konnte nicht gelesen werden. Prüfe den Pod und versuche es erneut.",
  "chat.skills.loading": "Wird geladen…",
};

export type JiraTemplateCopy = (key: CopyKey, values?: MessageValues) => string;

export function useJiraTemplateCopy(): JiraTemplateCopy {
  const catalog: Readonly<Record<CopyKey, string>> = useLocale() === "de" ? DE : EN;
  return (key, values) =>
    catalog[key].replace(/\{(\w+)\}/gu, (match, name: string) => String(values?.[name] ?? match));
}
