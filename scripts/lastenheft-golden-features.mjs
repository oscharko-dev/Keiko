// Feature catalogue of the golden Lastenheft (Kundenportal und Zahlungsverkehr).
//
// Every entry is `[title, predicate]`: the title names the requirement, the predicate completes the
// sentence "<subject> muss <predicate>." The catalogue is data only; `generate-lastenheft-golden.mjs` turns it into
// the specification, its manifest and the Word and PDF renderings.

/**
 * Presentation styles of a requirement group:
 *  - heading:  `###### ID Titel` with body paragraphs, `Priorität:` and a criteria list
 *  - plain:    `ID: Titel` on its own line, then the same body
 *  - bracket:  `###### [ID] Titel [Priorität]` with the priority as a heading tag
 *  - table:    one Markdown / Word table row per requirement (ID, Titel, Anforderung, Priorität)
 */
export const GROUPS = [
  // ── 3 Funktionale Anforderungen ─────────────────────────────────────────────────────────────
  {
    path: [
      "3 Funktionale Anforderungen",
      "3.1 Kundenportal",
      "3.1.1 Registrierung und Anmeldung",
      "3.1.1.1 Registrierung",
    ],
    prefix: "REQ-FA",
    subject: "Das Kundenportal",
    style: "heading",
    priorityKey: "Priorität",
    features: [
      [
        "Selbstregistrierung für Bestandskunden",
        "die Selbstregistrierung für Bestandskunden über Kundennummer und Aktivierungscode ermöglichen",
      ],
      [
        "Registrierung von Neukunden",
        "die Online-Registrierung von Neukunden einschließlich Legitimationsprüfung unterstützen",
      ],
      [
        "E-Mail-Bestätigung",
        "die angegebene E-Mail-Adresse durch einen Bestätigungslink mit begrenzter Gültigkeit verifizieren",
      ],
      [
        "Mobilnummer & SMS-Verifikation",
        "die Mobilnummer des Kunden per Einmalcode bestätigen, bevor sie für Freigaben genutzt wird",
      ],
      [
        "Aktivierungsbrief",
        "bei Bestandskunden ohne hinterlegte Kontaktdaten einen Aktivierungsbrief auf dem Postweg auslösen",
      ],
      [
        "Vergabe des Benutzernamens",
        "die freie Wahl eines eindeutigen Benutzernamens mit Verfügbarkeitsprüfung anbieten",
      ],
      [
        "Passwortrichtlinie bei Registrierung",
        "die Passwortrichtlinie der Bank bereits bei der Vergabe sichtbar prüfen und erläutern",
      ],
      [
        "Abbruch und Wiederaufnahme",
        "einen abgebrochenen Registrierungsvorgang für 14 Tage speichern und fortsetzbar machen",
      ],
    ],
  },
  {
    path: [
      "3 Funktionale Anforderungen",
      "3.1 Kundenportal",
      "3.1.1 Registrierung und Anmeldung",
      "3.1.1.2 Anmeldung und Authentifizierung",
    ],
    prefix: "REQ-FA",
    subject: "Das Kundenportal",
    style: "heading",
    priorityKey: "Priorität",
    features: [
      [
        "Anmeldung mit Benutzername und Passwort",
        "die Anmeldung mit Benutzername und Passwort als Wissensfaktor bereitstellen",
      ],
      [
        "Zweiter Faktor per Authenticator-App",
        "als zweiten Faktor eine Authenticator-App mit zeitbasierten Einmalcodes unterstützen",
      ],
      [
        "Zweiter Faktor per Push-Freigabe",
        "eine Push-Freigabe in der Banking-App als zweiten Faktor anbieten",
      ],
      [
        "Biometrische Anmeldung",
        "die biometrische Anmeldung auf mobilen Endgeräten über die Betriebssystemfunktionen ermöglichen",
      ],
      [
        "Sperre nach Fehlversuchen",
        "den Zugang nach fünf aufeinanderfolgenden Fehlversuchen vorübergehend sperren",
      ],
      [
        "Passwort zurücksetzen",
        "das Zurücksetzen des Passworts über einen verifizierten Zweitkanal ermöglichen",
      ],
      [
        "Starke Kundenauthentifizierung",
        "die starke Kundenauthentifizierung nach PSD2 für alle zahlungsrelevanten Zugriffe erzwingen",
      ],
      [
        "Anmeldung über Bank-ID",
        "die Anmeldung über eine zertifizierte Bank-ID als Alternative zum Passwort zulassen",
      ],
      [
        "Geräteverwaltung",
        "dem Kunden die Liste seiner vertrauten Geräte anzeigen und das Entfernen einzelner Geräte erlauben",
      ],
    ],
  },
  {
    path: [
      "3 Funktionale Anforderungen",
      "3.1 Kundenportal",
      "3.1.1 Registrierung und Anmeldung",
      "3.1.1.3 Sitzungsverwaltung",
    ],
    prefix: "REQ-FA",
    subject: "Das Kundenportal",
    style: "plain",
    priorityKey: "Prio",
    features: [
      ["Automatische Abmeldung", "eine Sitzung nach 10 Minuten ohne Aktivität automatisch beenden"],
      [
        "Warnung vor Sitzungsende",
        "den Kunden 60 Sekunden vor dem Sitzungsende mit der Möglichkeit zur Verlängerung warnen",
      ],
      [
        "Parallele Sitzungen",
        "gleichzeitige Sitzungen eines Kunden auf höchstens drei Geräte begrenzen",
      ],
      ["Sitzungsübersicht", "dem Kunden alle aktiven Sitzungen mit Gerät, Ort und Beginn anzeigen"],
      ["Fernabmeldung", "die Beendigung einzelner Sitzungen aus der Sitzungsübersicht ermöglichen"],
      [
        "Wiederanmeldung am Ziel",
        "nach einer Wiederanmeldung zur zuletzt aufgerufenen Seite zurückführen, sofern diese keine Eingaben enthielt",
      ],
      [
        "Abmeldung bei Kennwortänderung",
        "bei einer Passwortänderung alle anderen Sitzungen des Kunden beenden",
      ],
      [
        "Sichere Sitzungskennung",
        "die Sitzungskennung ausschließlich in einem als „Secure“ und „HttpOnly“ markierten Cookie führen",
      ],
    ],
  },
  {
    path: [
      "3 Funktionale Anforderungen",
      "3.1 Kundenportal",
      "3.1.2 Profil und Einstellungen",
      "3.1.2.1 Stammdaten",
    ],
    prefix: "REQ-FA",
    subject: "Das Kundenportal",
    style: "heading",
    priorityKey: "Priorität",
    features: [
      [
        "Anzeige der Stammdaten",
        "dem Kunden seine Stammdaten einschließlich Adresse und Kontaktwegen übersichtlich anzeigen",
      ],
      [
        "Adressänderung",
        "die Änderung der Postanschrift mit Nachweisupload und Prüfung durch die Kundenbetreuung ermöglichen",
      ],
      [
        "Änderung der E-Mail-Adresse",
        "eine neue E-Mail-Adresse erst nach Bestätigung beider Adressen übernehmen",
      ],
      [
        "Namensänderung",
        "die Namensänderung nach Heirat oder Scheidung über einen Nachweisprozess abbilden",
      ],
      [
        "Steuerliche Ansässigkeit",
        "die steuerliche Ansässigkeit und die Steuer-ID des Kunden erfassen und plausibilisieren",
      ],
      [
        "Zweitwohnsitz",
        "einen abweichenden Zweitwohnsitz als zusätzliche Adresse mit Verwendungszweck speichern",
      ],
      [
        "Änderungshistorie der Stammdaten",
        "alle Änderungen der Stammdaten mit Zeitpunkt und Kanal nachvollziehbar dokumentieren",
      ],
      [
        "Datenabgleich mit dem Kernbanksystem",
        "Stammdatenänderungen innerhalb von fünf Minuten an das Kernbanksystem übermitteln",
      ],
    ],
  },
  {
    path: [
      "3 Funktionale Anforderungen",
      "3.1 Kundenportal",
      "3.1.2 Profil und Einstellungen",
      "3.1.2.2 Benachrichtigungen",
    ],
    prefix: "REQ-FA",
    subject: "Das Kundenportal",
    style: "table",
    features: [
      [
        "Benachrichtigung bei Kontobewegung",
        "den Kunden über jede Kontobewegung oberhalb eines frei wählbaren Schwellwerts benachrichtigen",
      ],
      [
        "Benachrichtigung über Push-Mitteilung",
        "Benachrichtigungen als Push-Mitteilung an die Banking-App zustellen",
      ],
      [
        "Benachrichtigung per E-Mail",
        "Benachrichtigungen wahlweise per E-Mail ohne vertrauliche Details versenden",
      ],
      ["Benachrichtigung per SMS", "kritische Hinweise auf Wunsch zusätzlich per SMS zustellen"],
      ["Ruhezeiten", "für nicht dringende Benachrichtigungen Ruhezeiten des Kunden beachten"],
      ["Kanalpräferenz je Ereignis", "die Kanalwahl für jede Ereignisart getrennt speichern"],
      [
        "Sicherheitsrelevante Pflichtbenachrichtigung",
        "sicherheitsrelevante Hinweise unabhängig von den Einstellungen des Kunden zustellen",
      ],
      ["Zustellnachweis", "den Zustellstatus jeder Benachrichtigung protokollieren"],
    ],
  },
  {
    path: [
      "3 Funktionale Anforderungen",
      "3.1 Kundenportal",
      "3.1.2 Profil und Einstellungen",
      "3.1.2.3 Einwilligungen und Datenschutzeinstellungen",
    ],
    prefix: "REQ-FA",
    subject: "Das Kundenportal",
    style: "bracket",
    features: [
      [
        "Verwaltung der Einwilligungen",
        "dem Kunden die Einsicht in alle erteilten Einwilligungen mit Datum und Zweck ermöglichen",
      ],
      [
        "Widerruf einer Einwilligung",
        "den Widerruf jeder Einwilligung mit Wirkung für die Zukunft in höchstens zwei Schritten erlauben",
      ],
      [
        "Einwilligung zu Werbung",
        "Einwilligungen zur werblichen Ansprache je Kanal getrennt erfassen",
      ],
      [
        "Einwilligung zur Datenweitergabe",
        "die Weitergabe von Daten an Dritte nur nach ausdrücklicher Einwilligung freischalten",
      ],
      [
        "Datenauskunft",
        "dem Kunden eine Auskunft über die zu seiner Person gespeicherten Daten als Download bereitstellen",
      ],
      [
        "Datenübertragbarkeit",
        "die Daten des Kunden in einem maschinenlesbaren Format exportieren",
      ],
      ["Löschantrag", "einen Löschantrag erfassen und an den Datenschutzbeauftragten weiterleiten"],
      ["Cookie-Einstellungen", "nicht notwendige Cookies erst nach Zustimmung des Nutzers setzen"],
    ],
  },
  {
    path: [
      "3 Funktionale Anforderungen",
      "3.1 Kundenportal",
      "3.1.3 Postfach und Dokumente",
      "3.1.3.1 Elektronisches Postfach",
    ],
    prefix: "REQ-FA",
    subject: "Das elektronische Postfach",
    style: "heading",
    priorityKey: "Priorität",
    features: [
      [
        "Eingang neuer Dokumente",
        "neue Dokumente der Bank mit Eingangsdatum und Ungelesen-Kennzeichen anzeigen",
      ],
      [
        "Filter und Suche im Postfach",
        "die Suche nach Absender, Betreff, Zeitraum und Dokumenttyp bereitstellen",
      ],
      ["Archivierung", "Dokumente für mindestens zehn Jahre unveränderbar vorhalten"],
      [
        "Papierversand abbestellen",
        "den Wechsel vom Papierversand zum elektronischen Postfach je Dokumentart ermöglichen",
      ],
      [
        "Weiterleitung per E-Mail",
        "ein Dokument auf Wunsch verschlüsselt an eine hinterlegte Adresse weiterleiten",
      ],
      [
        "Lesebestätigung",
        "den Zeitpunkt des ersten Öffnens eines rechtlich relevanten Dokuments festhalten",
      ],
      [
        "Sammeldownload",
        "den Download mehrerer Dokumente als ZIP-Datei mit Inhaltsverzeichnis erlauben",
      ],
      [
        "Postfach-Benachrichtigung",
        "bei jedem neuen Dokument eine Benachrichtigung nach den Einstellungen des Kunden auslösen",
      ],
    ],
  },
  {
    path: [
      "3 Funktionale Anforderungen",
      "3.1 Kundenportal",
      "3.1.3 Postfach und Dokumente",
      "3.1.3.2 Dokumentenablage und Upload",
    ],
    prefix: "REQ-FA",
    subject: "Das Kundenportal",
    style: "plain",
    priorityKey: "Priorität",
    features: [
      [
        "Upload von Nachweisen",
        "den Upload von Nachweisen im Format PDF, JPEG und PNG bis 15 MB je Datei unterstützen",
      ],
      [
        "Virenprüfung hochgeladener Dateien",
        "jede hochgeladene Datei vor der Speicherung auf Schadcode prüfen",
      ],
      [
        "Zuordnung zum Vorgang",
        "hochgeladene Dokumente eindeutig einem Vorgang oder Antrag zuordnen",
      ],
      [
        "Mobile Dokumentenaufnahme",
        "die Aufnahme eines Dokuments mit der Kamera des Endgeräts einschließlich Kantenerkennung ermöglichen",
      ],
      ["Statusanzeige der Prüfung", "den Prüfstatus eines hochgeladenen Dokuments anzeigen"],
      [
        "Nachforderung von Unterlagen",
        "fehlende Unterlagen mit Frist und Begründung beim Kunden anfordern",
      ],
      [
        "Löschen eigener Uploads",
        "dem Kunden das Löschen eigener Uploads bis zur Bearbeitung durch die Bank erlauben",
      ],
      [
        "Vorschau von Dokumenten",
        "PDF- und Bilddateien ohne vorherigen Download in einer Vorschau darstellen",
      ],
    ],
  },
  // ── 3.2 Zahlungsverkehr ─────────────────────────────────────────────────────────────────────
  {
    path: [
      "3 Funktionale Anforderungen",
      "3.2 Zahlungsverkehr",
      "3.2.1 SEPA-Zahlungen",
      "3.2.1.1 SEPA-Überweisung",
    ],
    prefix: "REQ-FA",
    subject: "Das Zahlungsverkehrssystem",
    style: "heading",
    priorityKey: "Priorität",
    features: [
      [
        "Erfassung einer SEPA-Überweisung",
        "die Erfassung einer SEPA-Überweisung mit IBAN, Empfängername, Betrag und Verwendungszweck ermöglichen",
      ],
      [
        "IBAN-Prüfung",
        "die IBAN des Empfängers vor Auftragserteilung auf Format und Prüfziffer validieren",
      ],
      [
        "Empfängerüberprüfung",
        "vor der Freigabe einen Abgleich von IBAN und Empfängername nach dem Verfahren „Verification of Payee“ durchführen",
      ],
      [
        "Terminüberweisung",
        "die Vorgabe eines Ausführungstermins bis zu 365 Tage in der Zukunft erlauben",
      ],
      [
        "Vorlagen für Überweisungen",
        "häufig genutzte Überweisungen als Vorlage speichern und wiederverwenden",
      ],
      ["Empfängerverwaltung", "Zahlungsempfänger mit Bezeichnung und IBAN im Adressbuch verwalten"],
      [
        "Auftragsbestätigung",
        "nach Erteilung eine Bestätigung mit Referenznummer und Ausführungsdatum anzeigen",
      ],
      [
        "Stornierung vor Ausführung",
        "die Stornierung eines noch nicht ausgeführten Auftrags erlauben",
      ],
      [
        "Prüfung der Kontodeckung",
        "die Verfügbarkeit von Guthaben oder Dispositionsrahmen vor Ausführung prüfen",
      ],
      ["Zahlungsnachweis", "einen Zahlungsnachweis als PDF mit allen Auftragsdaten erzeugen"],
    ],
  },
  {
    path: [
      "3 Funktionale Anforderungen",
      "3.2 Zahlungsverkehr",
      "3.2.1 SEPA-Zahlungen",
      "3.2.1.2 Echtzeitüberweisung (SCT Inst)",
    ],
    prefix: "REQ-FA",
    subject: "Das Zahlungsverkehrssystem",
    style: "heading",
    priorityKey: "Priorität",
    features: [
      [
        "Echtzeitüberweisung beauftragen",
        "Echtzeitüberweisungen rund um die Uhr an 365 Tagen im Jahr annehmen",
      ],
      [
        "Ausführungszeit der Echtzeitüberweisung",
        "eine Echtzeitüberweisung innerhalb von zehn Sekunden zustellen oder ablehnen",
      ],
      [
        "Betragsgrenze für Echtzeitüberweisungen",
        "ein kundenindividuelles Tageslimit für Echtzeitüberweisungen berücksichtigen",
      ],
      [
        "Empfängerbank nicht erreichbar",
        "bei fehlender Erreichbarkeit der Empfängerbank den Auftrag sofort ablehnen und den Kunden informieren",
      ],
      [
        "Rückmeldung an den Kunden",
        "dem Kunden das Ergebnis der Echtzeitüberweisung unmittelbar anzeigen",
      ],
      [
        "Reservierung des Betrags",
        "den Betrag ab Auftragserteilung bis zur Zustellung reservieren",
      ],
      [
        "Wechsel von Standard auf Echtzeit",
        "dem Kunden bei geeigneten Aufträgen die Ausführung in Echtzeit vorschlagen",
      ],
      [
        "Betrugsprüfung in Echtzeit",
        "jeden Auftrag vor der Zustellung durch die Betrugserkennung bewerten",
      ],
    ],
  },
  {
    path: [
      "3 Funktionale Anforderungen",
      "3.2 Zahlungsverkehr",
      "3.2.1 SEPA-Zahlungen",
      "3.2.1.3 Dauerauftrag",
    ],
    prefix: "REQ-FA",
    subject: "Das Zahlungsverkehrssystem",
    style: "plain",
    priorityKey: "Priorität",
    features: [
      [
        "Dauerauftrag einrichten",
        "die Einrichtung eines Dauerauftrags mit Intervall, Starttermin und optionalem Endtermin ermöglichen",
      ],
      [
        "Dauerauftrag ändern",
        "die Änderung von Betrag und Empfänger bis einen Bankarbeitstag vor der nächsten Ausführung erlauben",
      ],
      [
        "Dauerauftrag aussetzen",
        "das befristete Aussetzen eines Dauerauftrags ohne Löschung unterstützen",
      ],
      [
        "Dauerauftrag löschen",
        "das Löschen eines Dauerauftrags mit Bestätigung durch zweiten Faktor verlangen",
      ],
      [
        "Ausführung am Monatsende",
        "Daueraufträge zum Monatsletzten korrekt auch in kürzeren Monaten ausführen",
      ],
      [
        "Ausführung an Nichtbankarbeitstagen",
        "auf einen Nicht-Bankarbeitstag fallende Termine auf den folgenden Bankarbeitstag verschieben",
      ],
      [
        "Übersicht der Daueraufträge",
        "alle Daueraufträge mit nächstem Ausführungstermin tabellarisch anzeigen",
      ],
      [
        "Mangelnde Deckung bei Dauerauftrag",
        "bei fehlender Deckung den Dauerauftrag nach den Vorgaben der Bank erneut versuchen und den Kunden informieren",
      ],
    ],
  },
  {
    path: [
      "3 Funktionale Anforderungen",
      "3.2 Zahlungsverkehr",
      "3.2.1 SEPA-Zahlungen",
      "3.2.1.4 SEPA-Lastschrift",
    ],
    prefix: "REQ-FA",
    subject: "Das Zahlungsverkehrssystem",
    style: "table",
    features: [
      [
        "Erteilung eines SEPA-Mandats",
        "SEPA-Lastschriftmandate des Kunden elektronisch erfassen und ablegen",
      ],
      [
        "Widerruf eines Mandats",
        "den Widerruf eines Mandats im Portal mit sofortiger Wirkung entgegennehmen",
      ],
      [
        "Rückgabe einer Lastschrift",
        "die Rückgabe einer Lastschrift innerhalb von acht Wochen nach Belastung ermöglichen",
      ],
      ["Mandatsübersicht", "alle aktiven und widerrufenen Mandate mit Gläubiger-ID anzeigen"],
      [
        "Sperre für Lastschriften",
        "Lastschriften generell oder für einzelne Gläubiger sperren lassen",
      ],
      [
        "Vorabankündigung (Pre-Notification)",
        "die Pre-Notification des Gläubigers im Postfach des Kunden anzeigen",
      ],
      [
        "Lastschrifteinreichung für Firmenkunden",
        "Firmenkunden die Einreichung von Lastschriftdateien im Format pain.008 ermöglichen",
      ],
      [
        "Prüfung der Gläubiger-Identifikationsnummer",
        "die Gläubiger-Identifikationsnummer auf Format und Prüfziffer validieren",
      ],
    ],
  },
  {
    path: [
      "3 Funktionale Anforderungen",
      "3.2 Zahlungsverkehr",
      "3.2.2 Sammel- und Auslandszahlungen",
      "3.2.2.1 Sammelaufträge und Dateiimport",
    ],
    prefix: "REQ-FA",
    subject: "Das Zahlungsverkehrssystem",
    style: "heading",
    priorityKey: "Priorität",
    features: [
      [
        "Import von Zahlungsdateien",
        "den Import von Sammelaufträgen im Format pain.001 bis zu 10.000 Positionen verarbeiten",
      ],
      [
        "Fehlerbericht beim Import",
        "fehlerhafte Positionen einer Datei mit Zeilennummer und Grund ausweisen, ohne gültige Positionen zu blockieren",
      ],
      ["Sammelbelastung", "einen Sammelauftrag wahlweise als Einzel- oder Sammelbelastung buchen"],
      [
        "Vier-Augen-Prinzip für Sammelaufträge",
        "Sammelaufträge ab einem Gesamtbetrag von 50.000 Euro nur nach Freigabe durch einen zweiten Berechtigten ausführen",
      ],
      ["Teilfreigabe", "die Freigabe einzelner Positionen eines Sammelauftrags erlauben"],
      [
        "Duplikaterkennung",
        "bereits eingereichte Dateien anhand ihrer Nachrichten-ID erkennen und die erneute Einreichung abweisen",
      ],
      [
        "Statusverfolgung je Position",
        "den Status jeder Position eines Sammelauftrags einzeln anzeigen",
      ],
      ["Rückmeldedatei", "nach der Verarbeitung eine Statusdatei im Format pain.002 bereitstellen"],
      [
        "Zeitfenster für Dateieinreichung",
        "die Annahmeschlüsse für Dateien je Zahlungsart im Portal anzeigen",
      ],
    ],
  },
  {
    path: [
      "3 Funktionale Anforderungen",
      "3.2 Zahlungsverkehr",
      "3.2.2 Sammel- und Auslandszahlungen",
      "3.2.2.2 Auslandszahlungen",
    ],
    prefix: "REQ-FA",
    subject: "Das Zahlungsverkehrssystem",
    style: "plain",
    priorityKey: "Priorität",
    features: [
      [
        "Auslandsüberweisung außerhalb SEPA",
        "Auslandsüberweisungen in Fremdwährung mit BIC und Empfängeradresse erfassen",
      ],
      [
        "Anzeige von Wechselkurs und Entgelten",
        "Wechselkurs, Entgelte und Gesamtbetrag vor der Freigabe transparent ausweisen",
      ],
      ["Kostenteilung", "die Entgeltregelung SHA, OUR und BEN auswählbar machen"],
      [
        "Meldepflichten nach AWV",
        "Zahlungen über der Meldegrenze mit den erforderlichen Angaben für die Meldung an die Bundesbank versehen",
      ],
      ["Währungsliste", "die unterstützten Währungen mit Annahmeschluss und Valutierung anzeigen"],
      [
        "Devisenhandel zu Wunschkurs",
        "Aufträge zu einem vom Kunden festgelegten Limitkurs bis zu 30 Tage vormerken",
      ],
      [
        "Nachverfolgung internationaler Zahlungen",
        "den Status einer Auslandszahlung über die SWIFT-Referenz nachverfolgbar machen",
      ],
      [
        "Rückläufer bei Auslandszahlungen",
        "zurückgewiesene Auslandszahlungen mit Rückweisungsgrund und Gegenwert im Portal anzeigen",
      ],
    ],
  },
  {
    path: [
      "3 Funktionale Anforderungen",
      "3.2 Zahlungsverkehr",
      "3.2.3 Freigabe und Limits",
      "3.2.3.1 Freigabeworkflow",
    ],
    prefix: "REQ-FA",
    subject: "Das Zahlungsverkehrssystem",
    style: "heading",
    priorityKey: "Priorität",
    features: [
      [
        "Freigabe durch zweiten Faktor",
        "jede Zahlung durch eine Transaktionsfreigabe mit dynamischer Verknüpfung von Betrag und Empfänger bestätigen",
      ],
      [
        "Anzeige der Freigabedaten",
        "vor der Freigabe Betrag und Empfänger auf dem Freigabegerät unverändert darstellen",
      ],
      [
        "Kollektivfreigabe",
        "bei Firmenkunden die Freigabe durch zwei Zeichnungsberechtigte mit Einzel- oder Gesamtvertretung abbilden",
      ],
      [
        "Freigabe-Eskalation",
        "nicht freigegebene Aufträge nach 24 Stunden an die Vertretung eskalieren",
      ],
      [
        "Ablehnung mit Begründung",
        "die Ablehnung eines Auftrags durch den Freigeber mit Begründung erfassen",
      ],
      ["Freigabehistorie", "die Freigabehistorie je Auftrag mit Benutzer und Zeitpunkt anzeigen"],
      [
        "Freigabe-Delegation",
        "die zeitlich befristete Delegation der Freigabeberechtigung ermöglichen",
      ],
      [
        "Vertrauenswürdige Empfänger",
        "für vom Kunden benannte Empfänger eine Befreiung von der starken Kundenauthentifizierung nach Maßgabe der PSD2 nutzen",
      ],
    ],
  },
  {
    path: [
      "3 Funktionale Anforderungen",
      "3.2 Zahlungsverkehr",
      "3.2.3 Freigabe und Limits",
      "3.2.3.2 Limits",
    ],
    prefix: "REQ-FA",
    subject: "Das Zahlungsverkehrssystem",
    style: "bracket",
    features: [
      ["Tageslimit je Kunde", "ein Tageslimit je Kunde und Zahlungsart durchsetzen"],
      [
        "Änderung des Limits durch den Kunden",
        "die Absenkung des Limits im Portal sofort und die Erhöhung nach zusätzlicher Authentifizierung wirksam werden lassen",
      ],
      [
        "Limit je Bevollmächtigtem",
        "für Bevollmächtigte eigene Limits unterhalb des Limits des Vollmachtgebers führen",
      ],
      [
        "Limitüberschreitung",
        "bei Überschreitung des Limits den Auftrag ablehnen und die Restmenge anzeigen",
      ],
      [
        "Temporäre Limiterhöhung",
        "eine befristete Erhöhung des Limits für einen einzelnen Auftrag mit Freigabe durch die Bank erlauben",
      ],
      [
        "Anzeige des verfügbaren Limits",
        "das noch verfügbare Limit vor jeder Auftragserfassung anzeigen",
      ],
      [
        "Monatslimit für Kartenzahlungen",
        "Monatslimits für Kartenzahlungen getrennt von Überweisungslimits führen",
      ],
      [
        "Limitprotokoll",
        "jede Änderung eines Limits mit Benutzer, Kanal und Zeitpunkt revisionssicher protokollieren",
      ],
    ],
  },
  // ── 3.3 Konten, Karten und Kredite ──────────────────────────────────────────────────────────
  {
    path: [
      "3 Funktionale Anforderungen",
      "3.3 Konten, Karten und Kredite",
      "3.3.1 Konten und Umsätze",
      "3.3.1.1 Kontoübersicht",
    ],
    prefix: "REQ-FA",
    subject: "Das Kundenportal",
    style: "heading",
    priorityKey: "Priorität",
    features: [
      [
        "Anzeige aller Konten",
        "alle Konten, Depots und Kredite des Kunden in einer Übersicht zusammenfassen",
      ],
      [
        "Kontostand und Verfügbarer Betrag",
        "Kontostand, gebuchten Saldo und verfügbaren Betrag getrennt ausweisen",
      ],
      [
        "Konten ausblenden",
        "dem Kunden das Ausblenden einzelner Konten aus der Übersicht erlauben",
      ],
      ["Eigene Kontobezeichnung", "die Vergabe frei wählbarer Kontobezeichnungen ermöglichen"],
      ["Kontoreihenfolge", "die Sortierung der Konten per Drag-and-drop anpassbar machen"],
      [
        "Konten anderer Banken",
        "Konten anderer Institute über eine Kontoinformationsschnittstelle nach Einwilligung einbinden",
      ],
      [
        "Anzeige der IBAN mit Kopierfunktion",
        "die IBAN eines Kontos formatiert anzeigen und mit einer Aktion in die Zwischenablage übernehmen",
      ],
      [
        "Darstellung für Gemeinschaftskonten",
        "bei Gemeinschaftskonten alle Verfügungsberechtigten anzeigen",
      ],
    ],
  },
  {
    path: [
      "3 Funktionale Anforderungen",
      "3.3 Konten, Karten und Kredite",
      "3.3.1 Konten und Umsätze",
      "3.3.1.2 Umsätze und Kategorisierung",
    ],
    prefix: "REQ-FA",
    subject: "Das Kundenportal",
    style: "plain",
    priorityKey: "Priorität",
    features: [
      [
        "Umsatzliste",
        "die Umsätze eines Kontos mit Buchungsdatum, Wertstellung, Verwendungszweck und Betrag anzeigen",
      ],
      ["Umsatzsuche", "die Volltextsuche in Verwendungszweck und Auftraggeber unterstützen"],
      ["Filter nach Zeitraum und Betrag", "Umsätze nach Zeitraum, Betrag und Buchungsart filtern"],
      [
        "Automatische Kategorisierung",
        "Umsätze anhand lernender Regeln einer Ausgabenkategorie zuordnen",
      ],
      [
        "Manuelle Kategorienkorrektur",
        "die Korrektur einer Kategorie durch den Kunden übernehmen und für gleichartige Umsätze vorschlagen",
      ],
      ["Vorgemerkte Umsätze", "vorgemerkte Umsätze deutlich von gebuchten Umsätzen unterscheiden"],
      [
        "Umsatzdetails",
        "zu jedem Umsatz alle Einzelheiten wie Mandatsreferenz und End-to-End-Referenz anzeigen",
      ],
      ["Belege zu Umsätzen", "an einen Umsatz einen Beleg als Bild oder PDF anhängen lassen"],
      ["Export von Umsätzen", "Umsätze als CSV, CAMT.053 und PDF exportieren"],
    ],
  },
  {
    path: [
      "3 Funktionale Anforderungen",
      "3.3 Konten, Karten und Kredite",
      "3.3.1 Konten und Umsätze",
      "3.3.1.3 Kontoauszüge",
    ],
    prefix: "REQ-FA",
    subject: "Das Kundenportal",
    style: "heading",
    priorityKey: "Priorität",
    features: [
      [
        "Elektronischer Kontoauszug",
        "Kontoauszüge monatlich oder auf Wunsch quartalsweise als PDF bereitstellen",
      ],
      [
        "Rechnungsabschluss",
        "Rechnungsabschlüsse mit Zins- und Entgeltaufstellung im Postfach ablegen",
      ],
      ["Nachträgliche Auszüge", "Kontoauszüge der letzten zehn Jahre abrufbar halten"],
      [
        "Einhaltung der Aufbewahrungsfristen",
        "Kontoauszüge unveränderlich nach den handels- und steuerrechtlichen Fristen aufbewahren",
      ],
      [
        "Barrierefreier Kontoauszug",
        "Kontoauszüge zusätzlich in einer barrierefreien Fassung bereitstellen",
      ],
      [
        "Duplikat anfordern",
        "ein beglaubigtes Duplikat eines Kontoauszugs als gebührenpflichtigen Auftrag anbieten",
      ],
      [
        "Versand an Steuerberater",
        "die Freigabe von Kontoauszügen für einen Steuerberater mit befristetem Zugriff ermöglichen",
      ],
    ],
  },
  {
    path: [
      "3 Funktionale Anforderungen",
      "3.3 Konten, Karten und Kredite",
      "3.3.2 Karten",
      "3.3.2.1 Kartenverwaltung",
    ],
    prefix: "REQ-FA",
    subject: "Das Kundenportal",
    style: "heading",
    priorityKey: "Priorität",
    features: [
      [
        "Kartenübersicht",
        "alle Debit- und Kreditkarten mit Status, Ablaufdatum und letzten vier Ziffern anzeigen",
      ],
      ["Neue Karte beantragen", "die Beantragung einer Zusatz- oder Ersatzkarte ermöglichen"],
      [
        "PIN-Anzeige",
        "die PIN einer Karte einmalig und nur nach starker Authentifizierung anzeigen",
      ],
      [
        "Kartenlimits ändern",
        "Limits für Bargeldabhebung und Kartenzahlung durch den Kunden anpassen lassen",
      ],
      [
        "Regionale Einsatzgebiete",
        "den Einsatz der Karte für Regionen und Händlerkategorien ein- und ausschaltbar machen",
      ],
      ["Kontaktlose Zahlung abschalten", "kontaktlose Zahlungen separat deaktivieren lassen"],
      ["Digitale Karte", "die Provisionierung der Karte in mobile Wallets unterstützen"],
      [
        "Kartenumsätze in Echtzeit",
        "Kartenumsätze innerhalb von 30 Sekunden als vorgemerkten Umsatz anzeigen",
      ],
    ],
  },
  {
    path: [
      "3 Funktionale Anforderungen",
      "3.3 Konten, Karten und Kredite",
      "3.3.2 Karten",
      "3.3.2.2 Kartensperre und Missbrauch",
    ],
    prefix: "REQ-FA",
    subject: "Das Kundenportal",
    style: "plain",
    priorityKey: "Priorität",
    features: [
      [
        "Sofortige Kartensperre",
        "die sofortige Sperre einer Karte mit einer einzelnen Aktion ohne zweiten Faktor ermöglichen",
      ],
      [
        "Aufhebung der Sperre",
        "die Entsperrung einer vorübergehend gesperrten Karte nach Authentifizierung zulassen",
      ],
      [
        "Endgültige Sperre bei Verlust",
        "bei Verlust oder Diebstahl die endgültige Sperre mit Ausstellung einer Ersatzkarte auslösen",
      ],
      ["Sperr-Notruf", "die Sperrung zusätzlich über die zentrale Sperrnummer ermöglichen"],
      [
        "Meldung verdächtiger Umsätze",
        "dem Kunden das Melden eines nicht autorisierten Umsatzes direkt am Umsatz erlauben",
      ],
      [
        "Reklamationsprozess",
        "für gemeldete Umsätze einen Reklamationsvorgang mit Statusverfolgung anlegen",
      ],
      [
        "Benachrichtigung bei Kartenzahlung im Ausland",
        "bei Kartenzahlungen außerhalb des Heimatlandes eine Benachrichtigung auslösen",
      ],
      [
        "Automatische Sperre bei Betrugsverdacht",
        "eine Karte bei begründetem Betrugsverdacht vorübergehend sperren und den Kunden kontaktieren",
      ],
    ],
  },
  {
    path: [
      "3 Funktionale Anforderungen",
      "3.3 Konten, Karten und Kredite",
      "3.3.3 Kreditanfragen",
      "3.3.3.1 Antragsstrecke",
    ],
    prefix: "REQ-FA",
    subject: "Das Kundenportal",
    style: "heading",
    priorityKey: "Priorität",
    features: [
      ["Kreditrechner", "einen Kreditrechner mit Laufzeit, Rate und Gesamtkosten bereitstellen"],
      [
        "Antrag auf Ratenkredit",
        "den Antrag auf einen Ratenkredit vollständig digital ermöglichen",
      ],
      ["Vorbefüllung mit Bestandsdaten", "bekannte Daten des Kunden aus dem Stamm vorbefüllen"],
      [
        "Einkommensnachweis",
        "Einkommensnachweise per Upload oder über eine Kontoeinsicht entgegennehmen",
      ],
      [
        "Abschluss mit qualifizierter Signatur",
        "den Kreditvertrag per qualifizierter elektronischer Signatur abschließen lassen",
      ],
      [
        "Widerrufsbelehrung",
        "die Widerrufsbelehrung mit Frist und Adressaten vor Vertragsabschluss anzeigen",
      ],
      [
        "Vorvertragliche Information",
        "die Europäischen Standardinformationen für Verbraucherkredite vor Abschluss bereitstellen",
      ],
      ["Speichern und Fortsetzen", "einen unvollständigen Antrag 30 Tage vorhalten"],
    ],
  },
  {
    path: [
      "3 Funktionale Anforderungen",
      "3.3 Konten, Karten und Kredite",
      "3.3.3 Kreditanfragen",
      "3.3.3.2 Bonitätsprüfung und Entscheidung",
    ],
    prefix: "REQ-FA",
    subject: "Die Kreditentscheidung",
    style: "plain",
    priorityKey: "Priorität",
    features: [
      [
        "Abruf der Auskunftei",
        "mit Einwilligung des Kunden eine Bonitätsauskunft bei der Auskunftei abrufen",
      ],
      [
        "Scoring und Regelwerk",
        "die Entscheidung anhand eines versionierten Regelwerks und des Scorings treffen",
      ],
      [
        "Automatische Entscheidung",
        "Anträge innerhalb festgelegter Grenzen innerhalb von 60 Sekunden automatisch entscheiden",
      ],
      [
        "Manuelle Prüfung",
        "Anträge außerhalb der Grenzen an die Kreditsachbearbeitung weiterleiten",
      ],
      [
        "Begründung der Ablehnung",
        "dem Kunden die Ablehnung mit den maßgeblichen Gründen und dem Hinweis auf menschliche Überprüfung mitteilen",
      ],
      [
        "Haushaltsrechnung",
        "die Haushaltsrechnung des Kunden mit Einnahmen und Ausgaben berücksichtigen",
      ],
      [
        "Sicherheiten",
        "Sicherheiten zu einem Kredit erfassen und ihren Wert bis zur Auszahlung prüfen",
      ],
      [
        "Auszahlungsfreigabe",
        "die Auszahlung erst nach Vorliegen aller Auszahlungsvoraussetzungen freigeben",
      ],
    ],
  },
  // ── 3.4 Versicherungen ──────────────────────────────────────────────────────────────────────
  {
    path: [
      "3 Funktionale Anforderungen",
      "3.4 Versicherungen und Schadenmeldung",
      "3.4.1 Verträge und Policen",
      "3.4.1.1 Vertragsübersicht",
    ],
    prefix: "REQ-FA",
    subject: "Das Versicherungsmodul",
    style: "heading",
    priorityKey: "Priorität",
    features: [
      [
        "Übersicht aller Verträge",
        "alle Versicherungsverträge des Kunden mit Sparte, Beitrag und Laufzeit anzeigen",
      ],
      [
        "Vertragsdetails",
        "zu jedem Vertrag Leistungsumfang, Selbstbeteiligung und Zahlweise darstellen",
      ],
      ["Police als PDF", "die aktuelle Versicherungspolice als PDF bereitstellen"],
      [
        "Änderung der Zahlweise",
        "die Änderung der Beitragszahlweise zum nächsten Fälligkeitstermin ermöglichen",
      ],
      [
        "Änderung der Bankverbindung",
        "die Änderung der Bankverbindung für den Beitragseinzug nach Authentifizierung zulassen",
      ],
      [
        "Kündigung",
        "die Kündigung eines Vertrags in Textform mit Bestätigung im Postfach erfassen",
      ],
      ["Beitragsrechnung", "Beitragsrechnungen und Zahlungsstatus je Vertrag anzeigen"],
      ["Bedingungswerk", "das jeweils gültige Bedingungswerk versioniert zum Abruf bereithalten"],
    ],
  },
  {
    path: [
      "3 Funktionale Anforderungen",
      "3.4 Versicherungen und Schadenmeldung",
      "3.4.2 Schadenmeldung",
      "3.4.2.1 Meldung und Bearbeitung",
    ],
    prefix: "REQ-FA",
    subject: "Das Versicherungsmodul",
    style: "heading",
    priorityKey: "Priorität",
    features: [
      [
        "Schadenmeldung erfassen",
        "die Meldung eines Schadens mit Datum, Ort, Hergang und Schadenhöhe erfassen",
      ],
      ["Fotos und Belege", "bis zu 20 Fotos und Belege je Schadenfall entgegennehmen"],
      ["Auswahl des Vertrags", "den betroffenen Vertrag aus der Vertragsübersicht vorschlagen"],
      [
        "Plausibilitätsprüfung",
        "Angaben auf Vollständigkeit und Widersprüche prüfen, bevor die Meldung abgeschlossen wird",
      ],
      [
        "Schadennummer",
        "nach Abschluss unverzüglich eine eindeutige Schadennummer vergeben und anzeigen",
      ],
      [
        "Statusverfolgung des Schadens",
        "den Bearbeitungsstand mit den Schritten Eingang, Prüfung, Regulierung und Abschluss darstellen",
      ],
      [
        "Rückfragen des Sachbearbeiters",
        "Rückfragen der Sachbearbeitung im Portal beantwortbar machen",
      ],
      ["Gutachtertermin", "einen Termin mit dem Gutachter im Portal vereinbaren und ändern lassen"],
      [
        "Auszahlung der Entschädigung",
        "die Auszahlung der Entschädigung auf das hinterlegte Konto anstoßen und im Portal bestätigen",
      ],
      [
        "Betrugsindikatoren",
        "auffällige Schadenmeldungen nach festgelegten Regeln zur gesonderten Prüfung markieren",
      ],
    ],
  },
  // ── 4 Nichtfunktionale Anforderungen ────────────────────────────────────────────────────────
  {
    path: [
      "4 Nichtfunktionale Anforderungen",
      "4.1 Leistung und Skalierung",
      "4.1.1 Antwortzeiten",
      "4.1.1.1 Antwortzeiten im Normalbetrieb",
    ],
    prefix: "NFA-PERF",
    subject: "Das System",
    style: "heading",
    priorityKey: "Priorität",
    features: [
      [
        "Antwortzeit der Startseite",
        "die Startseite nach der Anmeldung im 95. Perzentil in höchstens 1,5 Sekunden vollständig darstellen",
      ],
      [
        "Antwortzeit der Umsatzliste",
        "die Umsatzliste mit 50 Einträgen im 95. Perzentil in höchstens 800 Millisekunden ausliefern",
      ],
      [
        "Antwortzeit der Auftragserfassung",
        "die Bestätigung eines Zahlungsauftrags im 99. Perzentil in höchstens 2 Sekunden liefern",
      ],
      [
        "Antwortzeit der Suche",
        "Suchanfragen im Postfach im 95. Perzentil in höchstens 1 Sekunde beantworten",
      ],
      [
        "Zeit bis zur Interaktion (mobil)",
        "auf einem Mittelklasse-Smartphone im Mobilfunknetz den ersten bedienbaren Zustand in höchstens 3 Sekunden erreichen",
      ],
      [
        "Größe der Startseite",
        "die übertragene Datenmenge der Startseite auf höchstens 1,2 MB begrenzen",
      ],
      [
        "Dateiimport",
        "eine Zahlungsdatei mit 10.000 Positionen in höchstens 60 Sekunden einlesen und prüfen",
      ],
      ["Batch-Fenster", "alle nächtlichen Verarbeitungsläufe bis 05:00 Uhr abschließen"],
    ],
  },
  {
    path: [
      "4 Nichtfunktionale Anforderungen",
      "4.1 Leistung und Skalierung",
      "4.1.2 Last und Kapazität",
      "4.1.2.1 Lastprofile",
    ],
    prefix: "NFA-PERF",
    subject: "Das System",
    style: "plain",
    priorityKey: "Priorität",
    features: [
      ["Gleichzeitige Nutzer", "mindestens 25.000 gleichzeitig angemeldete Kunden bedienen"],
      [
        "Spitzenlast zum Monatsende",
        "am Monatsende bis zu 400 Zahlungsaufträge pro Sekunde annehmen",
      ],
      [
        "Lastspitzen zu Gehaltseingang",
        "die Anzahl der Transaktionen am Gehaltstag um den Faktor drei gegenüber dem Mittel verkraften",
      ],
      ["Horizontale Skalierung", "bei steigender Last automatisch weitere Instanzen zuschalten"],
      [
        "Rückbau bei sinkender Last",
        "ungenutzte Instanzen nach 15 Minuten geringer Auslastung wieder abbauen",
      ],
      [
        "Datenwachstum",
        "ein jährliches Datenwachstum von 40 Prozent ohne Architekturänderung bewältigen",
      ],
      [
        "Lasttest vor Freigabe",
        "vor jeder Hauptversion einen Lasttest mit 150 Prozent der erwarteten Spitzenlast bestehen",
      ],
      ["Begrenzung je Client", "Anfragen je Client auf 100 pro Minute begrenzen"],
    ],
  },
  {
    path: [
      "4 Nichtfunktionale Anforderungen",
      "4.2 Verfügbarkeit und Betrieb",
      "4.2.1 Verfügbarkeit",
      "4.2.1.1 Verfügbarkeitsziele",
    ],
    prefix: "NFA-AVL",
    subject: "Das System",
    style: "heading",
    priorityKey: "Priorität",
    features: [
      [
        "Verfügbarkeit des Portals",
        "eine Verfügbarkeit von 99,9 Prozent je Kalendermonat erreichen",
      ],
      [
        "Verfügbarkeit des Zahlungsverkehrs",
        "die Annahme von Echtzeitüberweisungen mit 99,95 Prozent Verfügbarkeit betreiben",
      ],
      [
        "Wartungsfenster",
        "geplante Wartungen auf höchstens vier Stunden pro Monat in der Nacht von Sonntag auf Montag beschränken",
      ],
      [
        "Ankündigung von Wartungen",
        "geplante Wartungen mindestens fünf Werktage vorher im Portal ankündigen",
      ],
      [
        "Wiederanlaufzeit (RTO)",
        "nach einem Ausfall des Rechenzentrums den Betrieb innerhalb von 60 Minuten wiederherstellen",
      ],
      [
        "Datenverlust (RPO)",
        "bei einem Ausfall höchstens fünf Minuten an bestätigten Transaktionen verlieren",
      ],
      ["Georedundanz", "alle Dienste in zwei räumlich getrennten Rechenzentren betreiben"],
      [
        "Degradierter Betrieb",
        "bei Ausfall nachgelagerter Systeme die Anzeige der Konten und Umsätze aus dem Zwischenspeicher fortsetzen",
      ],
    ],
  },
  {
    path: [
      "4 Nichtfunktionale Anforderungen",
      "4.2 Verfügbarkeit und Betrieb",
      "4.2.2 Betrieb und Überwachung",
      "4.2.2.1 Monitoring und Alarmierung",
    ],
    prefix: "NFA-OPS",
    subject: "Der Betrieb",
    style: "plain",
    priorityKey: "Prio",
    features: [
      [
        "Technisches Monitoring",
        "alle Dienste mit Metriken zu Latenz, Fehlerrate und Auslastung überwachen",
      ],
      [
        "Fachliches Monitoring",
        "fachliche Kennzahlen wie die Zahl erfolgreicher Anmeldungen und Zahlungen minütlich erfassen",
      ],
      [
        "Alarmierung",
        "bei Überschreitung der Schwellwerte den Bereitschaftsdienst innerhalb von zwei Minuten alarmieren",
      ],
      [
        "Zentrale Protokollierung",
        "alle Protokolle der Dienste zentral sammeln und 13 Monate vorhalten",
      ],
      [
        "Korrelations-ID",
        "jede Anfrage mit einer Korrelations-ID über alle beteiligten Dienste verfolgen",
      ],
      ["Dashboards", "für Betrieb und Fachbereich getrennte Dashboards bereitstellen"],
      [
        "Störungsmanagement",
        "Störungen nach den Prioritäten 1 bis 4 mit definierten Reaktionszeiten behandeln",
      ],
      [
        "Post-Mortem",
        "für jede Störung der Priorität 1 innerhalb von fünf Werktagen eine Nachbetrachtung erstellen",
      ],
    ],
  },
  {
    path: [
      "4 Nichtfunktionale Anforderungen",
      "4.3 Sicherheit",
      "4.3.1 Zugriff und Verschlüsselung",
      "4.3.1.1 Transport- und Datenverschlüsselung",
    ],
    prefix: "NFA-SEC",
    subject: "Das System",
    style: "heading",
    priorityKey: "Priorität",
    features: [
      [
        "Transportverschlüsselung",
        "alle externen Verbindungen ausschließlich mit TLS 1.2 oder höher absichern",
      ],
      ["Perfect Forward Secrecy", "nur Cipher-Suites mit Perfect Forward Secrecy zulassen"],
      [
        "Verschlüsselung gespeicherter Daten",
        "personenbezogene Daten im Ruhezustand mit AES-256 verschlüsseln",
      ],
      [
        "Schlüsselverwaltung",
        "kryptographische Schlüssel in einem zertifizierten Hardware-Sicherheitsmodul erzeugen und speichern",
      ],
      [
        "Schlüsselrotation",
        "Schlüssel mindestens jährlich und bei Verdacht auf Kompromittierung sofort wechseln",
      ],
      [
        "Hashing von Passwörtern",
        "Passwörter nur mit einem adaptiven Hashverfahren und individuellem Salt speichern",
      ],
      [
        "Zertifikatsverwaltung",
        "Zertifikate vor Ablauf automatisch erneuern und den Ablauf 30 Tage vorher überwachen",
      ],
      [
        "Sichere HTTP-Header",
        "alle Antworten mit Sicherheits-Headern wie HSTS und Content-Security-Policy ausliefern",
      ],
    ],
  },
  {
    path: [
      "4 Nichtfunktionale Anforderungen",
      "4.3 Sicherheit",
      "4.3.1 Zugriff und Verschlüsselung",
      "4.3.1.2 Rollen und Berechtigungen",
    ],
    prefix: "NFA-SEC",
    subject: "Das System",
    style: "plain",
    priorityKey: "Priorität",
    features: [
      [
        "Rollenbasierte Zugriffssteuerung",
        "den Zugriff auf Funktionen und Daten ausschließlich über Rollen steuern",
      ],
      [
        "Prinzip der minimalen Rechte",
        "jedem Benutzer und Dienst nur die für die Aufgabe notwendigen Rechte erteilen",
      ],
      [
        "Funktionstrennung",
        "kritische Rollen wie Erfassung und Freigabe nie derselben Person zuweisen",
      ],
      [
        "Rezertifizierung",
        "die Berechtigungen aller Mitarbeiter halbjährlich durch die Vorgesetzten bestätigen lassen",
      ],
      [
        "Privilegierte Zugriffe",
        "administrative Zugriffe nur über eine Sitzungsaufzeichnung mit Vier-Augen-Prinzip gewähren",
      ],
      [
        "Entzug bei Austritt",
        "Berechtigungen ausscheidender Mitarbeiter am letzten Arbeitstag entziehen",
      ],
      ["Dienstkonten", "technische Dienstkonten mit Besitzer, Zweck und Ablaufdatum führen"],
      [
        "Mandantentrennung",
        "Daten verschiedener Mandanten logisch trennen und Zugriffe über Mandantengrenzen verhindern",
      ],
    ],
  },
  {
    path: [
      "4 Nichtfunktionale Anforderungen",
      "4.3 Sicherheit",
      "4.3.2 Schutz vor Angriffen",
      "4.3.2.1 Anwendungssicherheit",
    ],
    prefix: "NFA-SEC",
    subject: "Das System",
    style: "heading",
    priorityKey: "Priorität",
    features: [
      [
        "Schutz vor Injection",
        "alle Eingaben serverseitig validieren und Datenbankzugriffe ausschließlich parametrisiert ausführen",
      ],
      [
        "Schutz vor Cross-Site-Scripting",
        "Ausgaben kontextabhängig kodieren und eingebettete Skripte durch eine Content-Security-Policy unterbinden",
      ],
      [
        "Schutz vor CSRF",
        "zustandsändernde Anfragen durch ein Token gegen Cross-Site-Request-Forgery absichern",
      ],
      ["Ratenbegrenzung", "wiederholte Anmeldeversuche je Konto und Quelladresse begrenzen"],
      [
        "Web Application Firewall",
        "alle öffentlichen Endpunkte hinter einer Web Application Firewall betreiben",
      ],
      [
        "Schutz vor Bots",
        "automatisierte Zugriffe erkennen und mit angemessenen Mitteln abwehren, ohne Barrierefreiheit einzuschränken",
      ],
      ["Abwehr von DDoS", "volumetrische Angriffe durch einen vorgelagerten Schutzdienst abwehren"],
      [
        "Schwachstellenmanagement",
        "kritische Schwachstellen in Komponenten innerhalb von sieben Tagen beheben",
      ],
      [
        "Penetrationstest",
        "vor jeder Hauptversion einen Penetrationstest durch eine unabhängige Stelle durchführen lassen",
      ],
    ],
  },
  {
    path: [
      "4 Nichtfunktionale Anforderungen",
      "4.3 Sicherheit",
      "4.3.2 Schutz vor Angriffen",
      "4.3.2.2 Protokollierung und Nachvollziehbarkeit",
    ],
    prefix: "NFA-SEC",
    subject: "Das System",
    style: "plain",
    priorityKey: "Priorität",
    features: [
      [
        "Sicherheitsrelevante Ereignisse",
        "Anmeldungen, Berechtigungsänderungen und Zahlungsfreigaben revisionssicher protokollieren",
      ],
      ["Schutz der Protokolle", "Protokolle gegen nachträgliche Änderung und Löschung schützen"],
      [
        "Keine Geheimnisse im Protokoll",
        "Passwörter, Einmalcodes und vollständige Kartennummern niemals in Protokolle schreiben",
      ],
      [
        "Zeitsynchronisation",
        "alle Systeme auf eine gemeinsame, abgesicherte Zeitquelle synchronisieren",
      ],
      [
        "Auswertung durch das SIEM",
        "sicherheitsrelevante Ereignisse in Echtzeit an das zentrale SIEM übertragen",
      ],
      ["Aufbewahrungsdauer", "Sicherheitsprotokolle mindestens 24 Monate vorhalten"],
      [
        "Manipulationsnachweis",
        "die Integrität der Protokolle durch kryptographische Verkettung nachweisbar machen",
      ],
    ],
  },
  {
    path: [
      "4 Nichtfunktionale Anforderungen",
      "4.4 Datenschutz und Compliance",
      "4.4.1 Datenschutz",
      "4.4.1.1 Datenschutz durch Technikgestaltung",
    ],
    prefix: "NFA-DSG",
    subject: "Das System",
    style: "heading",
    priorityKey: "Priorität",
    features: [
      [
        "Datenminimierung",
        "nur diejenigen personenbezogenen Daten erheben, die für den jeweiligen Zweck erforderlich sind",
      ],
      [
        "Löschkonzept",
        "für jede Datenart eine Aufbewahrungsfrist hinterlegen und Daten nach Fristende automatisch löschen",
      ],
      [
        "Pseudonymisierung in Testumgebungen",
        "in Test- und Entwicklungsumgebungen ausschließlich pseudonymisierte oder synthetische Daten verwenden",
      ],
      [
        "Verzeichnis der Verarbeitungstätigkeiten",
        "zu jeder Verarbeitung Zweck, Rechtsgrundlage und Empfänger im Verzeichnis dokumentieren",
      ],
      [
        "Auftragsverarbeitung",
        "Auftragsverarbeiter nur mit abgeschlossener Vereinbarung nach Artikel 28 DSGVO einsetzen",
      ],
      [
        "Datenverarbeitung in der EU",
        "personenbezogene Daten ausschließlich in Rechenzentren innerhalb der Europäischen Union verarbeiten",
      ],
      [
        "Meldung von Datenschutzverletzungen",
        "Datenschutzverletzungen innerhalb von 72 Stunden an die Aufsichtsbehörde melden können",
      ],
      [
        "Datenschutz-Folgenabschätzung",
        "vor Einführung neuer Verarbeitungen mit hohem Risiko eine Folgenabschätzung durchführen",
      ],
    ],
  },
  {
    path: [
      "4 Nichtfunktionale Anforderungen",
      "4.4 Datenschutz und Compliance",
      "4.4.2 Regulatorik",
      "4.4.2.1 Aufsichtsrechtliche Vorgaben",
    ],
    prefix: "NFA-REG",
    subject: "Das System",
    style: "table",
    features: [
      [
        "Geldwäscheprävention",
        "Transaktionen nach den Vorgaben des Geldwäschegesetzes überwachen und Verdachtsfälle melden",
      ],
      [
        "Kundenidentifizierung",
        "Kunden vor Aufnahme der Geschäftsbeziehung nach dem Geldwäschegesetz identifizieren",
      ],
      [
        "Einhaltung von DORA",
        "die Anforderungen der Verordnung über die digitale operationale Resilienz für IKT-Risiken umsetzen",
      ],
      [
        "BAIT und MaRisk",
        "die bankaufsichtlichen Anforderungen an die IT in Dokumentation und Betrieb nachweisen",
      ],
      [
        "Auslagerungssteuerung",
        "wesentliche Auslagerungen mit Prüf- und Kündigungsrechten vertraglich absichern",
      ],
      [
        "Meldung schwerwiegender Vorfälle",
        "schwerwiegende IKT-Vorfälle fristgerecht an die Aufsicht melden",
      ],
      ["Aufbewahrung nach HGB und AO", "buchungsrelevante Unterlagen für zehn Jahre aufbewahren"],
      [
        "Transparenz nach Preisangabenverordnung",
        "Entgelte vor Auftragserteilung vollständig ausweisen",
      ],
    ],
  },
  {
    path: [
      "4 Nichtfunktionale Anforderungen",
      "4.5 Bedienbarkeit und Barrierefreiheit",
      "4.5.1 Barrierefreiheit",
      "4.5.1.1 Zugänglichkeit",
    ],
    prefix: "NFA-UX",
    subject: "Das Kundenportal",
    style: "heading",
    priorityKey: "Priorität",
    features: [
      ["WCAG-Konformität", "die Erfolgskriterien der WCAG 2.1 Stufe AA erfüllen"],
      ["Bedienung per Tastatur", "alle Funktionen ohne Maus bedienbar machen"],
      [
        "Screenreader-Unterstützung",
        "alle Bedienelemente mit sinnvollen Beschriftungen für Screenreader versehen",
      ],
      ["Kontraste", "ein Kontrastverhältnis von mindestens 4,5 zu 1 für Text einhalten"],
      [
        "Skalierbare Schrift",
        "bei einer Vergrößerung der Schrift auf 200 Prozent ohne Verlust von Inhalten und Funktionen bedienbar bleiben",
      ],
      ["Einfache Sprache", "wesentliche Informationen zusätzlich in einfacher Sprache anbieten"],
      [
        "Fehlermeldungen",
        "Fehler nicht allein durch Farbe, sondern auch durch Text und Symbol kennzeichnen",
      ],
      ["Zeitlimits", "bei Zeitlimits die Verlängerung ohne Datenverlust ermöglichen"],
    ],
  },
  {
    path: [
      "4 Nichtfunktionale Anforderungen",
      "4.5 Bedienbarkeit und Barrierefreiheit",
      "4.5.2 Benutzerführung",
      "4.5.2.1 Oberfläche und Sprache",
    ],
    prefix: "NFA-UX",
    subject: "Das Kundenportal",
    style: "plain",
    priorityKey: "Priorität",
    features: [
      [
        "Responsives Layout",
        "auf Bildschirmbreiten von 320 bis 2560 Pixeln ohne horizontales Scrollen nutzbar sein",
      ],
      ["Mehrsprachigkeit", "die Oberfläche in Deutsch, Englisch und Türkisch anbieten"],
      [
        "Formatierung von Beträgen und Daten",
        "Beträge und Datumsangaben nach der Spracheinstellung des Kunden formatieren",
      ],
      [
        "Konsistente Begriffe",
        "für gleiche Sachverhalte durchgängig dieselben Begriffe aus dem Glossar verwenden",
      ],
      ["Hilfe im Kontext", "an komplexen Eingaben eine kurze Erläuterung anbieten"],
      ["Dunkler Modus", "einen dunklen Darstellungsmodus anbieten"],
      [
        "Zuletzt verwendete Funktionen",
        "die vom Kunden zuletzt genutzten Funktionen auf der Startseite verlinken",
      ],
      [
        "Rückmeldung bei Aktionen",
        "jede Aktion innerhalb von 200 Millisekunden sichtbar bestätigen",
      ],
    ],
  },
  // ── 5 Schnittstellen ────────────────────────────────────────────────────────────────────────
  {
    path: [
      "5 Schnittstellen",
      "5.1 Innere Systeme",
      "5.1.1 Kernbanksystem",
      "5.1.1.1 Kontodaten und Buchungen",
    ],
    prefix: "SCH-IF",
    subject: "Die Schnittstelle zum Kernbanksystem",
    style: "heading",
    priorityKey: "Priority",
    priorityValues: ["Must", "Should", "Could"],
    features: [
      [
        "Abfrage von Kontosalden",
        "Kontosalden synchron über eine REST-Schnittstelle in höchstens 300 Millisekunden liefern",
      ],
      [
        "Abruf von Umsätzen",
        "Umsätze seitenweise mit Cursor und stabiler Sortierung bereitstellen",
      ],
      [
        "Buchung von Zahlungsaufträgen",
        "Zahlungsaufträge idempotent anhand einer Auftrags-ID entgegennehmen",
      ],
      [
        "Fehlercodes",
        "Fehler mit einem fachlichen Fehlercode und einer Korrelations-ID beantworten",
      ],
      [
        "Versionierung",
        "Änderungen an der Schnittstelle abwärtskompatibel über eine Versionsnummer im Pfad einführen",
      ],
      [
        "Authentifizierung zwischen Diensten",
        "Aufrufe über gegenseitig authentifiziertes TLS absichern",
      ],
      [
        "Zeitüberschreitung",
        "Aufrufe nach spätestens drei Sekunden mit einem definierten Fehler abbrechen",
      ],
      [
        "Wiederholbarkeit",
        "bei vorübergehenden Fehlern Wiederholungen mit exponentiellem Backoff erlauben",
      ],
    ],
  },
  {
    path: [
      "5 Schnittstellen",
      "5.1 Innere Systeme",
      "5.1.2 Dokumenten- und Archivsystem",
      "5.1.2.1 Dokumentenablage",
    ],
    prefix: "SCH-IF",
    subject: "Die Schnittstelle zum Archivsystem",
    style: "plain",
    priorityKey: "Priority",
    features: [
      [
        "Ablage von Dokumenten",
        "Dokumente mit Metadaten zu Kunde, Dokumentart und Aufbewahrungsfrist entgegennehmen",
      ],
      [
        "Abruf von Dokumenten",
        "Dokumente anhand der Dokumenten-ID in höchstens einer Sekunde ausliefern",
      ],
      ["Revisionssichere Ablage", "abgelegte Dokumente unveränderbar speichern"],
      [
        "Löschung nach Fristablauf",
        "Dokumente nach Ablauf der Aufbewahrungsfrist auf Anforderung löschen und die Löschung bestätigen",
      ],
      ["Volltextindex", "eine Suche über Metadaten der Dokumente anbieten"],
      ["Massenablage", "die Ablage von bis zu 5.000 Dokumenten pro Stunde unterstützen"],
      ["Prüfsumme", "für jedes Dokument eine Prüfsumme mit SHA-256 ablegen und beim Abruf prüfen"],
    ],
  },
  {
    path: [
      "5 Schnittstellen",
      "5.2 Äußere Systeme",
      "5.2.1 Zahlungsverkehrsnetze",
      "5.2.1.1 SEPA und Zahlungsdienstleister",
    ],
    prefix: "SCH-IF",
    subject: "Die Schnittstelle zum Zahlungsverkehrsnetz",
    style: "table",
    features: [
      [
        "Anbindung an das SEPA-Clearing",
        "Zahlungen im Format pain.001 und pacs.008 über das Clearing einreichen und empfangen",
      ],
      ["Anbindung an TIPS", "Echtzeitüberweisungen über den Zahlungsverkehrsdienst TIPS abwickeln"],
      ["Empfang von Rückläufern", "Rückläufer im Format pacs.004 automatisch verarbeiten"],
      ["Statusmeldungen", "Statusmeldungen im Format pacs.002 dem Auftrag zuordnen"],
      [
        "Kontoauszüge im Format CAMT",
        "Kontoinformationen im Format camt.052, camt.053 und camt.054 bereitstellen",
      ],
      ["Prüfung der Nachrichtensignatur", "eingehende Nachrichten auf gültige Signatur prüfen"],
      [
        "Notfallverfahren",
        "bei Ausfall des primären Anschlusses auf den Ersatzanschluss umschalten",
      ],
    ],
  },
  {
    path: [
      "5 Schnittstellen",
      "5.2 Äußere Systeme",
      "5.2.2 Drittanbieter und Open Banking",
      "5.2.2.1 PSD2-Schnittstelle",
    ],
    prefix: "SCH-IF",
    subject: "Die PSD2-Schnittstelle",
    style: "heading",
    priorityKey: "Priority",
    features: [
      [
        "Kontoinformationsdienst",
        "registrierten Drittanbietern mit Einwilligung des Kunden Kontoinformationen bereitstellen",
      ],
      [
        "Zahlungsauslösedienst",
        "von Drittanbietern ausgelöste Zahlungen nach starker Kundenauthentifizierung ausführen",
      ],
      [
        "Prüfung des Zertifikats",
        "Drittanbieter anhand eines qualifizierten Zertifikats nach eIDAS identifizieren",
      ],
      [
        "Einwilligungsverwaltung",
        "erteilte Einwilligungen für Drittanbieter mit Gültigkeit von 180 Tagen führen",
      ],
      [
        "Verfügbarkeit der Schnittstelle",
        "für die Schnittstelle dieselbe Verfügbarkeit wie für das Portal sicherstellen",
      ],
      ["Testumgebung für Drittanbieter", "eine Sandbox mit Beispieldaten bereitstellen"],
      [
        "Statistik zur Nutzung",
        "Verfügbarkeit und Antwortzeiten der Schnittstelle quartalsweise für die Aufsicht auswerten",
      ],
      [
        "Notfallmechanismus",
        "bei Ausfall der Schnittstelle einen Ersatzzugang für Drittanbieter bereitstellen",
      ],
    ],
  },
  {
    path: [
      "5 Schnittstellen",
      "5.2 Äußere Systeme",
      "5.2.3 Weitere Dienste",
      "5.2.3.1 Auskunftei, Identitätsprüfung und Versicherungspartner",
    ],
    prefix: "SCH-IF",
    subject: "Die Anbindung",
    style: "plain",
    priorityKey: "Priority",
    features: [
      [
        "Bonitätsauskunft",
        "Auskünfte der Auskunftei verschlüsselt abrufen und mit dem Antrag verknüpfen",
      ],
      [
        "Video-Identifikation",
        "eine zertifizierte Video-Identifikation in den Registrierungsprozess einbinden",
      ],
      [
        "Postdienst für Aktivierungsbriefe",
        "Briefe über einen Druck- und Versanddienstleister verschicken",
      ],
      ["SMS-Gateway", "Einmalcodes über zwei redundante SMS-Anbieter versenden"],
      [
        "Anbindung der Versicherungspartner",
        "Schadenmeldungen über eine gesicherte Schnittstelle an den Versicherer übermitteln",
      ],
      ["Sanktionslisten-Dienst", "die aktuellen Sanktionslisten täglich automatisch aktualisieren"],
      ["Anbindung des Gutachterportals", "Gutachtertermine mit dem Gutachterportal abgleichen"],
      ["Adressprüfung", "Postanschriften über einen Verzeichnisdienst validieren und vorschlagen"],
    ],
  },
  // ── 6 Betrieb, Migration und Abnahme ────────────────────────────────────────────────────────
  {
    path: [
      "6 Betrieb, Migration und Abnahme",
      "6.1 Migration",
      "6.1.1 Datenmigration",
      "6.1.1.1 Übernahme von Altdaten",
    ],
    prefix: "MIG_DAT",
    subject: "Die Migration",
    style: "heading",
    priorityKey: "Priorität",
    features: [
      [
        "Übernahme der Kundenstammdaten",
        "die Stammdaten aller aktiven Kunden verlustfrei aus dem Altsystem übernehmen",
      ],
      [
        "Übernahme der Umsatzhistorie",
        "die Umsätze der letzten 36 Monate bei der Migration mitnehmen",
      ],
      [
        "Übernahme von Daueraufträgen",
        "alle Daueraufträge und Vorlagen mit ihren Terminen übertragen",
      ],
      [
        "Abgleich nach der Migration",
        "nach jedem Lauf die Summen und Anzahlen je Datenart gegen das Altsystem abstimmen",
      ],
      [
        "Wiederholbarkeit des Migrationslaufs",
        "den Migrationslauf beliebig oft wiederholbar ausführen",
      ],
      [
        "Fehlerbehandlung der Migration",
        "nicht migrierbare Datensätze in einer Fehlerliste mit Grund ausweisen",
      ],
      ["Rückfallplan", "im Fehlerfall innerhalb von vier Stunden zum Altsystem zurückkehren"],
      [
        "Migration von Zustimmungen",
        "bestehende Einwilligungen mit Nachweis in das neue System übernehmen",
      ],
    ],
  },
  {
    path: [
      "6 Betrieb, Migration und Abnahme",
      "6.1 Migration",
      "6.1.2 Einführung",
      "6.1.2.1 Stufenweiser Umstieg",
    ],
    prefix: "MIG_ROL",
    subject: "Die Einführung",
    style: "plain",
    priorityKey: "Priorität",
    features: [
      ["Pilotkunden", "in einer ersten Stufe mit höchstens 2.000 Pilotkunden starten"],
      [
        "Staffelung der Kunden",
        "die weiteren Kunden in vier Wellen mit je einer Woche Abstand umstellen",
      ],
      ["Parallelbetrieb", "während der Einführung beide Portale mit einheitlichen Daten betreiben"],
      [
        "Kommunikation an Kunden",
        "Kunden vier Wochen vor ihrer Umstellung schriftlich und im Portal informieren",
      ],
      [
        "Schulung der Kundenbetreuung",
        "alle Mitarbeiter der Kundenbetreuung vor Start ihrer Welle schulen",
      ],
      ["Abschaltung des Altsystems", "das Altsystem erst nach 90 Tagen ohne Nutzung abschalten"],
      [
        "Hypercare",
        "nach jeder Welle eine erhöhte Betriebsbereitschaft für vierzehn Tage vorsehen",
      ],
    ],
  },
  {
    path: [
      "6 Betrieb, Migration und Abnahme",
      "6.2 Abnahme",
      "6.2.1 Abnahmekriterien",
      "6.2.1.1 Abnahme der Lieferung",
    ],
    prefix: "ABN",
    dotted: true,
    subject: "Der Auftragnehmer",
    style: "heading",
    priorityKey: "Priorität",
    features: [
      ["Funktionsumfang", "den im Lastenheft beschriebenen Funktionsumfang vollständig liefern"],
      [
        "Testabdeckung",
        "für jede Muss-Anforderung mindestens einen automatisierten Abnahmetest liefern",
      ],
      ["Fehlerfreiheit", "zur Abnahme keine offenen Fehler der Kategorien 1 und 2 aufweisen"],
      [
        "Dokumentation",
        "Betriebs-, Benutzer- und Schnittstellendokumentation in deutscher Sprache liefern",
      ],
      [
        "Übergabe des Quelltextes",
        "den vollständigen Quelltext einschließlich Build-Skripten übergeben",
      ],
      ["Nachweis der Lasttests", "die Ergebnisse der Lasttests nach NFA-PERF vorlegen"],
      ["Schulungsunterlagen", "Schulungsunterlagen für Kunden und Mitarbeiter bereitstellen"],
      ["Gewährleistung", "für die Dauer von 24 Monaten ab Abnahme Fehler kostenfrei beheben"],
    ],
  },
  {
    path: [
      "6 Betrieb, Migration und Abnahme",
      "6.2 Abnahme",
      "6.2.2 Support und Betrieb",
      "6.2.2.1 Service-Level",
    ],
    prefix: "BET-SLA",
    subject: "Der Betreiber",
    style: "heading",
    priorityKey: "Priorität",
    features: [
      ["Servicezeiten", "den Support montags bis freitags von 07:00 bis 20:00 Uhr bereitstellen"],
      [
        "Reaktionszeit bei Störungen der Priorität 1",
        "bei Störungen der Priorität 1 innerhalb von 15 Minuten reagieren",
      ],
      [
        "Wiederherstellungszeit bei Priorität 1",
        "Störungen der Priorität 1 innerhalb von vier Stunden beheben",
      ],
      [
        "Reaktionszeit bei Priorität 2",
        "bei Störungen der Priorität 2 innerhalb von zwei Stunden reagieren",
      ],
      [
        "Berichtswesen",
        "monatlich einen Bericht über Verfügbarkeit, Störungen und Antwortzeiten liefern",
      ],
      [
        "Vertragsstrafe",
        "bei Unterschreitung der Verfügbarkeit eine Gutschrift nach Vertrag gewähren",
      ],
      [
        "Wartung und Aktualisierung",
        "sicherheitsrelevante Aktualisierungen innerhalb von 14 Tagen einspielen",
      ],
    ],
  },
];
