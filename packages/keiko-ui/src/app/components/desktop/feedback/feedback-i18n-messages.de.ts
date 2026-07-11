import type { FeedbackMessageCatalog } from "./feedback-i18n-messages.en";

export const FEEDBACK_DE_MESSAGES = {
  "feedback.security.eyebrow": "Private Sicherheitsmeldung",
  "feedback.security.title": "Bevor du fortfaehrst",
  "feedback.security.body":
    "Nutze normales Feedback nicht fuer vermutete Schwachstellen, offengelegte Zugangsdaten oder Kundendaten. Verwende stattdessen Keikos privaten Sicherheitskanal.",
  "feedback.security.privateLink": "Sicherheitsproblem privat melden",
  "feedback.security.continue": "Mit normalem Feedback fortfahren",
  "feedback.security.detected":
    "Dieser Bericht beschreibt moeglicherweise eine Sicherheitsluecke. Normales Senden und oeffentliches Teilen sind blockiert. Nutze die private Security-Advisory-Route.",
  "feedback.form.title": "Feedback teilen",
  "feedback.form.description":
    "Beschreibe ein normales Produktproblem. Keiko prueft den lokalen Entwurf, bevor etwas dieses Geraet verlassen kann.",
  "feedback.form.productVersion": "Produktversion",
  "feedback.form.browserDescription": "Browserbeschreibung (optional)",
  "feedback.form.handwrittenEvidence": "Manuell erfasste Nachweise (optional)",
  "feedback.form.category": "Kategorie",
  "feedback.form.platform": "Plattform",
  "feedback.form.featureArea": "Funktionsbereich",
  "feedback.form.impact": "Auswirkung",
  "feedback.form.summaryTitle": "Titel",
  "feedback.form.summaryDescription": "Beschreibung",
  "feedback.form.steps": "Schritte zum Reproduzieren",
  "feedback.form.expected": "Erwartetes Ergebnis",
  "feedback.form.actual": "Tatsaechliches Ergebnis",
  "feedback.form.scan": "Pruefen und Vorschau anzeigen",
  "feedback.form.scanning": "Feedback wird geprueft...",
  "feedback.form.scanError":
    "Keiko konnte keine bereinigte Vorschau erstellen. Pruefe den Entwurf und versuche es erneut.",
  "feedback.form.rewriteRequired":
    "Ueberarbeite das erforderliche Feld und pruefe erneut. Nichts hat dieses Geraet verlassen.",
  "feedback.form.rawLogRejected":
    "Rohprotokolle koennen nicht gesendet werden. Ersetze sie durch eine manuell erstellte bereinigte Nachweiszusammenfassung und pruefe erneut.",
  "feedback.form.attachmentRejected":
    "Der ausgewaehlte Anhang wird nicht als sicherer Text unterstuetzt. Entferne ihn oder waehle eine unterstuetzte Textdatei und pruefe erneut.",
  "feedback.form.sizeRejected":
    "Das Feedback ueberschreitet eine Groessenbegrenzung. Kuerze den betroffenen Inhalt oder entferne Anhaenge und pruefe erneut.",
  "feedback.form.unsafeTextRejected":
    "Der betroffene Text enthaelt nicht unterstuetzte Steuer- oder Formatierungszeichen. Entferne sie und pruefe erneut.",
  "feedback.form.removed.browserDescription":
    "Browserbeschreibung wurde aus dem lokalen Entwurf entfernt. Pruefe erneut, um die Vorschau zu aktualisieren.",
  "feedback.form.removed.handwrittenEvidence":
    "Manuell erfasste Nachweise wurden aus dem lokalen Entwurf entfernt. Pruefe erneut, um die Vorschau zu aktualisieren.",
  "feedback.preview.region": "Bereinigte Vorschau",
  "feedback.preview.title": "Bereinigte Vorschau",
  "feedback.preview.residualRisk":
    "Deterministische Pruefungen koennen proprietaere Daten oder Kundendaten uebersehen. Pruefe den vollstaendigen ausgehenden Text, bevor du ihn sendest oder GitHub oeffnest.",
  "feedback.preview.summary": "Zusammenfassung",
  "feedback.preview.browserDescription": "Browserbeschreibung",
  "feedback.preview.handwrittenEvidence": "Manuell erfasste Nachweise",
  "feedback.preview.steps": "Schritte zum Reproduzieren",
  "feedback.preview.expected": "Erwartetes Ergebnis",
  "feedback.preview.actual": "Tatsaechliches Ergebnis",
  "feedback.preview.attachment": "Anhang {ordinal}",
  "feedback.preview.editAndRescan": "Bearbeiten und erneut pruefen",
  "feedback.preview.publicLink": "Oeffentliches GitHub-Formular oeffnen",
  "feedback.preview.publicNotice":
    "GitHub ist oeffentlich. Vorausgefuellte Werte koennen in URL und Browserverlauf erscheinen.",
  "feedback.preview.copyFallback":
    "Der Bericht ist fuer eine vorausgefuellte URL zu gross. Die vollstaendige bereinigte Kopie steht unten.",
  "feedback.preview.copyAvailable":
    "GitHub fuellt Auswahlfelder moeglicherweise nicht voraus. Die vollstaendige bereinigte Kopie steht unten bereit.",
  "feedback.public.region": "Oeffentliche GitHub-Uebergabe",
  "feedback.public.completeCopy": "Vollstaendiger bereinigter Bericht",
  "feedback.public.copy": "Bereinigten Bericht kopieren",
  "feedback.public.copying": "Bereinigter Bericht wird kopiert...",
  "feedback.public.copySuccess": "Bereinigter Bericht wurde kopiert.",
  "feedback.public.copyError":
    "Keiko konnte den bereinigten Bericht nicht kopieren. Waehle den vollstaendigen Text aus und kopiere ihn manuell.",
  "feedback.public.revalidationRejected":
    "Der vorbereitete Bericht erfuellt die aktuelle lokale Richtlinie nicht mehr. Bearbeite ihn und pruefe ihn erneut.",
  "feedback.public.revalidationError":
    "Keiko konnte die aktuelle lokale Richtlinie nicht bestaetigen. Es wurde keine oeffentliche Nutzlast geoeffnet oder kopiert. Wiederhole die Pruefung oder bearbeite den Bericht und pruefe erneut.",
  "feedback.public.popupBlocked":
    "Dein Browser hat das GitHub-Fenster blockiert. Erlaube Pop-ups fuer Keiko und versuche es erneut oder nutze Bereinigten Bericht kopieren.",
  "feedback.public.reservationTitle": "Oeffentliches GitHub-Formular wird geoeffnet",
  "feedback.public.reservationStatus": "Oeffentliches GitHub-Formular wird geoeffnet…",
  "feedback.submission.exact.title": "Exakte Nutzlast fuer die Uebermittlung",
  "feedback.submission.exact.description":
    "Pruefe das unveraenderliche kanonische JSON und den passenden Digest, die Keiko uebermittelt.",
  "feedback.submission.exact.digest": "SHA-256-Digest",
  "feedback.submission.review.title": "Uebermittlungspruefung",
  "feedback.submission.review.label":
    "Ich habe die exakte bereinigte Nutzlast geprueft und bestaetige, dass sie uebermittelt werden kann.",
  "feedback.submission.continue": "Weiter zur Uebermittlung",
  "feedback.submission.confirm.title": "Feedback-Uebermittlung bestaetigen",
  "feedback.submission.confirm.description":
    "Diese exakte bereinigte Nutzlast an Keikos Maintainer-Pruefwarteschlange uebermitteln.",
  "feedback.submission.submit": "Feedback uebermitteln",
  "feedback.submission.submitting": "Feedback wird uebermittelt...",
  "feedback.submission.accepted": "Feedback wurde zur Maintainer-Pruefung uebermittelt.",
  "feedback.submission.receipt.instructions":
    "Kopiere diesen einmaligen Beleg jetzt. Keiko behaelt ihn nur in diesem geoeffneten Feedback-Fenster; das Geheimnis ist im kopierten Text enthalten.",
  "feedback.submission.receipt.id": "Beleg-ID",
  "feedback.submission.receipt.expires": "Beleg laeuft ab",
  "feedback.submission.receipt.copy": "Einmaligen Beleg kopieren",
  "feedback.submission.receipt.copying": "Beleg wird kopiert...",
  "feedback.submission.receipt.copied":
    "Beleg kopiert. Keiko hat ihn aus diesem Feedback-Fenster entfernt.",
  "feedback.submission.receipt.copyError":
    "Keiko konnte den Beleg nicht kopieren. Er bleibt in diesem Feedback-Fenster verfuegbar.",
  "feedback.submission.unavailable.title": "Feedback-Annahme nicht verfuegbar",
  "feedback.submission.unavailable.message":
    "Keikos Annahmestelle ist derzeit nicht verfuegbar. Versuche es erneut oder nutze das oeffentliche GitHub-Formular.",
  "feedback.submission.rejected.title": "Feedback-Uebermittlung abgelehnt",
  "feedback.submission.rejected.message":
    "Keiko hat dieses Feedback nicht zur Maintainer-Pruefung angenommen.",
  "feedback.submission.rejected.editAndRescan": "Feedback bearbeiten und erneut pruefen",
  "feedback.submission.rateLimited.title": "Feedback-Uebermittlung pausiert",
  "feedback.submission.rateLimited.label": "Warnung",
  "feedback.submission.rateLimited.message":
    "Keiko kann derzeit keine weitere Uebermittlung annehmen. Versuche es spaeter erneut oder nutze das oeffentliche GitHub-Formular.",
  "feedback.submission.rateLimited.editAndRescan": "Feedback bearbeiten",
  "feedback.submission.error.title": "Feedback-Uebermittlung konnte nicht bestaetigt werden",
  "feedback.submission.error.message":
    "Keiko konnte das Ergebnis der Uebermittlung nicht bestaetigen. Wiederhole nur, um einen weiteren Versuch zu starten.",
  "feedback.submission.retry": "Uebermittlung wiederholen",
  "feedback.disposition.region": "Datenschutzaenderungen",
  "feedback.disposition.description":
    "Keiko hat nur die unten aufgefuehrten Einheiten geaendert. Entfernter Text wird nicht angezeigt.",
  "feedback.disposition.field.browserDescription": "Browserbeschreibung",
  "feedback.disposition.field.handwrittenEvidence": "Manuell erfasste Nachweise",
  "feedback.disposition.field.attachment": "Anhang {ordinal}",
  "feedback.disposition.action.redacted": "Geschwaerzt",
  "feedback.disposition.action.quarantined": "In Quarantaene",
  "feedback.disposition.action.omitted": "Ausgelassen",
  "feedback.disposition.unit.quotedSegment": "Zitierter Abschnitt",
  "feedback.disposition.unit.structuredValue": "Strukturierter Wert",
  "feedback.disposition.unit.lineRemainder": "Zeilenrest",
  "feedback.disposition.unit.optionalField": "Optionales Feld",
  "feedback.disposition.unit.attachment": "Anhang",
  "feedback.disposition.message.redacted": "{field}: Sensibler Inhalt wurde geschwaerzt.",
  "feedback.disposition.message.quarantined":
    "{field}: Mehrdeutiger zugangsdatenartiger Inhalt wurde in Quarantaene gestellt.",
  "feedback.disposition.message.omitted":
    "{field}: Es blieb kein sicherer optionaler Inhalt uebrig, daher wurde das Feld ausgelassen.",
  "feedback.disposition.edit": "{field} bearbeiten",
  "feedback.disposition.edit.browserDescription": "Browserbeschreibung bearbeiten",
  "feedback.disposition.edit.handwrittenEvidence": "Manuell erfasste Nachweise bearbeiten",
  "feedback.disposition.remove.browserDescription": "Browserbeschreibung entfernen",
  "feedback.disposition.remove.handwrittenEvidence": "Manuell erfasste Nachweise entfernen",
  "feedback.disposition.reviewAttachment": "Anhang {ordinal} pruefen",
  "feedback.attachment.title": "Textanhaenge (optional)",
  "feedback.attachment.help":
    "Fuege bis zu 3 Textdateien hinzu, jeweils 64 KiB und insgesamt 128 KiB. Dateinamen werden nie uebernommen.",
  "feedback.attachment.add": "Textanhang hinzufuegen",
  "feedback.attachment.selected": "Ausgewaehlte Textanhaenge",
  "feedback.attachment.item": "Anhang {ordinal}",
  "feedback.attachment.remove": "Anhang {ordinal} entfernen",
  "feedback.attachment.removed":
    "Anhang {ordinal} wurde entfernt. Pruefe erneut, um die Vorschau zu aktualisieren.",
  "feedback.attachment.error.count": "Du kannst bis zu 3 Anhaenge hinzufuegen.",
  "feedback.attachment.error.item": "Jeder Anhang darf hoechstens 64 KiB gross sein.",
  "feedback.attachment.error.aggregate":
    "Anhaenge duerfen insgesamt hoechstens 128 KiB gross sein.",
  "feedback.attachment.error.read": "Keiko konnte den ausgewaehlten Textanhang nicht lesen.",
  "feedback.option.category.defect": "Fehler",
  "feedback.option.category.performance": "Leistung",
  "feedback.option.category.usability": "Bedienbarkeit",
  "feedback.option.category.compatibility": "Kompatibilitaet",
  "feedback.option.category.other": "Andere",
  "feedback.option.platform.macOS": "macOS",
  "feedback.option.platform.windows": "Windows",
  "feedback.option.platform.linux": "Linux",
  "feedback.option.platform.other": "Andere",
  "feedback.option.feature.installation": "Installation",
  "feedback.option.feature.modelConfiguration": "Modellkonfiguration",
  "feedback.option.feature.conversation": "Konversation",
  "feedback.option.feature.files": "Dateien",
  "feedback.option.feature.editor": "Editor",
  "feedback.option.feature.terminal": "Terminal",
  "feedback.option.feature.browser": "Browser",
  "feedback.option.feature.localKnowledge": "Lokales Wissen",
  "feedback.option.feature.memory": "Speicher",
  "feedback.option.feature.gitDelivery": "Git-Auslieferung",
  "feedback.option.feature.updates": "Aktualisierungen",
  "feedback.option.feature.voice": "Sprache",
  "feedback.option.feature.other": "Andere",
  "feedback.option.impact.installation": "Blockiert Installation oder Start",
  "feedback.option.impact.modelSetup": "Blockiert Modell- oder Zugangsdaten-Setup",
  "feedback.option.impact.coreBlock": "Blockiert Kern-Workflow",
  "feedback.option.impact.coreDegrade": "Beeintraechtigt Kern-Workflow",
  "feedback.option.impact.usability": "Visuelles oder Bedienproblem",
  "feedback.option.impact.unknown": "Unbekannt",
} satisfies FeedbackMessageCatalog;
