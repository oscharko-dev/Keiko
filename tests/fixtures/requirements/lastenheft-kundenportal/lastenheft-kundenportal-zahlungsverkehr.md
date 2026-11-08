# Lastenheft Kundenportal und Zahlungsverkehr

| Eigenschaft | Wert |
| --- | --- |
| Dokumentkennung | LH-KPZ-2026 |
| Version | 1.4 |
| Stand | 07.11.2026 |
| Auftraggeber | Fachbereich Digitale Kanäle |
| Klassifizierung | Intern |

## 1 Einleitung und Zielsetzung

Dieses Dokument beschreibt die fachlichen und technischen Anforderungen der Bank an ein neues Kundenportal mit integriertem Zahlungsverkehr.

### 1.1 Ausgangslage

#### 1.1.1 Fachlicher Hintergrund

##### 1.1.1.1 Ist-Situation

Kunden erledigen Zahlungen heute in zwei getrennten Anwendungen. Das Portal wird von rund 1,2 Millionen Privat- und 85.000 Firmenkunden genutzt. Schadenmeldungen werden bislang telefonisch aufgenommen und manuell erfasst.

ZVS-2000 wird bis Ende 2027 durch die neue Plattform abgelöst.

Das Vorhaben wird im Jira-Projekt KRED geführt; der übergeordnete Epic trägt die Kennung KRED-29.

##### 1.1.1.2 Zielbild

Die neue Plattform bündelt Konten, Zahlungen, Karten, Kredite und Versicherungen in einem Kanal. Die Zahlungsfunktionen (REQ-FA-066 bis REQ-FA-075) bilden den Kern, die Anforderungen an Sicherheit (NFA-SEC-001 und folgende) gelten für alle Funktionen.

### 1.2 Zweck und Geltungsbereich

#### 1.2.1 Zweck des Dokuments

##### 1.2.1.1 Aufbau der Anforderungen

Jede Anforderung trägt eine eindeutige Kennung, etwa REQ-FA-001, einen Titel, eine Priorität und gegebenenfalls Abnahmekriterien. Die Kennungen sind über die Lebensdauer des Dokuments stabil.

| Präfix | Bereich |
| --- | --- |
| REQ-FA | Funktionale Anforderungen |
| NFA-PERF, NFA-AVL, NFA-OPS | Leistung, Verfügbarkeit und Betrieb |
| NFA-SEC, NFA-DSG, NFA-REG | Sicherheit, Datenschutz und Regulatorik |
| NFA-UX | Bedienbarkeit und Barrierefreiheit |
| SCH-IF | Schnittstellen |
| MIG_DAT, MIG_ROL, ABN, BET-SLA | Migration, Abnahme und Betrieb |

##### 1.2.1.2 Prioritäten

Die Priorität einer Anforderung ist Muss, Soll oder Kann. In der Schnittstellenspezifikation werden die englischen Begriffe Must, Should und Could verwendet.

### 1.3 Begriffe und Referenzen

#### 1.3.1 Glossar

##### 1.3.1.1 Fachbegriffe

| Begriff | Bedeutung |
| --- | --- |
| SEPA | Single Euro Payments Area, der einheitliche Euro-Zahlungsverkehrsraum |
| IBAN | International Bank Account Number, die internationale Kontonummer |
| PSD2 | Zweite Zahlungsdiensterichtlinie der Europäischen Union |
| SCA | Starke Kundenauthentifizierung mit mindestens zwei unabhängigen Faktoren |
| TIPS | TARGET Instant Payment Settlement, der europäische Abwicklungsdienst für Echtzeitzahlungen |
| Kernbanksystem | Führendes System für Konten, Buchungen und Salden der Bank |
| Bevollmächtigter | Person, die im Namen eines Kunden über Konten verfügen darf |
| Mandant | Organisationseinheit mit eigenem Datenbestand und eigenen Rollen |
| Prüfprotokoll | Revisionssichere Aufzeichnung fachlicher und sicherheitsrelevanter Ereignisse |
| Wertstellung | Datum, ab dem eine Buchung für die Zinsberechnung gilt |
| Echtzeitüberweisung | Überweisung, die innerhalb von zehn Sekunden gutgeschrieben wird |
| Auftraggeber | Kunde, der einen Zahlungsauftrag erteilt |

#### 1.3.2 Normen und Referenzen

##### 1.3.2.1 Normative Referenzen

- ISO/IEC 27001:2022 Informationssicherheits-Managementsysteme
- ISO-20022 Nachrichtenstandard für den Zahlungsverkehr
- DIN EN ISO 9241-210 Prozess zur Gestaltung gebrauchstauglicher interaktiver Systeme
- PCI-DSS-4.0 Datensicherheitsstandard der Zahlungskartenbranche
- RFC 7519 JSON Web Token
- TLS-1.3 nach RFC 8446
- SHA-256 nach FIPS 180-4
- WCAG 2.1 Web Content Accessibility Guidelines

### 1.4 Rahmenbedingungen

#### 1.4.1 Organisation und Projekt

##### 1.4.1.1 Beteiligte

| Rolle | Name | Verantwortung |
| --- | --- | --- |
| Product Owner | Fachbereich Digitale Kanäle | Priorisierung und fachliche Abnahme |
| Architektur | IT-Architektur | Technische Konzeption |
| Datenschutz | Datenschutzbeauftragter | Datenschutzrechtliche Bewertung |
| Betrieb | IT-Betrieb | Betrieb und Überwachung |

##### 1.4.1.2 Zeitplan

Der Pilotbetrieb beginnt im ersten Quartal 2027, die Umstellung aller Kunden ist bis zum dritten Quartal 2027 vorgesehen.

### 1.5 Überblick der wichtigsten Anforderungen

#### 1.5.1 Kernfunktionen

##### 1.5.1.1 Anforderungen mit höchster Priorität im Überblick

Die folgende Übersicht nennt die Kernanforderungen vorab. Ihre ausführliche Beschreibung steht in den Kapiteln 3 bis 6.

| ID | Titel | Priorität |
| --- | --- | --- |
| REQ-FA-003 | E-Mail-Bestätigung | Muss |
| REQ-FA-021 | Sitzungsübersicht | Muss |
| REQ-FA-041 | Zustellnachweis | Muss |
| REQ-FA-062 | Statusanzeige der Prüfung | Muss |
| REQ-FA-083 | Betrugsprüfung in Echtzeit | Muss |
| REQ-FA-096 | Sperre für Lastschriften | Muss |
| REQ-FA-112 | Meldepflichten nach AWV | Muss |
| REQ-FA-124 | Vertrauenswürdige Empfänger | Muss |
| REQ-FA-136 | Eigene Kontobezeichnung | Muss |
| REQ-FA-154 | Barrierefreier Kontoauszug | Muss |
| REQ-FA-176 | Einkommensnachweis | Muss |
| REQ-FA-200 | Plausibilitätsprüfung | Muss |

## 2 Gesamtsystem

Das Kapitel ordnet das Portal in die Systemlandschaft der Bank ein.

### 2.1 Systemkontext

#### 2.1.1 Beteiligte Systeme

##### 2.1.1.1 Innere und äußere Systeme

Das Portal greift auf das Kernbanksystem, das Archivsystem und die Zahlungsverkehrsnetze zu. Externe Dienstleister liefern Auskünfte, Identitätsprüfung und Versand.

| Komponente | Beschreibung |
| --- | --- |
| Kundenportal | Web-Anwendung und mobile App für Privat- und Firmenkunden |
| Zahlungsverkehrssystem | Annahme, Prüfung und Weiterleitung von Zahlungsaufträgen |
| Versicherungsmodul | Verträge, Policen und Schadenmeldungen |
| Kernbanksystem | Führendes System für Konten und Buchungen |

#### 2.1.2 Nutzergruppen

##### 2.1.2.1 Rollen im Portal

- Privatkunden mit einem oder mehreren Konten
- Firmenkunden mit Zeichnungsberechtigten
- Bevollmächtigte und Betreuer
- Mitarbeiter der Kundenbetreuung mit eingeschränkter Sicht

## 3 Funktionale Anforderungen

### 3.1 Kundenportal

#### 3.1.1 Registrierung und Anmeldung

##### 3.1.1.1 Registrierung

###### REQ-FA-001 Selbstregistrierung für Bestandskunden

Das Kundenportal kann die Selbstregistrierung für Bestandskunden über Kundennummer und
Aktivierungscode ermöglichen. Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten
gilt ergänzend (siehe NFA-DSG-004). Fehlerhafte Eingaben werden dem Nutzer verständlich
und ohne technische Fehlercodes angezeigt.

Priorität: Kann
Quelle: Regulatorik-Katalog 2026, Abschnitt 7

Abnahmekriterien:
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 3.8.
- Ein Test mit 1000 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,1 Prozent.
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.

###### REQ-FA-002 Registrierung von Neukunden

Das Kundenportal soll die Online-Registrierung von Neukunden einschließlich Legitimationsprüfung unterstützen.

Priorität: Soll
Status: Freigegeben
Abhängigkeiten: REQ-FA-052, SCH-IF-002

Abnahmekriterien:
- Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.

###### REQ-FA-003 E-Mail-Bestätigung

Das Kundenportal muss die angegebene E-Mail-Adresse durch einen Bestätigungslink mit begrenzter Gültigkeit verifizieren. Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe SCH-IF-011).

Die Verarbeitung ist für den Kunden spätestens nach 4 Sekunden abgeschlossen.

Hinweis: Die fachliche Abstimmung mit der Rechtsabteilung ist noch ausstehend.
Priorität: Muss
Quelle: Workshop Fachbereich vom 14.03.2026

Abnahmekriterien:
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 1.5.
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.

###### REQ-FA-004 Mobilnummer & SMS-Verifikation

Das Kundenportal soll die Mobilnummer des Kunden per Einmalcode bestätigen, bevor sie
für Freigaben genutzt wird.

Abnahmekriterien:
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
- Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-800.
- Ein Test mit 200 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 1 Prozent.

Priorität: Soll

###### REQ-FA-005 Aktivierungsbrief

Das Kundenportal soll bei Bestandskunden ohne hinterlegte Kontaktdaten einen Aktivierungsbrief auf dem Postweg auslösen. Die Verarbeitung ist für den Kunden spätestens nach 8 Sekunden abgeschlossen. Die Regelung gilt in Verbindung mit REQ-FA-077.

Hinweis: Die technische Machbarkeit wurde im Architekturboard bestätigt.
Priorität: Soll

Abnahmekriterien:
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
- Ein Test mit 50 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,5 Prozent.

###### REQ-FA-006 Vergabe des Benutzernamens

Das Kundenportal soll die freie Wahl eines eindeutigen Benutzernamens mit
Verfügbarkeitsprüfung anbieten.

Priorität: Soll

###### REQ-FA-007 Passwortrichtlinie bei Registrierung

Das Kundenportal muss die Passwortrichtlinie der Bank bereits bei der Vergabe sichtbar
prüfen und erläutern. Beträge werden in Euro mit zwei Nachkommastellen geführt;
Fremdwährungen sind gesondert ausgewiesen. Für Sonderfälle wie Vollmachten oder
Gemeinschaftskonten gilt ergänzend (siehe REQ-FA-055).

Priorität: Muss

Abnahmekriterien:
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
- Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.

###### REQ-FA-008 Abbruch und Wiederaufnahme

Das Kundenportal soll einen abgebrochenen Registrierungsvorgang für 14 Tage speichern und fortsetzbar machen. Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt.

Priorität: Soll

Abnahmekriterien:
- Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
- Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.

##### 3.1.1.2 Anmeldung und Authentifizierung

###### REQ-FA-009 Anmeldung mit Benutzername und Passwort

Das Kundenportal soll die Anmeldung mit Benutzername und Passwort als Wissensfaktor bereitstellen. Die Verarbeitung ist für den Kunden spätestens nach 6 Sekunden abgeschlossen.

Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung.

Priorität: Soll

Abnahmekriterien:
1. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
2. Ein Test mit 500 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,5 Prozent.
3. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-227.

###### REQ-FA-010 Zweiter Faktor per Authenticator-App

Das Kundenportal kann als zweiten Faktor eine Authenticator-App mit zeitbasierten Einmalcodes unterstützen. Die Regelung gilt in Verbindung mit MIG_ROL-005. Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt.

Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt.

Priorität: Kann

Abnahmekriterien:
1. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
2. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
3. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
4. Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
5. Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
6. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.

###### REQ-FA-011 Zweiter Faktor per Push-Freigabe

Das Kundenportal muss eine Push-Freigabe in der Banking-App als zweiten Faktor anbieten.

Priorität: Muss
Quelle: Sicherheitskonzept, Kapitel 3

Abnahmekriterien:
1. Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
2. Die Darstellung entspricht dem freigegebenen Entwurf in Version 1.1.
3. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
4. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
5. Ein Test mit 50 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,5 Prozent.

###### REQ-FA-012 Biometrische Anmeldung

Das Kundenportal soll die biometrische Anmeldung auf mobilen Endgeräten über die
Betriebssystemfunktionen ermöglichen. Die Regelung gilt in Verbindung mit REQ-FA-188.

Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt.

Priorität: Soll
Quelle: Workshop Fachbereich vom 14.03.2026

###### REQ-FA-013 Sperre nach Fehlversuchen

Das Kundenportal muss den Zugang nach fünf aufeinanderfolgenden Fehlversuchen vorübergehend sperren.

Priorität: Muss
Quelle: Regulatorik-Katalog 2026, Abschnitt 7

Abnahmekriterien:
1. Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
2. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.

###### REQ-FA-014 Passwort zurücksetzen

Das Kundenportal muss das Zurücksetzen des Passworts über einen verifizierten Zweitkanal ermöglichen. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten. Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt.

Priorität: Muss

Abnahmekriterien:
1. Die Darstellung entspricht dem freigegebenen Entwurf in Version 4.9.
2. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
3. Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-025.
4. Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.

###### REQ-FA-015 Starke Kundenauthentifizierung

Das Kundenportal soll die starke Kundenauthentifizierung nach PSD2 für alle zahlungsrelevanten Zugriffe erzwingen.

Abnahmekriterien:
1. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-222.
2. Die Darstellung entspricht dem freigegebenen Entwurf in Version 4.4.
3. Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
4. Die Funktion „Starke Kundenauthentifizierung“ ist nach erfolgreicher Anmeldung innerhalb von 3 Sekunden erreichbar.

Priorität: Soll

###### REQ-FA-016 Anmeldung über Bank-ID

Das Kundenportal muss die Anmeldung über eine zertifizierte Bank-ID als Alternative zum
Passwort zulassen. Die Regelung gilt in Verbindung mit NFA-PERF-011.

Hinweis: Die technische Machbarkeit wurde im Architekturboard bestätigt.
Priorität: Muss
Quelle: Regulatorik-Katalog 2026, Abschnitt 7
Abhängigkeiten: REQ-FA-085, REQ-FA-135

Abnahmekriterien:
1. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
2. Die Abnahme berücksichtigt die Wechselwirkung mit NFA-AVL-004.
3. Ein Test mit 500 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,5 Prozent.

###### REQ-FA-017 Geräteverwaltung

Das Kundenportal muss dem Kunden die Liste seiner vertrauten Geräte anzeigen und das Entfernen einzelner Geräte erlauben. Die Funktion steht in der mobilen App und im Browser mit gleichem Funktionsumfang zur Verfügung.

Abnahmekriterien:
1. Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
2. Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
3. Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-068.
4. Die Darstellung entspricht dem freigegebenen Entwurf in Version 2.3.
5. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
6. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.

Priorität: Muss
Quelle: Sicherheitskonzept, Kapitel 3

##### 3.1.1.3 Sitzungsverwaltung

REQ-FA-018: Automatische Abmeldung

Das Kundenportal soll eine Sitzung nach 10 Minuten ohne Aktivität automatisch beenden. Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe REQ-FA-080).

Prio: Soll
Quelle: Sicherheitskonzept, Kapitel 3

Abnahmekriterien:
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
- Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-625.
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.

REQ-FA-019: Warnung vor Sitzungsende

Das Kundenportal muss den Kunden 60 Sekunden vor dem Sitzungsende mit der Möglichkeit zur Verlängerung warnen. Die Abgrenzung zu den Vorgaben des Kernbanksystems ist in NFA-SEC-013 beschrieben. Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe REQ-FA-021).

Abnahmekriterien:
- Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
- Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-621.

Prio: Muss
Status: Freigegeben

REQ-FA-020: Parallele Sitzungen

Das Kundenportal muss gleichzeitige Sitzungen eines Kunden auf höchstens drei Geräte begrenzen. Die Abgrenzung zu den Vorgaben des Kernbanksystems ist in REQ-FA-041 beschrieben. Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt.

Abnahmekriterien:
- Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.

Prio: Muss
Quelle: Fachkonzept Zahlungsverkehr, Kapitel 4

REQ-FA-021: Sitzungsübersicht

Das Kundenportal muss dem Kunden alle aktiven Sitzungen mit Gerät, Ort und Beginn anzeigen.

Hinweis: Für Firmenkunden gelten abweichende Rahmenwerte, die im Vertrag geregelt sind.
Prio: Muss

Abnahmekriterien:
- Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.

REQ-FA-022: Fernabmeldung

Das Kundenportal soll die Beendigung einzelner Sitzungen aus der Sitzungsübersicht ermöglichen. Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe REQ-FA-144). Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung.

Hinweis: Die fachliche Abstimmung mit der Rechtsabteilung ist noch ausstehend.
Prio: Soll
Abhängigkeiten: REQ-FA-052, SCH-IF-031

REQ-FA-023: Wiederanmeldung am Ziel

Das Kundenportal kann nach einer Wiederanmeldung zur zuletzt aufgerufenen Seite zurückführen, sofern diese keine Eingaben enthielt. Die Abgrenzung zu den Vorgaben des Kernbanksystems ist in REQ-FA-004 beschrieben. Die Regelung gilt in Verbindung mit REQ-FA-056.

Prio: Kann
Quelle: Betriebskonzept, Kapitel 5

Abnahmekriterien:
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.

REQ-FA-024: Abmeldung bei Kennwortänderung

Das Kundenportal soll bei einer Passwortänderung alle anderen Sitzungen des Kunden beenden. Die Angaben stammen aus dem Kernbanksystem und werden nicht lokal dupliziert. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten.

Prio: Soll

Abnahmekriterien:
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 2.1.
- Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-196.
- Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.

REQ-FA-025: Sichere Sitzungskennung

Das Kundenportal soll die Sitzungskennung ausschließlich in einem als „Secure“ und
„HttpOnly“ markierten Cookie führen.

Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe NFA-PERF-002).

Abnahmekriterien:
- Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.

Prio: Soll

#### 3.1.2 Profil und Einstellungen

##### 3.1.2.1 Stammdaten

###### REQ-FA-026 Anzeige der Stammdaten

Das Kundenportal muss dem Kunden seine Stammdaten einschließlich Adresse und Kontaktwegen übersichtlich anzeigen. Die Funktion steht in der mobilen App und im Browser mit gleichem Funktionsumfang zur Verfügung. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten.

Abnahmekriterien:
1. Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
2. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
3. Die Darstellung entspricht dem freigegebenen Entwurf in Version 1.5.

Priorität: Muss
Quelle: Fachkonzept Kundenportal, Kapitel 2

###### REQ-FA-027 Adressänderung

Das Kundenportal kann die Änderung der Postanschrift mit Nachweisupload und Prüfung durch die Kundenbetreuung ermöglichen. Die Verarbeitung ist für den Kunden spätestens nach 7 Sekunden abgeschlossen. Die Abgrenzung zu den Vorgaben des Kernbanksystems ist in REQ-FA-114 beschrieben.

Die Regelung gilt in Verbindung mit REQ-FA-052.

Priorität: Kann
Quelle: Workshop Fachbereich vom 14.03.2026
Status: In Abstimmung

Abnahmekriterien:
1. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
2. Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
3. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
4. Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.

###### REQ-FA-028 Änderung der E-Mail-Adresse

Das Kundenportal muss eine neue E-Mail-Adresse erst nach Bestätigung beider Adressen übernehmen.

Priorität: Muss
Quelle: Betriebskonzept, Kapitel 5
Status: In Abstimmung

Abnahmekriterien:
1. Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.

###### REQ-FA-029 Namensänderung

Das Kundenportal muss die Namensänderung nach Heirat oder Scheidung über einen Nachweisprozess abbilden.

Priorität: Muss

Abnahmekriterien:
1. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
2. Ein Test mit 50 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,1 Prozent.

###### REQ-FA-030 Steuerliche Ansässigkeit

Das Kundenportal muss die steuerliche Ansässigkeit und die Steuer-ID des Kunden erfassen und plausibilisieren.

Priorität: Muss
Quelle: Betriebskonzept, Kapitel 5
Status: Zur Prüfung
Abhängigkeiten: REQ-FA-054, REQ-FA-133

Abnahmekriterien:
1. Die Darstellung entspricht dem freigegebenen Entwurf in Version 3.6.
2. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.

###### REQ-FA-031 Zweitwohnsitz

Das Kundenportal soll einen abweichenden Zweitwohnsitz als zusätzliche Adresse mit Verwendungszweck speichern. Die Verarbeitung ist für den Kunden spätestens nach 8 Sekunden abgeschlossen. Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt.

Abnahmekriterien:
1. Die Funktion „Zweitwohnsitz“ ist nach erfolgreicher Anmeldung innerhalb von 1 Sekunden erreichbar.
2. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.

Hinweis: Die technische Machbarkeit wurde im Architekturboard bestätigt.
Priorität: Soll

###### REQ-FA-032 Änderungshistorie der Stammdaten

Das Kundenportal soll alle Änderungen der Stammdaten mit Zeitpunkt und Kanal nachvollziehbar dokumentieren. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung. Die Verarbeitung ist für den Kunden spätestens nach 3 Sekunden abgeschlossen.

Abnahmekriterien:
1. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.

Hinweis: Die fachliche Abstimmung mit der Rechtsabteilung ist noch ausstehend.
Priorität: Soll

###### REQ-FA-033 Datenabgleich mit dem Kernbanksystem

Das Kundenportal muss Stammdatenänderungen innerhalb von fünf Minuten an das
Kernbanksystem übermitteln. Jede Änderung wird mit Zeitstempel, Benutzerkennung und
Kanal im Prüfprotokoll festgehalten. Die Funktion steht in der mobilen App und im
Browser mit gleichem Funktionsumfang zur Verfügung.

Priorität: Muss

Abnahmekriterien:
1. Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
2. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.

##### 3.1.2.2 Benachrichtigungen

| ID | Titel | Anforderung | Priorität |
| --- | --- | --- | --- |
| REQ-FA-034 | Benachrichtigung bei Kontobewegung | Das Kundenportal soll den Kunden über jede Kontobewegung oberhalb eines frei wählbaren Schwellwerts benachrichtigen. Die Verarbeitung ist für den Kunden spätestens nach 9 Sekunden abgeschlossen. | Soll |
| REQ-FA-035 | Benachrichtigung über Push-Mitteilung | Das Kundenportal kann Benachrichtigungen als Push-Mitteilung an die Banking-App zustellen. Die Funktion steht in der mobilen App und im Browser mit gleichem Funktionsumfang zur Verfügung. | Kann |
| REQ-FA-036 | Benachrichtigung per E-Mail | Das Kundenportal muss Benachrichtigungen wahlweise per E-Mail ohne vertrauliche Details versenden. Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert ausgewiesen. | Muss |
| REQ-FA-037 | Benachrichtigung per SMS | Das Kundenportal soll kritische Hinweise auf Wunsch zusätzlich per SMS zustellen. Die Abgrenzung zu den Vorgaben des Kernbanksystems ist in ABN-45.1 beschrieben. | Soll |
| REQ-FA-038 | Ruhezeiten | Das Kundenportal muss für nicht dringende Benachrichtigungen Ruhezeiten des Kunden beachten. Die Verarbeitung ist für den Kunden spätestens nach 6 Sekunden abgeschlossen. | Muss |
| REQ-FA-039 | Kanalpräferenz je Ereignis | Das Kundenportal kann die Kanalwahl für jede Ereignisart getrennt speichern. Die Abgrenzung zu den Vorgaben des Kernbanksystems ist in NFA-DSG-004 beschrieben. | Kann |
| REQ-FA-040 | Sicherheitsrelevante Pflichtbenachrichtigung | Das Kundenportal muss sicherheitsrelevante Hinweise unabhängig von den Einstellungen des Kunden zustellen. Die Funktion steht in der mobilen App und im Browser mit gleichem Funktionsumfang zur Verfügung. | Muss |
| REQ-FA-041 | Zustellnachweis | Das Kundenportal muss den Zustellstatus jeder Benachrichtigung protokollieren. Die Verarbeitung ist für den Kunden spätestens nach 6 Sekunden abgeschlossen. | Muss |

##### 3.1.2.3 Einwilligungen und Datenschutzeinstellungen

###### [REQ-FA-042] Verwaltung der Einwilligungen [Kann]

Das Kundenportal kann dem Kunden die Einsicht in alle erteilten Einwilligungen mit Datum und Zweck ermöglichen. Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung.

Abnahmekriterien:
1. Die Funktion „Verwaltung der Einwilligungen“ ist nach erfolgreicher Anmeldung innerhalb von 3 Sekunden erreichbar.
2. Die Darstellung entspricht dem freigegebenen Entwurf in Version 1.1.
3. Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
4. Ein Test mit 200 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,5 Prozent.

###### [REQ-FA-043] Widerruf einer Einwilligung [Soll]

Das Kundenportal soll den Widerruf jeder Einwilligung mit Wirkung für die Zukunft in höchstens zwei Schritten erlauben. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten.

Abnahmekriterien:
1. Die Abnahme berücksichtigt die Wechselwirkung mit NFA-DSG-007.
2. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.

###### [REQ-FA-044] Einwilligung zu Werbung [Muss]

Das Kundenportal muss Einwilligungen zur werblichen Ansprache je Kanal getrennt erfassen.

Die Angaben stammen aus dem Kernbanksystem und werden nicht lokal dupliziert.

Abnahmekriterien:
1. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
2. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
3. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.

###### [REQ-FA-045] Einwilligung zur Datenweitergabe [Soll]

Das Kundenportal soll die Weitergabe von Daten an Dritte nur nach ausdrücklicher Einwilligung freischalten. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten. Die Regelung gilt in Verbindung mit NFA-DSG-005.

Abnahmekriterien:
1. Ein Test mit 1000 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,5 Prozent.
2. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
3. Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
4. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-135.
5. Die Funktion „Einwilligung zur Datenweitergabe“ ist nach erfolgreicher Anmeldung innerhalb von 4 Sekunden erreichbar.
6. Die Darstellung entspricht dem freigegebenen Entwurf in Version 4.1.

###### [REQ-FA-046] Datenauskunft [Kann]

Das Kundenportal kann dem Kunden eine Auskunft über die zu seiner Person gespeicherten
Daten als Download bereitstellen. Fehlerhafte Eingaben werden dem Nutzer verständlich
und ohne technische Fehlercodes angezeigt. Alle Texte stehen in Deutsch und Englisch zur
Verfügung und stammen aus der zentralen Textverwaltung.

Abnahmekriterien:
1. Ein Test mit 500 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,1 Prozent.
2. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
3. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-650.

###### [REQ-FA-047] Datenübertragbarkeit [Muss]

Das Kundenportal muss die Daten des Kunden in einem maschinenlesbaren Format
exportieren.

Abnahmekriterien:
1. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
2. Ein Test mit 1000 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,5 Prozent.
3. Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
4. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.

###### [REQ-FA-048] Löschantrag [Muss]

Das Kundenportal muss einen Löschantrag erfassen und an den Datenschutzbeauftragten
weiterleiten. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im
Prüfprotokoll festgehalten.

Abnahmekriterien:
1. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
2. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-130.
3. Ein Test mit 200 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,5 Prozent.

###### [REQ-FA-049] Cookie-Einstellungen [Soll]

Das Kundenportal soll nicht notwendige Cookies erst nach Zustimmung des Nutzers setzen.
Die Angaben stammen aus dem Kernbanksystem und werden nicht lokal dupliziert. Beträge
werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert
ausgewiesen.

Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert ausgewiesen.

Abnahmekriterien:
1. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-721.
2. Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
3. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
4. Die Funktion „Cookie-Einstellungen“ ist nach erfolgreicher Anmeldung innerhalb von 4 Sekunden erreichbar.

#### 3.1.3 Postfach und Dokumente

##### 3.1.3.1 Elektronisches Postfach

###### REQ-FA-050 Eingang neuer Dokumente

Das elektronische Postfach soll neue Dokumente der Bank mit Eingangsdatum und Ungelesen-Kennzeichen anzeigen. Die Angaben stammen aus dem Kernbanksystem und werden nicht lokal dupliziert.

Priorität: Soll
Status: Freigegeben

Abnahmekriterien:
- Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
- Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.

###### REQ-FA-051 Filter und Suche im Postfach

Das elektronische Postfach muss die Suche nach Absender, Betreff, Zeitraum und Dokumenttyp bereitstellen. Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt. Die Verarbeitung ist für den Kunden spätestens nach 4 Sekunden abgeschlossen.

Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe REQ-FA-103).

Hinweis: Der Fachbereich bewertet die Anforderung als wettbewerbsrelevant.
Priorität: Muss

Abnahmekriterien:
- Die Abnahme berücksichtigt die Wechselwirkung mit NFA-AVL-001.
- Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.

###### REQ-FA-052 Archivierung

Das elektronische Postfach kann Dokumente für mindestens zehn Jahre unveränderbar
vorhalten. Die Angaben stammen aus dem Kernbanksystem und werden nicht lokal dupliziert.

Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt.

Hinweis: Die technische Machbarkeit wurde im Architekturboard bestätigt.
Priorität: Kann

Abnahmekriterien:
- Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 4.0.
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.

###### REQ-FA-053 Papierversand abbestellen

Das elektronische Postfach muss den Wechsel vom Papierversand zum elektronischen Postfach je Dokumentart ermöglichen.

Hinweis: Die technische Machbarkeit wurde im Architekturboard bestätigt.
Priorität: Muss
Status: Freigegeben

Abnahmekriterien:
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
- Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-745.
- Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.

###### REQ-FA-054 Weiterleitung per E-Mail

Das elektronische Postfach soll ein Dokument auf Wunsch verschlüsselt an eine
hinterlegte Adresse weiterleiten.

Priorität: Soll
Quelle: Sicherheitskonzept, Kapitel 3

Abnahmekriterien:
- Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
- Die Funktion „Weiterleitung per E-Mail“ ist nach erfolgreicher Anmeldung innerhalb von 1 Sekunden erreichbar.
- Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.

###### REQ-FA-055 Lesebestätigung

Das elektronische Postfach soll den Zeitpunkt des ersten Öffnens eines rechtlich
relevanten Dokuments festhalten. Die Verarbeitung ist für den Kunden spätestens nach 3
Sekunden abgeschlossen.

Priorität: Soll

Abnahmekriterien:
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
- Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-312.
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
- Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
- Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 4.3.

###### REQ-FA-056 Sammeldownload

Das elektronische Postfach kann den Download mehrerer Dokumente als ZIP-Datei mit
Inhaltsverzeichnis erlauben.

Priorität: Kann
Status: In Abstimmung

Abnahmekriterien:
- Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-172.
- Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.

###### REQ-FA-057 Postfach-Benachrichtigung

Das elektronische Postfach kann bei jedem neuen Dokument eine Benachrichtigung nach den
Einstellungen des Kunden auslösen.

Abnahmekriterien:
- Ein Test mit 1000 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,5 Prozent.
- Die Funktion „Postfach-Benachrichtigung“ ist nach erfolgreicher Anmeldung innerhalb von 2 Sekunden erreichbar.
- Die Abnahme berücksichtigt die Wechselwirkung mit SCH-IF-027.
- Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
- Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.

Priorität: Kann
Status: Zur Prüfung
Abhängigkeiten: NFA-UX-002, REQ-FA-061

##### 3.1.3.2 Dokumentenablage und Upload

REQ-FA-058: Upload von Nachweisen

Das Kundenportal muss den Upload von Nachweisen im Format PDF, JPEG und PNG bis 15 MB je Datei unterstützen. Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe NFA-SEC-013).

Priorität: Muss
Quelle: Workshop Fachbereich vom 14.03.2026
Abhängigkeiten: NFA-SEC-013, REQ-FA-201

Abnahmekriterien:
1. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
2. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
3. Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
4. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.

REQ-FA-059: Virenprüfung hochgeladener Dateien

Das Kundenportal soll jede hochgeladene Datei vor der Speicherung auf Schadcode prüfen. Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt.

Priorität: Soll

Abnahmekriterien:
1. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
2. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
3. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-543.

REQ-FA-060: Zuordnung zum Vorgang

Das Kundenportal muss hochgeladene Dokumente eindeutig einem Vorgang oder Antrag zuordnen. Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung.

Priorität: Muss

Abnahmekriterien:
1. Die Darstellung entspricht dem freigegebenen Entwurf in Version 4.1.
2. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
3. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-865.

REQ-FA-061: Mobile Dokumentenaufnahme

Das Kundenportal muss die Aufnahme eines Dokuments mit der Kamera des Endgeräts einschließlich Kantenerkennung ermöglichen.

Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten.

Priorität: Muss

Abnahmekriterien:
1. Die Funktion „Mobile Dokumentenaufnahme“ ist nach erfolgreicher Anmeldung innerhalb von 2 Sekunden erreichbar.
2. Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-196.
3. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
4. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-637.
5. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.

REQ-FA-062: Statusanzeige der Prüfung

Das Kundenportal muss den Prüfstatus eines hochgeladenen Dokuments anzeigen.

Priorität: Muss
Quelle: Fachkonzept Kundenportal, Kapitel 2
Abhängigkeiten: NFA-AVL-006, NFA-SEC-025

Abnahmekriterien:
1. Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
2. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
3. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
4. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.

REQ-FA-063: Nachforderung von Unterlagen

Das Kundenportal muss fehlende Unterlagen mit Frist und Begründung beim Kunden anfordern. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten.

Priorität: Muss
Abhängigkeiten: REQ-FA-048, REQ-FA-059

Abnahmekriterien:
1. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
2. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-814.
3. Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.

REQ-FA-064: Löschen eigener Uploads

Das Kundenportal muss dem Kunden das Löschen eigener Uploads bis zur Bearbeitung durch die Bank erlauben.

Priorität: Muss
Status: In Abstimmung

Abnahmekriterien:
1. Die Darstellung entspricht dem freigegebenen Entwurf in Version 3.0.

REQ-FA-065: Vorschau von Dokumenten

Das Kundenportal muss PDF- und Bilddateien ohne vorherigen Download in einer Vorschau darstellen. Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe REQ-FA-013). Die Funktion steht in der mobilen App und im Browser mit gleichem Funktionsumfang zur Verfügung.

Die Verarbeitung ist für den Kunden spätestens nach 4 Sekunden abgeschlossen.

Priorität: Muss

### 3.2 Zahlungsverkehr

#### 3.2.1 SEPA-Zahlungen

##### 3.2.1.1 SEPA-Überweisung

###### REQ-FA-066 Erfassung einer SEPA-Überweisung

Das Zahlungsverkehrssystem soll die Erfassung einer SEPA-Überweisung mit IBAN,
Empfängername, Betrag und Verwendungszweck ermöglichen. Regel 1: Bei einem Kunden mit
Einzelverfügung wird der Vorgang mit dem Status „in Klärung“ gekennzeichnet und das
Ergebnis mit der Regelversion 1.6 im Prüfprotokoll festgehalten. Regel 2: Bei einem
Auftrag über Gemeinschaftskonten wird der Vorgang zur Sachbearbeitung geleitet und das
Ergebnis mit der Regelversion 1.4 im Prüfprotokoll festgehalten. Regel 3: Bei einer
Verfügung durch Bevollmächtigte wird der Vorgang mit dem Status „in Klärung“
gekennzeichnet und das Ergebnis mit der Regelversion 3.7 im Prüfprotokoll festgehalten.
Regel 4: Bei einem Auftrag außerhalb der Annahmezeit wird der Vorgang zur
Sachbearbeitung geleitet und das Ergebnis mit der Regelversion 5.3 im Prüfprotokoll
festgehalten. Regel 5: Bei einer abgelehnten Prüfung wird der Vorgang mit dem Status „in
Klärung“ gekennzeichnet und das Ergebnis mit der Regelversion 2.8 im Prüfprotokoll
festgehalten. Regel 6: Bei einem Auftrag mit Terminvorgabe wird der Vorgang zur
Sachbearbeitung geleitet und das Ergebnis mit der Regelversion 4.5 im Prüfprotokoll
festgehalten. Regel 7: Bei einer Wiederholung nach Zeitüberschreitung wird der Vorgang
mit dem Status „in Klärung“ gekennzeichnet und das Ergebnis mit der Regelversion 1.0 im
Prüfprotokoll festgehalten. Regel 8: Bei einem Auftrag eines Firmenkunden wird der
Vorgang zur Sachbearbeitung geleitet und das Ergebnis mit der Regelversion 1.7 im
Prüfprotokoll festgehalten. Regel 9: Bei einem Auftrag in Fremdwährung wird der Vorgang
mit dem Status „in Klärung“ gekennzeichnet und das Ergebnis mit der Regelversion 1.2 im
Prüfprotokoll festgehalten.

Priorität: Soll
Status: Zur Prüfung

Abnahmekriterien:
- Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-058.
- Ein Test mit 50 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,5 Prozent.

###### REQ-FA-067 IBAN-Prüfung

Das Zahlungsverkehrssystem soll die IBAN des Empfängers vor Auftragserteilung auf Format und Prüfziffer validieren. Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert ausgewiesen. Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt.

Hinweis: Der Fachbereich bewertet die Anforderung als wettbewerbsrelevant.
Priorität: Soll
Quelle: Sicherheitskonzept, Kapitel 3

Abnahmekriterien:
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
- Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.

###### REQ-FA-068 Empfängerüberprüfung

Das Zahlungsverkehrssystem kann vor der Freigabe einen Abgleich von IBAN und
Empfängername nach dem Verfahren „Verification of Payee“ durchführen. Die Regelung gilt
in Verbindung mit REQ-FA-040. Jede Änderung wird mit Zeitstempel, Benutzerkennung und
Kanal im Prüfprotokoll festgehalten.

Hinweis: Für Firmenkunden gelten abweichende Rahmenwerte, die im Vertrag geregelt sind.
Priorität: Kann
Quelle: Regulatorik-Katalog 2026, Abschnitt 7
Jira: KRED-252

Abnahmekriterien:
- Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
- Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.

###### REQ-FA-069 Terminüberweisung

Das Zahlungsverkehrssystem kann die Vorgabe eines Ausführungstermins bis zu 365 Tage in der Zukunft erlauben. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung.

Priorität: Kann
Status: Zur Prüfung

Abnahmekriterien:
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 3.1.

###### REQ-FA-070 Vorlagen für Überweisungen

Das Zahlungsverkehrssystem muss häufig genutzte Überweisungen als Vorlage speichern und wiederverwenden. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten. Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe REQ-FA-090).

Priorität: Muss
Quelle: Workshop Fachbereich vom 14.03.2026

Abnahmekriterien:
- Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
- Ein Test mit 200 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 1 Prozent.

###### REQ-FA-071 Empfängerverwaltung

Das Zahlungsverkehrssystem soll Zahlungsempfänger mit Bezeichnung und IBAN im Adressbuch verwalten. Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert ausgewiesen.

Die Abgrenzung zu den Vorgaben des Kernbanksystems ist in REQ-FA-082 beschrieben.

Priorität: Soll

Abnahmekriterien:
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
- Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-157.

###### REQ-FA-072 Auftragsbestätigung

Das Zahlungsverkehrssystem kann nach Erteilung eine Bestätigung mit Referenznummer und Ausführungsdatum anzeigen.

Priorität: Kann

Abnahmekriterien:
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
- Ein Test mit 200 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 1 Prozent.

###### REQ-FA-073 Stornierung vor Ausführung

Das Zahlungsverkehrssystem muss die Stornierung eines noch nicht ausgeführten Auftrags erlauben. Die Funktion steht in der mobilen App und im Browser mit gleichem Funktionsumfang zur Verfügung.

Hinweis: Die technische Machbarkeit wurde im Architekturboard bestätigt.
Priorität: Muss

Abnahmekriterien:
- Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.

###### REQ-FA-074 Prüfung der Kontodeckung

Das Zahlungsverkehrssystem muss die Verfügbarkeit von Guthaben oder Dispositionsrahmen vor Ausführung prüfen.

Priorität: Muss
Quelle: Sicherheitskonzept, Kapitel 3

Abnahmekriterien:
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
- Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.

###### REQ-FA-075 Zahlungsnachweis

Das Zahlungsverkehrssystem soll einen Zahlungsnachweis als PDF mit allen Auftragsdaten erzeugen. Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe REQ-FA-193). Die Regelung gilt in Verbindung mit BET-SLA-005.

Priorität: Soll

Abnahmekriterien:
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.

##### 3.2.1.2 Echtzeitüberweisung (SCT Inst)

###### REQ-FA-076 Echtzeitüberweisung beauftragen

Das Zahlungsverkehrssystem kann Echtzeitüberweisungen rund um die Uhr an 365 Tagen im Jahr annehmen.

Priorität: Kann

Abnahmekriterien:
1. Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
2. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
3. Die Funktion „Echtzeitüberweisung beauftragen“ ist nach erfolgreicher Anmeldung innerhalb von 2 Sekunden erreichbar.
4. Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-087.

###### REQ-FA-077 Ausführungszeit der Echtzeitüberweisung

Das Zahlungsverkehrssystem kann eine Echtzeitüberweisung innerhalb von zehn Sekunden zustellen oder ablehnen. Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt.

Abnahmekriterien:
1. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
2. Die Funktion „Ausführungszeit der Echtzeitüberweisung“ ist nach erfolgreicher Anmeldung innerhalb von 1 Sekunden erreichbar.
3. Die Darstellung entspricht dem freigegebenen Entwurf in Version 3.3.

Priorität: Kann
Quelle: Betriebskonzept, Kapitel 5

###### REQ-FA-078 Betragsgrenze für Echtzeitüberweisungen

Das Zahlungsverkehrssystem soll ein kundenindividuelles Tageslimit für
Echtzeitüberweisungen berücksichtigen. Die Angaben stammen aus dem Kernbanksystem und
werden nicht lokal dupliziert.

Priorität: Soll

Abnahmekriterien:
1. Die Abnahme berücksichtigt die Wechselwirkung mit NFA-PERF-001.
2. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
3. Die Darstellung entspricht dem freigegebenen Entwurf in Version 4.9.
4. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
5. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.

###### REQ-FA-079 Empfängerbank nicht erreichbar

Das Zahlungsverkehrssystem kann bei fehlender Erreichbarkeit der Empfängerbank den
Auftrag sofort ablehnen und den Kunden informieren.

Priorität: Kann
Abhängigkeiten: NFA-DSG-007, SCH-IF-018

Abnahmekriterien:
1. Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
2. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
3. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
4. Die Funktion „Empfängerbank nicht erreichbar“ ist nach erfolgreicher Anmeldung innerhalb von 4 Sekunden erreichbar.

###### REQ-FA-080 Rückmeldung an den Kunden

Das Zahlungsverkehrssystem soll dem Kunden das Ergebnis der Echtzeitüberweisung unmittelbar anzeigen. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung. Die Regelung gilt in Verbindung mit NFA-AVL-005.

Priorität: Soll
Quelle: Workshop Fachbereich vom 14.03.2026
Status: Freigegeben

Abnahmekriterien:
1. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-123.
2. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
3. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
4. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
5. Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-163.
6. Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.

###### REQ-FA-081 Reservierung des Betrags

Das Zahlungsverkehrssystem muss den Betrag ab Auftragserteilung bis zur Zustellung reservieren. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten. Die Verarbeitung ist für den Kunden spätestens nach 9 Sekunden abgeschlossen.

Priorität: Muss
Quelle: Regulatorik-Katalog 2026, Abschnitt 7

Abnahmekriterien:
1. Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
2. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
3. Ein Test mit 1000 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 1 Prozent.

###### REQ-FA-082 Wechsel von Standard auf Echtzeit

Das Zahlungsverkehrssystem muss dem Kunden bei geeigneten Aufträgen die Ausführung in Echtzeit vorschlagen. Die Regelung gilt in Verbindung mit NFA-DSG-003.

Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung.

Abnahmekriterien:
1. Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
2. Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
3. Ein Test mit 500 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 1 Prozent.

Hinweis: Die technische Machbarkeit wurde im Architekturboard bestätigt.
Priorität: Muss
Quelle: Betriebskonzept, Kapitel 5
Abhängigkeiten: NFA-SEC-006, REQ-FA-005

###### REQ-FA-083 Betrugsprüfung in Echtzeit

Das Zahlungsverkehrssystem muss jeden Auftrag vor der Zustellung durch die Betrugserkennung bewerten. Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt.

Priorität: Muss

Abnahmekriterien:
1. Die Abnahme berücksichtigt die Wechselwirkung mit NFA-UX-005.
2. Ein Test mit 500 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,1 Prozent.
3. Die Darstellung entspricht dem freigegebenen Entwurf in Version 1.5.

##### 3.2.1.3 Dauerauftrag

REQ-FA-084: Dauerauftrag einrichten

Das Zahlungsverkehrssystem muss die Einrichtung eines Dauerauftrags mit Intervall, Starttermin und optionalem Endtermin ermöglichen. Die Verarbeitung ist für den Kunden spätestens nach 4 Sekunden abgeschlossen.

Hinweis: Die technische Machbarkeit wurde im Architekturboard bestätigt.
Priorität: Muss
Quelle: Workshop Fachbereich vom 14.03.2026

Abnahmekriterien:
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.

REQ-FA-085: Dauerauftrag ändern

Das Zahlungsverkehrssystem kann die Änderung von Betrag und Empfänger bis einen Bankarbeitstag vor der nächsten Ausführung erlauben. Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert ausgewiesen.

Die Verarbeitung ist für den Kunden spätestens nach 6 Sekunden abgeschlossen.

Priorität: Kann

Abnahmekriterien:
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
- Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-096.
- Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.

REQ-FA-086: Dauerauftrag aussetzen

Das Zahlungsverkehrssystem muss das befristete Aussetzen eines Dauerauftrags ohne
Löschung unterstützen.

Priorität: Muss
Abhängigkeiten: REQ-FA-045, REQ-FA-168

Abnahmekriterien:
- Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-670.
- Ein Test mit 1000 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,1 Prozent.
- Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.

REQ-FA-087: Dauerauftrag löschen

Das Zahlungsverkehrssystem muss das Löschen eines Dauerauftrags mit Bestätigung durch zweiten Faktor verlangen. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten. Die Funktion steht in der mobilen App und im Browser mit gleichem Funktionsumfang zur Verfügung.

Abnahmekriterien:
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
- Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
- Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.

Priorität: Muss

REQ-FA-088: Ausführung am Monatsende

Das Zahlungsverkehrssystem muss Daueraufträge zum Monatsletzten korrekt auch in kürzeren Monaten ausführen.

Priorität: Muss
Quelle: Fachkonzept Zahlungsverkehr, Kapitel 4
Jira: KRED-49

Abnahmekriterien:
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
- Die Funktion „Ausführung am Monatsende“ ist nach erfolgreicher Anmeldung innerhalb von 1 Sekunden erreichbar.
- Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
- Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
- Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 4.1.

REQ-FA-089: Ausführung an Nichtbankarbeitstagen

Das Zahlungsverkehrssystem kann auf einen Nicht-Bankarbeitstag fallende Termine auf den folgenden Bankarbeitstag verschieben. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten.

Priorität: Kann
Jira: KRED-285

Abnahmekriterien:
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
- Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
- Ein Test mit 1000 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,1 Prozent.
- Die Funktion „Ausführung an Nichtbankarbeitstagen“ ist nach erfolgreicher Anmeldung innerhalb von 3 Sekunden erreichbar.
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
- Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.

REQ-FA-090: Übersicht der Daueraufträge

Das Zahlungsverkehrssystem muss alle Daueraufträge mit nächstem Ausführungstermin tabellarisch anzeigen.

Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert ausgewiesen.

Priorität: Muss

Abnahmekriterien:
- Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
- Die Funktion „Übersicht der Daueraufträge“ ist nach erfolgreicher Anmeldung innerhalb von 1 Sekunden erreichbar.
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.

REQ-FA-091: Mangelnde Deckung bei Dauerauftrag

Das Zahlungsverkehrssystem kann bei fehlender Deckung den Dauerauftrag nach den Vorgaben der Bank erneut versuchen und den Kunden informieren.

Priorität: Kann

Abnahmekriterien:
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
- Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
- Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.

##### 3.2.1.4 SEPA-Lastschrift

| ID | Titel | Anforderung | Priorität |
| --- | --- | --- | --- |
| REQ-FA-092 | Erteilung eines SEPA-Mandats | Das Zahlungsverkehrssystem muss SEPA-Lastschriftmandate des Kunden elektronisch erfassen und ablegen. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten. | Muss |
| REQ-FA-093 | Widerruf eines Mandats | Das Zahlungsverkehrssystem muss den Widerruf eines Mandats im Portal mit sofortiger Wirkung entgegennehmen. Die Regelung gilt in Verbindung mit NFA-UX-010. | Muss |
| REQ-FA-094 | Rückgabe einer Lastschrift | Das Zahlungsverkehrssystem muss die Rückgabe einer Lastschrift innerhalb von acht Wochen nach Belastung ermöglichen. Die Funktion steht in der mobilen App und im Browser mit gleichem Funktionsumfang zur Verfügung. | Muss |
| REQ-FA-095 | Mandatsübersicht | Das Zahlungsverkehrssystem soll alle aktiven und widerrufenen Mandate mit Gläubiger-ID anzeigen. Die Abgrenzung zu den Vorgaben des Kernbanksystems ist in NFA-PERF-005 beschrieben. | Soll |
| REQ-FA-096 | Sperre für Lastschriften | Das Zahlungsverkehrssystem muss Lastschriften generell oder für einzelne Gläubiger sperren lassen. Die Angaben stammen aus dem Kernbanksystem und werden nicht lokal dupliziert. | Muss |
| REQ-FA-097 | Vorabankündigung (Pre-Notification) | Das Zahlungsverkehrssystem kann die Pre-Notification des Gläubigers im Postfach des Kunden anzeigen. Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe BET-SLA-007). | Kann |
| REQ-FA-098 | Lastschrifteinreichung für Firmenkunden | Das Zahlungsverkehrssystem kann Firmenkunden die Einreichung von Lastschriftdateien im Format pain.008 ermöglichen. Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert ausgewiesen. | Kann |
| REQ-FA-099 | Prüfung der Gläubiger-Identifikationsnummer | Das Zahlungsverkehrssystem kann die Gläubiger-Identifikationsnummer auf Format und Prüfziffer validieren. Die Verarbeitung ist für den Kunden spätestens nach 2 Sekunden abgeschlossen. | Kann |

#### 3.2.2 Sammel- und Auslandszahlungen

##### 3.2.2.1 Sammelaufträge und Dateiimport

###### REQ-FA-100 Import von Zahlungsdateien

Das Zahlungsverkehrssystem muss den Import von Sammelaufträgen im Format pain.001 bis zu 10.000 Positionen verarbeiten. Regel 1: Bei einem Kunden mit Einzelverfügung wird der Vorgang mit dem Status „in Klärung“ gekennzeichnet und das Ergebnis mit der Regelversion 2.1 im Prüfprotokoll festgehalten. Regel 2: Bei einem Auftrag über Gemeinschaftskonten wird der Vorgang zur Sachbearbeitung geleitet und das Ergebnis mit der Regelversion 4.4 im Prüfprotokoll festgehalten. Regel 3: Bei einer Verfügung durch Bevollmächtigte wird der Vorgang mit dem Status „in Klärung“ gekennzeichnet und das Ergebnis mit der Regelversion 6.7 im Prüfprotokoll festgehalten. Regel 4: Bei einem Auftrag außerhalb der Annahmezeit wird der Vorgang zur Sachbearbeitung geleitet und das Ergebnis mit der Regelversion 2.9 im Prüfprotokoll festgehalten. Regel 5: Bei einer abgelehnten Prüfung wird der Vorgang mit dem Status „in Klärung“ gekennzeichnet und das Ergebnis mit der Regelversion 6.6 im Prüfprotokoll festgehalten. Regel 6: Bei einem Auftrag mit Terminvorgabe wird der Vorgang zur Sachbearbeitung geleitet und das Ergebnis mit der Regelversion 1.0 im Prüfprotokoll festgehalten. Regel 7: Bei einer Wiederholung nach Zeitüberschreitung wird der Vorgang mit dem Status „in Klärung“ gekennzeichnet und das Ergebnis mit der Regelversion 2.6 im Prüfprotokoll festgehalten. Regel 8: Bei einem Auftrag eines Firmenkunden wird der Vorgang zur Sachbearbeitung geleitet und das Ergebnis mit der Regelversion 2.5 im Prüfprotokoll festgehalten. Regel 9: Bei einem Auftrag in Fremdwährung wird der Vorgang mit dem Status „in Klärung“ gekennzeichnet und das Ergebnis mit der Regelversion 5.4 im Prüfprotokoll festgehalten. Regel 10: Bei einer Rückfrage der Sachbearbeitung wird der Vorgang zur Sachbearbeitung geleitet und das Ergebnis mit der Regelversion 1.5 im Prüfprotokoll festgehalten. Regel 11: Bei einem Kunden mit Einzelverfügung wird der Vorgang mit dem Status „in Klärung“ gekennzeichnet und das Ergebnis mit der Regelversion 1.5 im Prüfprotokoll festgehalten. Regel 12: Bei einem Auftrag über Gemeinschaftskonten wird der Vorgang zur Sachbearbeitung geleitet und das Ergebnis mit der Regelversion 3.9 im Prüfprotokoll festgehalten. Regel 13: Bei einer Verfügung durch Bevollmächtigte wird der Vorgang mit dem Status „in Klärung“ gekennzeichnet und das Ergebnis mit der Regelversion 4.5 im Prüfprotokoll festgehalten. Regel 14: Bei einem Auftrag außerhalb der Annahmezeit wird der Vorgang zur Sachbearbeitung geleitet und das Ergebnis mit der Regelversion 3.2 im Prüfprotokoll festgehalten. Regel 15: Bei einer abgelehnten Prüfung wird der Vorgang mit dem Status „in Klärung“ gekennzeichnet und das Ergebnis mit der Regelversion 6.3 im Prüfprotokoll festgehalten. Regel 16: Bei einem Auftrag mit Terminvorgabe wird der Vorgang zur Sachbearbeitung geleitet und das Ergebnis mit der Regelversion 5.4 im Prüfprotokoll festgehalten. Regel 17: Bei einer Wiederholung nach Zeitüberschreitung wird der Vorgang mit dem Status „in Klärung“ gekennzeichnet und das Ergebnis mit der Regelversion 2.0 im Prüfprotokoll festgehalten. Regel 18: Bei einem Auftrag eines Firmenkunden wird der Vorgang zur Sachbearbeitung geleitet und das Ergebnis mit der Regelversion 3.9 im Prüfprotokoll festgehalten. Regel 19: Bei einem Auftrag in Fremdwährung wird der Vorgang mit dem Status „in Klärung“ gekennzeichnet und das Ergebnis mit der Regelversion 3.2 im Prüfprotokoll festgehalten.

Hinweis: Die fachliche Abstimmung mit der Rechtsabteilung ist noch ausstehend.
Priorität: Muss

Abnahmekriterien:
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 2.7.
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
- Ein Test mit 200 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,5 Prozent.

###### REQ-FA-101 Fehlerbericht beim Import

Das Zahlungsverkehrssystem muss fehlerhafte Positionen einer Datei mit Zeilennummer und Grund ausweisen, ohne gültige Positionen zu blockieren.

Priorität: Muss
Quelle: Fachkonzept Kundenportal, Kapitel 2

Abnahmekriterien:
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
- Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.

###### REQ-FA-102 Sammelbelastung

Das Zahlungsverkehrssystem muss einen Sammelauftrag wahlweise als Einzel- oder Sammelbelastung buchen.

Die Angaben stammen aus dem Kernbanksystem und werden nicht lokal dupliziert.

Priorität: Muss
Status: Zur Prüfung

Abnahmekriterien:
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 2.8.
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
- Ein Test mit 500 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 1 Prozent.

###### REQ-FA-103 Vier-Augen-Prinzip für Sammelaufträge

Das Zahlungsverkehrssystem soll Sammelaufträge ab einem Gesamtbetrag von 50.000 Euro nur nach Freigabe durch einen zweiten Berechtigten ausführen. Die Regelung gilt in Verbindung mit REQ-FA-106. Die Verarbeitung ist für den Kunden spätestens nach 8 Sekunden abgeschlossen.

Abnahmekriterien:
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
- Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
- Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-017.

Priorität: Soll

###### REQ-FA-104 Teilfreigabe

Das Zahlungsverkehrssystem muss die Freigabe einzelner Positionen eines Sammelauftrags erlauben. Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe SCH-IF-014). Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt.

Die Abgrenzung zu den Vorgaben des Kernbanksystems ist in REQ-FA-189 beschrieben.

Priorität: Muss
Jira: KRED-325

###### REQ-FA-105 Duplikaterkennung

Das Zahlungsverkehrssystem muss bereits eingereichte Dateien anhand ihrer Nachrichten-ID erkennen und die erneute Einreichung abweisen.

Priorität: Muss
Quelle: Betriebskonzept, Kapitel 5

Abnahmekriterien:
- Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-310.
- Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
- Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
- Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-119.

###### REQ-FA-106 Statusverfolgung je Position

Das Zahlungsverkehrssystem muss den Status jeder Position eines Sammelauftrags einzeln
anzeigen. Die Angaben stammen aus dem Kernbanksystem und werden nicht lokal dupliziert.
Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes
angezeigt.

Priorität: Muss
Status: Freigegeben

Abnahmekriterien:
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 2.3.
- Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
- Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
- Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
- Die Funktion „Statusverfolgung je Position“ ist nach erfolgreicher Anmeldung innerhalb von 4 Sekunden erreichbar.

###### REQ-FA-107 Rückmeldedatei

Das Zahlungsverkehrssystem muss nach der Verarbeitung eine Statusdatei im Format pain.002 bereitstellen. Die Funktion steht in der mobilen App und im Browser mit gleichem Funktionsumfang zur Verfügung.

Priorität: Muss
Jira: KRED-53

Abnahmekriterien:
- Die Funktion „Rückmeldedatei“ ist nach erfolgreicher Anmeldung innerhalb von 2 Sekunden erreichbar.
- Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
- Die Abnahme berücksichtigt die Wechselwirkung mit MIG_DAT-007.
- Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.

###### REQ-FA-108 Zeitfenster für Dateieinreichung

Das Zahlungsverkehrssystem kann die Annahmeschlüsse für Dateien je Zahlungsart im Portal anzeigen. Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe REQ-FA-080).

Priorität: Kann

Abnahmekriterien:
- Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
- Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-148.
- Die Abnahme berücksichtigt die Wechselwirkung mit NFA-SEC-024.
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 4.5.
- Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.

##### 3.2.2.2 Auslandszahlungen

REQ-FA-109: Auslandsüberweisung außerhalb SEPA

Das Zahlungsverkehrssystem soll Auslandsüberweisungen in Fremdwährung mit BIC und
Empfängeradresse erfassen. Regel 1: Bei einem Kunden mit Einzelverfügung wird der
Vorgang mit dem Status „in Klärung“ gekennzeichnet und das Ergebnis mit der Regelversion
3.1 im Prüfprotokoll festgehalten. Regel 2: Bei einem Auftrag über Gemeinschaftskonten
wird der Vorgang zur Sachbearbeitung geleitet und das Ergebnis mit der Regelversion 1.6
im Prüfprotokoll festgehalten. Regel 3: Bei einer Verfügung durch Bevollmächtigte wird
der Vorgang mit dem Status „in Klärung“ gekennzeichnet und das Ergebnis mit der
Regelversion 6.4 im Prüfprotokoll festgehalten. Regel 4: Bei einem Auftrag außerhalb der
Annahmezeit wird der Vorgang zur Sachbearbeitung geleitet und das Ergebnis mit der
Regelversion 5.7 im Prüfprotokoll festgehalten. Regel 5: Bei einer abgelehnten Prüfung
wird der Vorgang mit dem Status „in Klärung“ gekennzeichnet und das Ergebnis mit der
Regelversion 6.3 im Prüfprotokoll festgehalten. Regel 6: Bei einem Auftrag mit
Terminvorgabe wird der Vorgang zur Sachbearbeitung geleitet und das Ergebnis mit der
Regelversion 3.5 im Prüfprotokoll festgehalten. Regel 7: Bei einer Wiederholung nach
Zeitüberschreitung wird der Vorgang mit dem Status „in Klärung“ gekennzeichnet und das
Ergebnis mit der Regelversion 6.9 im Prüfprotokoll festgehalten. Regel 8: Bei einem
Auftrag eines Firmenkunden wird der Vorgang zur Sachbearbeitung geleitet und das
Ergebnis mit der Regelversion 5.8 im Prüfprotokoll festgehalten. Regel 9: Bei einem
Auftrag in Fremdwährung wird der Vorgang mit dem Status „in Klärung“ gekennzeichnet und
das Ergebnis mit der Regelversion 3.5 im Prüfprotokoll festgehalten. Regel 10: Bei einer
Rückfrage der Sachbearbeitung wird der Vorgang zur Sachbearbeitung geleitet und das
Ergebnis mit der Regelversion 1.7 im Prüfprotokoll festgehalten. Regel 11: Bei einem
Kunden mit Einzelverfügung wird der Vorgang mit dem Status „in Klärung“ gekennzeichnet
und das Ergebnis mit der Regelversion 6.2 im Prüfprotokoll festgehalten. Regel 12: Bei
einem Auftrag über Gemeinschaftskonten wird der Vorgang zur Sachbearbeitung geleitet und
das Ergebnis mit der Regelversion 1.2 im Prüfprotokoll festgehalten. Regel 13: Bei einer
Verfügung durch Bevollmächtigte wird der Vorgang mit dem Status „in Klärung“
gekennzeichnet und das Ergebnis mit der Regelversion 6.3 im Prüfprotokoll festgehalten.
Regel 14: Bei einem Auftrag außerhalb der Annahmezeit wird der Vorgang zur
Sachbearbeitung geleitet und das Ergebnis mit der Regelversion 2.1 im Prüfprotokoll
festgehalten. Regel 15: Bei einer abgelehnten Prüfung wird der Vorgang mit dem Status
„in Klärung“ gekennzeichnet und das Ergebnis mit der Regelversion 5.8 im Prüfprotokoll
festgehalten.

Abnahmekriterien:
1. Die Funktion „Auslandsüberweisung außerhalb SEPA“ ist nach erfolgreicher Anmeldung innerhalb von 4 Sekunden erreichbar.
2. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
3. Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.

Priorität: Soll
Abhängigkeiten: REQ-FA-006, REQ-FA-006

REQ-FA-110: Anzeige von Wechselkurs und Entgelten

Das Zahlungsverkehrssystem soll Wechselkurs, Entgelte und Gesamtbetrag vor der Freigabe transparent ausweisen. Die Abgrenzung zu den Vorgaben des Kernbanksystems ist in REQ-FA-032 beschrieben.

Die Funktion steht in der mobilen App und im Browser mit gleichem Funktionsumfang zur Verfügung.

Priorität: Soll

Abnahmekriterien:
1. Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
2. Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
3. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.

REQ-FA-111: Kostenteilung

Das Zahlungsverkehrssystem muss die Entgeltregelung SHA, OUR und BEN auswählbar machen. Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert ausgewiesen. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten.

Priorität: Muss
Status: In Abstimmung

REQ-FA-112: Meldepflichten nach AWV

Das Zahlungsverkehrssystem muss Zahlungen über der Meldegrenze mit den erforderlichen Angaben für die Meldung an die Bundesbank versehen. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung.

Priorität: Muss

Abnahmekriterien:
1. Ein Test mit 50 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 1 Prozent.
2. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-356.
3. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.

REQ-FA-113: Währungsliste

Das Zahlungsverkehrssystem muss die unterstützten Währungen mit Annahmeschluss und
Valutierung anzeigen. Beträge werden in Euro mit zwei Nachkommastellen geführt;
Fremdwährungen sind gesondert ausgewiesen. Die Regelung gilt in Verbindung mit
REQ-FA-163.

Priorität: Muss

Abnahmekriterien:
1. Die Darstellung entspricht dem freigegebenen Entwurf in Version 2.1.

REQ-FA-114: Devisenhandel zu Wunschkurs

Das Zahlungsverkehrssystem muss Aufträge zu einem vom Kunden festgelegten Limitkurs bis
zu 30 Tage vormerken. Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt
ergänzend (siehe REQ-FA-171).

Priorität: Muss
Jira: KRED-350

Abnahmekriterien:
1. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-436.
2. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
3. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.

REQ-FA-115: Nachverfolgung internationaler Zahlungen

Das Zahlungsverkehrssystem kann den Status einer Auslandszahlung über die SWIFT-Referenz nachverfolgbar machen. Die Regelung gilt in Verbindung mit NFA-UX-012. Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert ausgewiesen.

Abnahmekriterien:
1. Die Funktion „Nachverfolgung internationaler Zahlungen“ ist nach erfolgreicher Anmeldung innerhalb von 1 Sekunden erreichbar.
2. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.

Priorität: Kann
Quelle: Sicherheitskonzept, Kapitel 3

REQ-FA-116: Rückläufer bei Auslandszahlungen

Das Zahlungsverkehrssystem muss zurückgewiesene Auslandszahlungen mit Rückweisungsgrund und Gegenwert im Portal anzeigen. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung.

Hinweis: Für Firmenkunden gelten abweichende Rahmenwerte, die im Vertrag geregelt sind.
Priorität: Muss
Quelle: Sicherheitskonzept, Kapitel 3
Abhängigkeiten: NFA-PERF-016, REQ-FA-197

Abnahmekriterien:
1. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
2. Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-058.
3. Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
4. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
5. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-435.
6. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.

#### 3.2.3 Freigabe und Limits

##### 3.2.3.1 Freigabeworkflow

###### REQ-FA-117 Freigabe durch zweiten Faktor

Das Zahlungsverkehrssystem muss jede Zahlung durch eine Transaktionsfreigabe mit
dynamischer Verknüpfung von Betrag und Empfänger bestätigen. Alle Texte stehen in
Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung.
Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes
angezeigt.

Priorität: Muss

Abnahmekriterien:
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
- Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-100.
- Die Funktion „Freigabe durch zweiten Faktor“ ist nach erfolgreicher Anmeldung innerhalb von 3 Sekunden erreichbar.

###### REQ-FA-118 Anzeige der Freigabedaten

Das Zahlungsverkehrssystem muss vor der Freigabe Betrag und Empfänger auf dem Freigabegerät unverändert darstellen. Die Verarbeitung ist für den Kunden spätestens nach 4 Sekunden abgeschlossen.

Die Regelung gilt in Verbindung mit NFA-PERF-003.

Hinweis: Der Fachbereich bewertet die Anforderung als wettbewerbsrelevant.
Priorität: Muss

Abnahmekriterien:
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 4.1.
- Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.

###### REQ-FA-119 Kollektivfreigabe

Das Zahlungsverkehrssystem muss bei Firmenkunden die Freigabe durch zwei
Zeichnungsberechtigte mit Einzel- oder Gesamtvertretung abbilden. Die Funktion steht in
der mobilen App und im Browser mit gleichem Funktionsumfang zur Verfügung.

Priorität: Muss
Status: Freigegeben

Abnahmekriterien:
- Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-028.
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
- Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.

###### REQ-FA-120 Freigabe-Eskalation

Das Zahlungsverkehrssystem muss nicht freigegebene Aufträge nach 24 Stunden an die Vertretung eskalieren.

Priorität: Muss
Quelle: Workshop Fachbereich vom 14.03.2026
Abhängigkeiten: REQ-FA-098, SCH-IF-010

Abnahmekriterien:
- Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.

###### REQ-FA-121 Ablehnung mit Begründung

Das Zahlungsverkehrssystem muss die Ablehnung eines Auftrags durch den Freigeber mit Begründung erfassen.

Die Regelung gilt in Verbindung mit REQ-FA-027.

Hinweis: Die technische Machbarkeit wurde im Architekturboard bestätigt.
Priorität: Muss

Abnahmekriterien:
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
- Die Abnahme berücksichtigt die Wechselwirkung mit NFA-PERF-006.
- Ein Test mit 200 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 1 Prozent.

###### REQ-FA-122 Freigabehistorie

Das Zahlungsverkehrssystem kann die Freigabehistorie je Auftrag mit Benutzer und Zeitpunkt anzeigen. Die Verarbeitung ist für den Kunden spätestens nach 9 Sekunden abgeschlossen.

Priorität: Kann

Abnahmekriterien:
- Die Funktion „Freigabehistorie“ ist nach erfolgreicher Anmeldung innerhalb von 1 Sekunden erreichbar.
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 1.4.

###### REQ-FA-123 Freigabe-Delegation

Das Zahlungsverkehrssystem kann die zeitlich befristete Delegation der Freigabeberechtigung ermöglichen.

Priorität: Kann
Quelle: Betriebskonzept, Kapitel 5
Status: Zur Prüfung

Abnahmekriterien:
- Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
- Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-796.
- Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
- Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.

###### REQ-FA-124 Vertrauenswürdige Empfänger

Das Zahlungsverkehrssystem muss für vom Kunden benannte Empfänger eine Befreiung von der starken Kundenauthentifizierung nach Maßgabe der PSD2 nutzen. Die Funktion steht in der mobilen App und im Browser mit gleichem Funktionsumfang zur Verfügung. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung.

Priorität: Muss

Abnahmekriterien:
- Die Funktion „Vertrauenswürdige Empfänger“ ist nach erfolgreicher Anmeldung innerhalb von 4 Sekunden erreichbar.
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
- Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
- Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.

##### 3.2.3.2 Limits

###### [REQ-FA-125] Tageslimit je Kunde [Muss]

Das Zahlungsverkehrssystem muss ein Tageslimit je Kunde und Zahlungsart durchsetzen.

Abnahmekriterien:
1. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
2. Die Darstellung entspricht dem freigegebenen Entwurf in Version 2.3.
3. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
4. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.

###### [REQ-FA-126] Änderung des Limits durch den Kunden [Muss]

Das Zahlungsverkehrssystem muss die Absenkung des Limits im Portal sofort und die Erhöhung nach zusätzlicher Authentifizierung wirksam werden lassen.

Abnahmekriterien:
1. Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
2. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
3. Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.

###### [REQ-FA-127] Limit je Bevollmächtigtem [Muss]

Das Zahlungsverkehrssystem muss für Bevollmächtigte eigene Limits unterhalb des Limits des Vollmachtgebers führen.

Abnahmekriterien:
1. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
2. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-185.
3. Die Darstellung entspricht dem freigegebenen Entwurf in Version 4.3.
4. Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.

###### [REQ-FA-128] Limitüberschreitung [Muss]

Das Zahlungsverkehrssystem muss bei Überschreitung des Limits den Auftrag ablehnen und die Restmenge anzeigen.

Abnahmekriterien:
1. Die Darstellung entspricht dem freigegebenen Entwurf in Version 3.9.
2. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
3. Die Funktion „Limitüberschreitung“ ist nach erfolgreicher Anmeldung innerhalb von 2 Sekunden erreichbar.

###### [REQ-FA-129] Temporäre Limiterhöhung [Muss]

Das Zahlungsverkehrssystem muss eine befristete Erhöhung des Limits für einen einzelnen
Auftrag mit Freigabe durch die Bank erlauben. Die Funktion steht in der mobilen App und
im Browser mit gleichem Funktionsumfang zur Verfügung. Die Angaben stammen aus dem
Kernbanksystem und werden nicht lokal dupliziert.

Abnahmekriterien:
1. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
2. Ein Test mit 1000 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 1 Prozent.

###### [REQ-FA-130] Anzeige des verfügbaren Limits [Muss]

Das Zahlungsverkehrssystem muss das noch verfügbare Limit vor jeder Auftragserfassung anzeigen. Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt. Die Funktion steht in der mobilen App und im Browser mit gleichem Funktionsumfang zur Verfügung.

Abnahmekriterien:
1. Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
2. Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
3. Die Darstellung entspricht dem freigegebenen Entwurf in Version 1.3.
4. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.

###### [REQ-FA-131] Monatslimit für Kartenzahlungen [Muss]

Das Zahlungsverkehrssystem muss Monatslimits für Kartenzahlungen getrennt von Überweisungslimits führen.

Abnahmekriterien:
1. Die Darstellung entspricht dem freigegebenen Entwurf in Version 3.5.
2. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
3. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
4. Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.

###### [REQ-FA-132] Limitprotokoll [Kann]

Das Zahlungsverkehrssystem kann jede Änderung eines Limits mit Benutzer, Kanal und
Zeitpunkt revisionssicher protokollieren. Die Abgrenzung zu den Vorgaben des
Kernbanksystems ist in NFA-SEC-032 beschrieben. Jede Änderung wird mit Zeitstempel,
Benutzerkennung und Kanal im Prüfprotokoll festgehalten.

Abnahmekriterien:
1. Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
2. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
3. Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
4. Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
5. Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-040.

### 3.3 Konten, Karten und Kredite

#### 3.3.1 Konten und Umsätze

##### 3.3.1.1 Kontoübersicht

###### REQ-FA-133 Anzeige aller Konten

Das Kundenportal soll alle Konten, Depots und Kredite des Kunden in einer Übersicht zusammenfassen. Die Abgrenzung zu den Vorgaben des Kernbanksystems ist in REQ-FA-023 beschrieben. Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe REQ-FA-015).

Priorität: Soll
Status: Freigegeben

Abnahmekriterien:
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.

###### REQ-FA-134 Kontostand und Verfügbarer Betrag

Das Kundenportal kann Kontostand, gebuchten Saldo und verfügbaren Betrag getrennt ausweisen. Die Regelung gilt in Verbindung mit NFA-AVL-003. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten.

Hinweis: Die Umsetzung erfolgt in der zweiten Ausbaustufe des Portals.
Priorität: Kann
Abhängigkeiten: NFA-AVL-006, NFA-PERF-007

Abnahmekriterien:
- Die Funktion „Kontostand und Verfügbarer Betrag“ ist nach erfolgreicher Anmeldung innerhalb von 1 Sekunden erreichbar.
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
- Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
- Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.

###### REQ-FA-135 Konten ausblenden

Das Kundenportal muss dem Kunden das Ausblenden einzelner Konten aus der Übersicht erlauben. Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung.

Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert ausgewiesen.

Priorität: Muss
Quelle: Regulatorik-Katalog 2026, Abschnitt 7

Abnahmekriterien:
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
- Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.

###### REQ-FA-136 Eigene Kontobezeichnung

Das Kundenportal muss die Vergabe frei wählbarer Kontobezeichnungen ermöglichen. Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe REQ-FA-140). Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung.

Hinweis: Für Firmenkunden gelten abweichende Rahmenwerte, die im Vertrag geregelt sind.
Priorität: Muss

Abnahmekriterien:
- Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
- Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
- Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
- Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
- Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.

###### REQ-FA-137 Kontoreihenfolge

Das Kundenportal muss die Sortierung der Konten per Drag-and-drop anpassbar machen. Die Angaben stammen aus dem Kernbanksystem und werden nicht lokal dupliziert.

Abnahmekriterien:
- Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
- Ein Test mit 200 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,5 Prozent.

Priorität: Muss

###### REQ-FA-138 Konten anderer Banken

Das Kundenportal soll Konten anderer Institute über eine Kontoinformationsschnittstelle nach Einwilligung einbinden. Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt.

Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt.

Priorität: Soll

Abnahmekriterien:
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
- Die Abnahme berücksichtigt die Wechselwirkung mit NFA-OPS-004.
- Ein Test mit 50 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,5 Prozent.

###### REQ-FA-139 Anzeige der IBAN mit Kopierfunktion

Das Kundenportal muss die IBAN eines Kontos formatiert anzeigen und mit einer Aktion in
die Zwischenablage übernehmen. Die Funktion steht in der mobilen App und im Browser mit
gleichem Funktionsumfang zur Verfügung. Für Sonderfälle wie Vollmachten oder
Gemeinschaftskonten gilt ergänzend (siehe REQ-FA-096).

Abnahmekriterien:
- Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-897.
- Die Funktion „Anzeige der IBAN mit Kopierfunktion“ ist nach erfolgreicher Anmeldung innerhalb von 2 Sekunden erreichbar.
- Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.

Priorität: Muss

###### REQ-FA-140 Darstellung für Gemeinschaftskonten

Das Kundenportal soll bei Gemeinschaftskonten alle Verfügungsberechtigten anzeigen.

Hinweis: Die fachliche Abstimmung mit der Rechtsabteilung ist noch ausstehend.
Priorität: Soll
Abhängigkeiten: REQ-FA-061, SCH-IF-015

Abnahmekriterien:
- Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
- Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
- Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-693.

##### 3.3.1.2 Umsätze und Kategorisierung

REQ-FA-141: Umsatzliste

Das Kundenportal muss die Umsätze eines Kontos mit Buchungsdatum, Wertstellung, Verwendungszweck und Betrag anzeigen.

Priorität: Muss

Abnahmekriterien:
1. Ein Test mit 200 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 1 Prozent.
2. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
3. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-569.

REQ-FA-142: Umsatzsuche

Das Kundenportal soll die Volltextsuche in Verwendungszweck und Auftraggeber unterstützen. Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert ausgewiesen.

Priorität: Soll
Quelle: Regulatorik-Katalog 2026, Abschnitt 7

Abnahmekriterien:
1. Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
2. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
3. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.

REQ-FA-143: Filter nach Zeitraum und Betrag

Das Kundenportal kann Umsätze nach Zeitraum, Betrag und Buchungsart filtern. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung.

Abnahmekriterien:
1. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
2. Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.

Priorität: Kann
Abhängigkeiten: NFA-SEC-016, REQ-FA-046

REQ-FA-144: Automatische Kategorisierung

Das Kundenportal muss Umsätze anhand lernender Regeln einer Ausgabenkategorie zuordnen. Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe REQ-FA-198).

Priorität: Muss
Quelle: Fachkonzept Zahlungsverkehr, Kapitel 4
Abhängigkeiten: NFA-PERF-016, REQ-FA-116

Abnahmekriterien:
1. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
2. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.

REQ-FA-145: Manuelle Kategorienkorrektur

Das Kundenportal muss die Korrektur einer Kategorie durch den Kunden übernehmen und für gleichartige Umsätze vorschlagen. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten.

Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt.

Priorität: Muss
Status: Zur Prüfung

Abnahmekriterien:
1. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
2. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
3. Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
4. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.

REQ-FA-146: Vorgemerkte Umsätze

Das Kundenportal kann vorgemerkte Umsätze deutlich von gebuchten Umsätzen unterscheiden. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten.

Priorität: Kann

Abnahmekriterien:
1. Die Abnahme berücksichtigt die Wechselwirkung mit SCH-IF-013.
2. Die Funktion „Vorgemerkte Umsätze“ ist nach erfolgreicher Anmeldung innerhalb von 3 Sekunden erreichbar.
3. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
4. Die Darstellung entspricht dem freigegebenen Entwurf in Version 3.7.
5. Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
6. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.

REQ-FA-147: Umsatzdetails

Das Kundenportal soll zu jedem Umsatz alle Einzelheiten wie Mandatsreferenz und End-to-End-Referenz anzeigen. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten.

Priorität: Soll

Abnahmekriterien:
1. Die Funktion „Umsatzdetails“ ist nach erfolgreicher Anmeldung innerhalb von 2 Sekunden erreichbar.
2. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
3. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.

REQ-FA-148: Belege zu Umsätzen

Das Kundenportal soll an einen Umsatz einen Beleg als Bild oder PDF anhängen lassen.

Abnahmekriterien:
1. Die Funktion „Belege zu Umsätzen“ ist nach erfolgreicher Anmeldung innerhalb von 4 Sekunden erreichbar.
2. Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
3. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
4. Die Darstellung entspricht dem freigegebenen Entwurf in Version 1.1.
5. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.

Hinweis: Die fachliche Abstimmung mit der Rechtsabteilung ist noch ausstehend.
Priorität: Soll
Abhängigkeiten: REQ-FA-122, REQ-FA-141

REQ-FA-149: Export von Umsätzen

Das Kundenportal muss Umsätze als CSV, CAMT.053 und PDF exportieren. Die Angaben stammen aus dem Kernbanksystem und werden nicht lokal dupliziert.

Priorität: Muss
Quelle: Workshop Fachbereich vom 14.03.2026

Abnahmekriterien:
1. Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-017.
2. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
3. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
4. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-500.
5. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.

##### 3.3.1.3 Kontoauszüge

###### REQ-FA-150 Elektronischer Kontoauszug

Das Kundenportal kann Kontoauszüge monatlich oder auf Wunsch quartalsweise als PDF bereitstellen. Die Funktion steht in der mobilen App und im Browser mit gleichem Funktionsumfang zur Verfügung. Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt.

Priorität: Kann
Abhängigkeiten: BET-SLA-001, REQ-FA-055

Abnahmekriterien:
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
- Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.

###### REQ-FA-151 Rechnungsabschluss

Das Kundenportal kann Rechnungsabschlüsse mit Zins- und Entgeltaufstellung im Postfach ablegen. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung. Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe NFA-OPS-004).

Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt.

Priorität: Kann

Abnahmekriterien:
- Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
- Ein Test mit 200 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,1 Prozent.

###### REQ-FA-152 Nachträgliche Auszüge

Das Kundenportal muss Kontoauszüge der letzten zehn Jahre abrufbar halten.

Die Abgrenzung zu den Vorgaben des Kernbanksystems ist in SCH-IF-020 beschrieben.

Priorität: Muss
Quelle: Sicherheitskonzept, Kapitel 3

###### REQ-FA-153 Einhaltung der Aufbewahrungsfristen

Das Kundenportal muss Kontoauszüge unveränderlich nach den handels- und steuerrechtlichen Fristen aufbewahren. Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert ausgewiesen.

Priorität: Muss

Abnahmekriterien:
- Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
- Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
- Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
- Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-276.

###### REQ-FA-154 Barrierefreier Kontoauszug

Das Kundenportal muss Kontoauszüge zusätzlich in einer barrierefreien Fassung bereitstellen. Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe REQ-FA-175). Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung.

Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe ABN-45.5).

Priorität: Muss

Abnahmekriterien:
- Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-022.
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.

###### REQ-FA-155 Duplikat anfordern

Das Kundenportal muss ein beglaubigtes Duplikat eines Kontoauszugs als gebührenpflichtigen Auftrag anbieten. Die Regelung gilt in Verbindung mit SCH-IF-023. Die Funktion steht in der mobilen App und im Browser mit gleichem Funktionsumfang zur Verfügung.

Die Regelung gilt in Verbindung mit NFA-SEC-030.

Priorität: Muss

Abnahmekriterien:
- Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
- Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
- Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 1.5.
- Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.

###### REQ-FA-156 Versand an Steuerberater

Das Kundenportal soll die Freigabe von Kontoauszügen für einen Steuerberater mit befristetem Zugriff ermöglichen. Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe NFA-UX-013).

Abnahmekriterien:
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 1.8.
- Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
- Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-167.
- Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.

Priorität: Soll

#### 3.3.2 Karten

##### 3.3.2.1 Kartenverwaltung

###### REQ-FA-157 Kartenübersicht

Das Kundenportal kann alle Debit- und Kreditkarten mit Status, Ablaufdatum und letzten vier Ziffern anzeigen. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten.

Die Angaben stammen aus dem Kernbanksystem und werden nicht lokal dupliziert.

Priorität: Kann

Abnahmekriterien:
1. Ein Test mit 1000 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,5 Prozent.
2. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
3. Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-023.
4. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-792.

###### REQ-FA-158 Neue Karte beantragen

Das Kundenportal soll die Beantragung einer Zusatz- oder Ersatzkarte ermöglichen.

Priorität: Soll
Status: Zur Prüfung

Abnahmekriterien:
1. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
2. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
3. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.

###### REQ-FA-159 PIN-Anzeige

Das Kundenportal soll die PIN einer Karte einmalig und nur nach starker Authentifizierung anzeigen.

Abnahmekriterien:
1. Ein Test mit 50 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 1 Prozent.
2. Die Abnahme berücksichtigt die Wechselwirkung mit MIG_DAT-005.
3. Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.

Hinweis: Für Firmenkunden gelten abweichende Rahmenwerte, die im Vertrag geregelt sind.
Priorität: Soll

###### REQ-FA-160 Kartenlimits ändern

Das Kundenportal muss Limits für Bargeldabhebung und Kartenzahlung durch den Kunden anpassen lassen.

Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert ausgewiesen.

Priorität: Muss

Abnahmekriterien:
1. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
2. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
3. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
4. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
5. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.

###### REQ-FA-161 Regionale Einsatzgebiete

Das Kundenportal muss den Einsatz der Karte für Regionen und Händlerkategorien ein- und ausschaltbar machen.

Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten.

Abnahmekriterien:
1. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.

Priorität: Muss

###### REQ-FA-162 Kontaktlose Zahlung abschalten

Das Kundenportal soll kontaktlose Zahlungen separat deaktivieren lassen.

Priorität: Soll
Quelle: Fachkonzept Zahlungsverkehr, Kapitel 4
Abhängigkeiten: NFA-UX-015, REQ-FA-108

Abnahmekriterien:
1. Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
2. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
3. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.

###### REQ-FA-163 Digitale Karte

Das Kundenportal kann die Provisionierung der Karte in mobile Wallets unterstützen. Die Verarbeitung ist für den Kunden spätestens nach 3 Sekunden abgeschlossen. Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert ausgewiesen.

Priorität: Kann
Status: In Abstimmung

Abnahmekriterien:
1. Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
2. Die Abnahme berücksichtigt die Wechselwirkung mit NFA-REG-001.
3. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-445.
4. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.

###### REQ-FA-164 Kartenumsätze in Echtzeit

Das Kundenportal muss Kartenumsätze innerhalb von 30 Sekunden als vorgemerkten Umsatz anzeigen. Die Abgrenzung zu den Vorgaben des Kernbanksystems ist in NFA-PERF-010 beschrieben.

Abnahmekriterien:
1. Ein Test mit 200 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,1 Prozent.
2. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
3. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.

Priorität: Muss

##### 3.3.2.2 Kartensperre und Missbrauch

REQ-FA-165: Sofortige Kartensperre

Das Kundenportal soll die sofortige Sperre einer Karte mit einer einzelnen Aktion ohne zweiten Faktor ermöglichen. Die Regelung gilt in Verbindung mit REQ-FA-014.

Priorität: Soll
Quelle: Regulatorik-Katalog 2026, Abschnitt 7

Abnahmekriterien:
- Ein Test mit 200 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,1 Prozent.
- Die Funktion „Sofortige Kartensperre“ ist nach erfolgreicher Anmeldung innerhalb von 1 Sekunden erreichbar.
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.

REQ-FA-166: Aufhebung der Sperre

Das Kundenportal muss die Entsperrung einer vorübergehend gesperrten Karte nach
Authentifizierung zulassen.

Hinweis: Die fachliche Abstimmung mit der Rechtsabteilung ist noch ausstehend.
Priorität: Muss

Abnahmekriterien:
- Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
- Die Abnahme berücksichtigt die Wechselwirkung mit SCH-IF-015.

REQ-FA-167: Endgültige Sperre bei Verlust

Das Kundenportal muss bei Verlust oder Diebstahl die endgültige Sperre mit Ausstellung einer Ersatzkarte auslösen. Die Angaben stammen aus dem Kernbanksystem und werden nicht lokal dupliziert.

Die Verarbeitung ist für den Kunden spätestens nach 2 Sekunden abgeschlossen.

Hinweis: Der Fachbereich bewertet die Anforderung als wettbewerbsrelevant.
Priorität: Muss

Abnahmekriterien:
- Die Funktion „Endgültige Sperre bei Verlust“ ist nach erfolgreicher Anmeldung innerhalb von 3 Sekunden erreichbar.
- Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
- Die Abnahme berücksichtigt die Wechselwirkung mit NFA-SEC-006.

REQ-FA-168: Sperr-Notruf

Das Kundenportal muss die Sperrung zusätzlich über die zentrale Sperrnummer ermöglichen.

Priorität: Muss
Quelle: Fachkonzept Kundenportal, Kapitel 2

Abnahmekriterien:
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
- Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
- Die Funktion „Sperr-Notruf“ ist nach erfolgreicher Anmeldung innerhalb von 2 Sekunden erreichbar.
- Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
- Ein Test mit 50 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 1 Prozent.

REQ-FA-169: Meldung verdächtiger Umsätze

Das Kundenportal soll dem Kunden das Melden eines nicht autorisierten Umsatzes direkt am
Umsatz erlauben. Die Funktion steht in der mobilen App und im Browser mit gleichem
Funktionsumfang zur Verfügung. Die Angaben stammen aus dem Kernbanksystem und werden
nicht lokal dupliziert.

Priorität: Soll
Abhängigkeiten: REQ-FA-192, REQ-FA-205
Jira: KRED-95

Abnahmekriterien:
- Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
- Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
- Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-752.
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 2.2.

REQ-FA-170: Reklamationsprozess

Das Kundenportal muss für gemeldete Umsätze einen Reklamationsvorgang mit Statusverfolgung anlegen.

Priorität: Muss

Abnahmekriterien:
- Die Funktion „Reklamationsprozess“ ist nach erfolgreicher Anmeldung innerhalb von 2 Sekunden erreichbar.
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 1.9.

REQ-FA-171: Benachrichtigung bei Kartenzahlung im Ausland

Das Kundenportal soll bei Kartenzahlungen außerhalb des Heimatlandes eine
Benachrichtigung auslösen.

Priorität: Soll

Abnahmekriterien:
- Ein Test mit 1000 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,5 Prozent.
- Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.

REQ-FA-172: Automatische Sperre bei Betrugsverdacht

Das Kundenportal kann eine Karte bei begründetem Betrugsverdacht vorübergehend sperren
und den Kunden kontaktieren. Die Regelung gilt in Verbindung mit REQ-FA-100. Alle Texte
stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen
Textverwaltung.

Hinweis: Der Fachbereich bewertet die Anforderung als wettbewerbsrelevant.
Priorität: Kann
Quelle: Fachkonzept Kundenportal, Kapitel 2

Abnahmekriterien:
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
- Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.

#### 3.3.3 Kreditanfragen

##### 3.3.3.1 Antragsstrecke

###### REQ-FA-173 Kreditrechner

Das Kundenportal kann einen Kreditrechner mit Laufzeit, Rate und Gesamtkosten bereitstellen.

Priorität: Kann
Abhängigkeiten: ABN-45.2, NFA-SEC-008
Jira: KRED-147

Abnahmekriterien:
1. Die Abnahme berücksichtigt die Wechselwirkung mit NFA-DSG-007.
2. Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.

###### REQ-FA-174 Antrag auf Ratenkredit

Das Kundenportal soll den Antrag auf einen Ratenkredit vollständig digital ermöglichen.
Regel 1: Bei einem Kunden mit Einzelverfügung wird der Vorgang mit dem Status „in
Klärung“ gekennzeichnet und das Ergebnis mit der Regelversion 2.1 im Prüfprotokoll
festgehalten. Regel 2: Bei einem Auftrag über Gemeinschaftskonten wird der Vorgang zur
Sachbearbeitung geleitet und das Ergebnis mit der Regelversion 3.0 im Prüfprotokoll
festgehalten. Regel 3: Bei einer Verfügung durch Bevollmächtigte wird der Vorgang mit
dem Status „in Klärung“ gekennzeichnet und das Ergebnis mit der Regelversion 5.0 im
Prüfprotokoll festgehalten. Regel 4: Bei einem Auftrag außerhalb der Annahmezeit wird
der Vorgang zur Sachbearbeitung geleitet und das Ergebnis mit der Regelversion 1.9 im
Prüfprotokoll festgehalten. Regel 5: Bei einer abgelehnten Prüfung wird der Vorgang mit
dem Status „in Klärung“ gekennzeichnet und das Ergebnis mit der Regelversion 6.8 im
Prüfprotokoll festgehalten. Regel 6: Bei einem Auftrag mit Terminvorgabe wird der
Vorgang zur Sachbearbeitung geleitet und das Ergebnis mit der Regelversion 6.7 im
Prüfprotokoll festgehalten. Regel 7: Bei einer Wiederholung nach Zeitüberschreitung wird
der Vorgang mit dem Status „in Klärung“ gekennzeichnet und das Ergebnis mit der
Regelversion 3.6 im Prüfprotokoll festgehalten. Regel 8: Bei einem Auftrag eines
Firmenkunden wird der Vorgang zur Sachbearbeitung geleitet und das Ergebnis mit der
Regelversion 1.5 im Prüfprotokoll festgehalten. Regel 9: Bei einem Auftrag in
Fremdwährung wird der Vorgang mit dem Status „in Klärung“ gekennzeichnet und das
Ergebnis mit der Regelversion 6.5 im Prüfprotokoll festgehalten. Regel 10: Bei einer
Rückfrage der Sachbearbeitung wird der Vorgang zur Sachbearbeitung geleitet und das
Ergebnis mit der Regelversion 4.4 im Prüfprotokoll festgehalten. Regel 11: Bei einem
Kunden mit Einzelverfügung wird der Vorgang mit dem Status „in Klärung“ gekennzeichnet
und das Ergebnis mit der Regelversion 6.9 im Prüfprotokoll festgehalten. Regel 12: Bei
einem Auftrag über Gemeinschaftskonten wird der Vorgang zur Sachbearbeitung geleitet und
das Ergebnis mit der Regelversion 2.2 im Prüfprotokoll festgehalten. Regel 13: Bei einer
Verfügung durch Bevollmächtigte wird der Vorgang mit dem Status „in Klärung“
gekennzeichnet und das Ergebnis mit der Regelversion 3.2 im Prüfprotokoll festgehalten.
Regel 14: Bei einem Auftrag außerhalb der Annahmezeit wird der Vorgang zur
Sachbearbeitung geleitet und das Ergebnis mit der Regelversion 2.7 im Prüfprotokoll
festgehalten. Regel 15: Bei einer abgelehnten Prüfung wird der Vorgang mit dem Status
„in Klärung“ gekennzeichnet und das Ergebnis mit der Regelversion 6.7 im Prüfprotokoll
festgehalten. Regel 16: Bei einem Auftrag mit Terminvorgabe wird der Vorgang zur
Sachbearbeitung geleitet und das Ergebnis mit der Regelversion 6.1 im Prüfprotokoll
festgehalten. Regel 17: Bei einer Wiederholung nach Zeitüberschreitung wird der Vorgang
mit dem Status „in Klärung“ gekennzeichnet und das Ergebnis mit der Regelversion 2.2 im
Prüfprotokoll festgehalten. Regel 18: Bei einem Auftrag eines Firmenkunden wird der
Vorgang zur Sachbearbeitung geleitet und das Ergebnis mit der Regelversion 6.5 im
Prüfprotokoll festgehalten. Regel 19: Bei einem Auftrag in Fremdwährung wird der Vorgang
mit dem Status „in Klärung“ gekennzeichnet und das Ergebnis mit der Regelversion 3.6 im
Prüfprotokoll festgehalten. Regel 20: Bei einer Rückfrage der Sachbearbeitung wird der
Vorgang zur Sachbearbeitung geleitet und das Ergebnis mit der Regelversion 1.8 im
Prüfprotokoll festgehalten. Regel 21: Bei einem Kunden mit Einzelverfügung wird der
Vorgang mit dem Status „in Klärung“ gekennzeichnet und das Ergebnis mit der Regelversion
6.2 im Prüfprotokoll festgehalten. Regel 22: Bei einem Auftrag über Gemeinschaftskonten
wird der Vorgang zur Sachbearbeitung geleitet und das Ergebnis mit der Regelversion 2.9
im Prüfprotokoll festgehalten.

Priorität: Soll
Quelle: Betriebskonzept, Kapitel 5

Abnahmekriterien:
1. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
2. Die Darstellung entspricht dem freigegebenen Entwurf in Version 3.0.
3. Die Funktion „Antrag auf Ratenkredit“ ist nach erfolgreicher Anmeldung innerhalb von 1 Sekunden erreichbar.
4. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.

###### REQ-FA-175 Vorbefüllung mit Bestandsdaten

Das Kundenportal kann bekannte Daten des Kunden aus dem Stamm vorbefüllen. Die Regelung
gilt in Verbindung mit REQ-FA-140.

Priorität: Kann
Status: Freigegeben

Abnahmekriterien:
1. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
2. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
3. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
4. Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.

###### REQ-FA-176 Einkommensnachweis

Das Kundenportal muss Einkommensnachweise per Upload oder über eine Kontoeinsicht entgegennehmen. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten. Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert ausgewiesen.

Priorität: Muss
Quelle: Regulatorik-Katalog 2026, Abschnitt 7
Abhängigkeiten: NFA-PERF-014, REQ-FA-035

###### REQ-FA-177 Abschluss mit qualifizierter Signatur

Das Kundenportal kann den Kreditvertrag per qualifizierter elektronischer Signatur abschließen lassen. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung.

Priorität: Kann

Abnahmekriterien:
1. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
2. Die Funktion „Abschluss mit qualifizierter Signatur“ ist nach erfolgreicher Anmeldung innerhalb von 1 Sekunden erreichbar.
3. Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.

###### REQ-FA-178 Widerrufsbelehrung

Das Kundenportal soll die Widerrufsbelehrung mit Frist und Adressaten vor Vertragsabschluss anzeigen. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten. Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert ausgewiesen.

Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten.

Abnahmekriterien:
1. Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
2. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
3. Die Funktion „Widerrufsbelehrung“ ist nach erfolgreicher Anmeldung innerhalb von 4 Sekunden erreichbar.
4. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
5. Ein Test mit 50 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 1 Prozent.
6. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.

Hinweis: Die technische Machbarkeit wurde im Architekturboard bestätigt.
Priorität: Soll

###### REQ-FA-179 Vorvertragliche Information

Das Kundenportal kann die Europäischen Standardinformationen für Verbraucherkredite vor Abschluss bereitstellen.

Abnahmekriterien:
1. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
2. Die Funktion „Vorvertragliche Information“ ist nach erfolgreicher Anmeldung innerhalb von 4 Sekunden erreichbar.
3. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.

Hinweis: Die Umsetzung erfolgt in der zweiten Ausbaustufe des Portals.
Priorität: Kann
Status: Zur Prüfung

###### REQ-FA-180 Speichern und Fortsetzen

Das Kundenportal soll einen unvollständigen Antrag 30 Tage vorhalten.

Hinweis: Die technische Machbarkeit wurde im Architekturboard bestätigt.
Priorität: Soll

Abnahmekriterien:
1. Die Darstellung entspricht dem freigegebenen Entwurf in Version 2.4.
2. Die Funktion „Speichern und Fortsetzen“ ist nach erfolgreicher Anmeldung innerhalb von 4 Sekunden erreichbar.

##### 3.3.3.2 Bonitätsprüfung und Entscheidung

REQ-FA-181: Abruf der Auskunftei

Die Kreditentscheidung kann mit Einwilligung des Kunden eine Bonitätsauskunft bei der Auskunftei abrufen.

Hinweis: Die technische Machbarkeit wurde im Architekturboard bestätigt.
Priorität: Kann

Abnahmekriterien:
- Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 2.4.
- Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-184.
- Die Funktion „Abruf der Auskunftei“ ist nach erfolgreicher Anmeldung innerhalb von 2 Sekunden erreichbar.
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
- Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.

REQ-FA-182: Scoring und Regelwerk

Die Kreditentscheidung soll die Entscheidung anhand eines versionierten Regelwerks und des Scorings treffen.

Abnahmekriterien:
- Die Funktion „Scoring und Regelwerk“ ist nach erfolgreicher Anmeldung innerhalb von 3 Sekunden erreichbar.
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
- Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.

Priorität: Soll

REQ-FA-183: Automatische Entscheidung

Die Kreditentscheidung muss Anträge innerhalb festgelegter Grenzen innerhalb von 60 Sekunden automatisch entscheiden.

Hinweis: Der Fachbereich bewertet die Anforderung als wettbewerbsrelevant.
Priorität: Muss

Abnahmekriterien:
- Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.

REQ-FA-184: Manuelle Prüfung

Die Kreditentscheidung soll Anträge außerhalb der Grenzen an die Kreditsachbearbeitung
weiterleiten. Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen
sind gesondert ausgewiesen.

Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert ausgewiesen.

Priorität: Soll
Quelle: Betriebskonzept, Kapitel 5

Abnahmekriterien:
- Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.

REQ-FA-185: Begründung der Ablehnung

Die Kreditentscheidung muss dem Kunden die Ablehnung mit den maßgeblichen Gründen und dem Hinweis auf menschliche Überprüfung mitteilen. Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt.

Hinweis: Der Fachbereich bewertet die Anforderung als wettbewerbsrelevant.
Priorität: Muss

Abnahmekriterien:
- Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-486.
- Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.

REQ-FA-186: Haushaltsrechnung

Die Kreditentscheidung soll die Haushaltsrechnung des Kunden mit Einnahmen und Ausgaben berücksichtigen.

Abnahmekriterien:
- Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-182.
- Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.

Priorität: Soll
Quelle: Fachkonzept Zahlungsverkehr, Kapitel 4

REQ-FA-187: Sicherheiten

Die Kreditentscheidung soll Sicherheiten zu einem Kredit erfassen und ihren Wert bis zur
Auszahlung prüfen. Die Abgrenzung zu den Vorgaben des Kernbanksystems ist in REQ-FA-051
beschrieben. Die Funktion steht in der mobilen App und im Browser mit gleichem
Funktionsumfang zur Verfügung.

Abnahmekriterien:
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 1.1.

Priorität: Soll
Jira: KRED-250

REQ-FA-188: Auszahlungsfreigabe

Die Kreditentscheidung kann die Auszahlung erst nach Vorliegen aller Auszahlungsvoraussetzungen freigeben. Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert ausgewiesen.

Abnahmekriterien:
- Die Abnahme berücksichtigt die Wechselwirkung mit ABN-45.7.
- Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-352.
- Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.

Priorität: Kann
Quelle: Fachkonzept Kundenportal, Kapitel 2

### 3.4 Versicherungen und Schadenmeldung

#### 3.4.1 Verträge und Policen

##### 3.4.1.1 Vertragsübersicht

###### REQ-FA-189 Übersicht aller Verträge

Das Versicherungsmodul muss alle Versicherungsverträge des Kunden mit Sparte, Beitrag und Laufzeit anzeigen. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung. Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert ausgewiesen.

Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe REQ-FA-004).

Hinweis: Die Umsetzung erfolgt in der zweiten Ausbaustufe des Portals.
Priorität: Muss
Status: Freigegeben
Abhängigkeiten: NFA-UX-006, REQ-FA-054

Abnahmekriterien:
1. Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
2. Die Darstellung entspricht dem freigegebenen Entwurf in Version 1.9.
3. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.

###### REQ-FA-190 Vertragsdetails

Das Versicherungsmodul muss zu jedem Vertrag Leistungsumfang, Selbstbeteiligung und Zahlweise darstellen.

Die Regelung gilt in Verbindung mit REQ-FA-179.

Priorität: Muss
Jira: KRED-56

Abnahmekriterien:
1. Die Darstellung entspricht dem freigegebenen Entwurf in Version 3.6.
2. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
3. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
4. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-194.
5. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
6. Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.

###### REQ-FA-191 Police als PDF

Das Versicherungsmodul muss die aktuelle Versicherungspolice als PDF bereitstellen. Die Angaben stammen aus dem Kernbanksystem und werden nicht lokal dupliziert.

Priorität: Muss

Abnahmekriterien:
1. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
2. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
3. Ein Test mit 50 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,5 Prozent.
4. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-788.

###### REQ-FA-192 Änderung der Zahlweise

Das Versicherungsmodul muss die Änderung der Beitragszahlweise zum nächsten Fälligkeitstermin ermöglichen. Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert ausgewiesen. Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt.

Hinweis: Die technische Machbarkeit wurde im Architekturboard bestätigt.
Priorität: Muss

Abnahmekriterien:
1. Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-054.

###### REQ-FA-193 Änderung der Bankverbindung

Das Versicherungsmodul muss die Änderung der Bankverbindung für den Beitragseinzug nach Authentifizierung zulassen. Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe REQ-FA-097). Die Abgrenzung zu den Vorgaben des Kernbanksystems ist in MIG_ROL-001 beschrieben.

Priorität: Muss
Status: Freigegeben

Abnahmekriterien:
1. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
2. Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-073.

###### REQ-FA-194 Kündigung

Das Versicherungsmodul soll die Kündigung eines Vertrags in Textform mit Bestätigung im
Postfach erfassen. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im
Prüfprotokoll festgehalten. Die Funktion steht in der mobilen App und im Browser mit
gleichem Funktionsumfang zur Verfügung.

Priorität: Soll
Abhängigkeiten: REQ-FA-074, REQ-FA-113

Abnahmekriterien:
1. Die Funktion „Kündigung“ ist nach erfolgreicher Anmeldung innerhalb von 4 Sekunden erreichbar.
2. Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-187.
3. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
4. Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.

###### REQ-FA-195 Beitragsrechnung

Das Versicherungsmodul kann Beitragsrechnungen und Zahlungsstatus je Vertrag anzeigen. Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt.

Priorität: Kann
Quelle: Fachkonzept Zahlungsverkehr, Kapitel 4

###### REQ-FA-196 Bedingungswerk

Das Versicherungsmodul soll das jeweils gültige Bedingungswerk versioniert zum Abruf bereithalten. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten. Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt.

Priorität: Soll
Quelle: Sicherheitskonzept, Kapitel 3

#### 3.4.2 Schadenmeldung

##### 3.4.2.1 Meldung und Bearbeitung

###### REQ-FA-197 Schadenmeldung erfassen

Das Versicherungsmodul kann die Meldung eines Schadens mit Datum, Ort, Hergang und Schadenhöhe erfassen. Regel 1: Bei einem Kunden mit Einzelverfügung wird der Vorgang mit dem Status „in Klärung“ gekennzeichnet und das Ergebnis mit der Regelversion 2.0 im Prüfprotokoll festgehalten. Regel 2: Bei einem Auftrag über Gemeinschaftskonten wird der Vorgang zur Sachbearbeitung geleitet und das Ergebnis mit der Regelversion 2.0 im Prüfprotokoll festgehalten. Regel 3: Bei einer Verfügung durch Bevollmächtigte wird der Vorgang mit dem Status „in Klärung“ gekennzeichnet und das Ergebnis mit der Regelversion 1.8 im Prüfprotokoll festgehalten. Regel 4: Bei einem Auftrag außerhalb der Annahmezeit wird der Vorgang zur Sachbearbeitung geleitet und das Ergebnis mit der Regelversion 1.9 im Prüfprotokoll festgehalten. Regel 5: Bei einer abgelehnten Prüfung wird der Vorgang mit dem Status „in Klärung“ gekennzeichnet und das Ergebnis mit der Regelversion 4.1 im Prüfprotokoll festgehalten. Regel 6: Bei einem Auftrag mit Terminvorgabe wird der Vorgang zur Sachbearbeitung geleitet und das Ergebnis mit der Regelversion 2.3 im Prüfprotokoll festgehalten. Regel 7: Bei einer Wiederholung nach Zeitüberschreitung wird der Vorgang mit dem Status „in Klärung“ gekennzeichnet und das Ergebnis mit der Regelversion 4.0 im Prüfprotokoll festgehalten. Regel 8: Bei einem Auftrag eines Firmenkunden wird der Vorgang zur Sachbearbeitung geleitet und das Ergebnis mit der Regelversion 5.1 im Prüfprotokoll festgehalten. Regel 9: Bei einem Auftrag in Fremdwährung wird der Vorgang mit dem Status „in Klärung“ gekennzeichnet und das Ergebnis mit der Regelversion 1.1 im Prüfprotokoll festgehalten. Regel 10: Bei einer Rückfrage der Sachbearbeitung wird der Vorgang zur Sachbearbeitung geleitet und das Ergebnis mit der Regelversion 6.4 im Prüfprotokoll festgehalten. Regel 11: Bei einem Kunden mit Einzelverfügung wird der Vorgang mit dem Status „in Klärung“ gekennzeichnet und das Ergebnis mit der Regelversion 1.4 im Prüfprotokoll festgehalten. Regel 12: Bei einem Auftrag über Gemeinschaftskonten wird der Vorgang zur Sachbearbeitung geleitet und das Ergebnis mit der Regelversion 4.7 im Prüfprotokoll festgehalten. Regel 13: Bei einer Verfügung durch Bevollmächtigte wird der Vorgang mit dem Status „in Klärung“ gekennzeichnet und das Ergebnis mit der Regelversion 2.9 im Prüfprotokoll festgehalten. Regel 14: Bei einem Auftrag außerhalb der Annahmezeit wird der Vorgang zur Sachbearbeitung geleitet und das Ergebnis mit der Regelversion 4.3 im Prüfprotokoll festgehalten. Regel 15: Bei einer abgelehnten Prüfung wird der Vorgang mit dem Status „in Klärung“ gekennzeichnet und das Ergebnis mit der Regelversion 5.1 im Prüfprotokoll festgehalten. Regel 16: Bei einem Auftrag mit Terminvorgabe wird der Vorgang zur Sachbearbeitung geleitet und das Ergebnis mit der Regelversion 1.1 im Prüfprotokoll festgehalten. Regel 17: Bei einer Wiederholung nach Zeitüberschreitung wird der Vorgang mit dem Status „in Klärung“ gekennzeichnet und das Ergebnis mit der Regelversion 1.5 im Prüfprotokoll festgehalten. Regel 18: Bei einem Auftrag eines Firmenkunden wird der Vorgang zur Sachbearbeitung geleitet und das Ergebnis mit der Regelversion 2.3 im Prüfprotokoll festgehalten. Regel 19: Bei einem Auftrag in Fremdwährung wird der Vorgang mit dem Status „in Klärung“ gekennzeichnet und das Ergebnis mit der Regelversion 6.6 im Prüfprotokoll festgehalten. Regel 20: Bei einer Rückfrage der Sachbearbeitung wird der Vorgang zur Sachbearbeitung geleitet und das Ergebnis mit der Regelversion 2.9 im Prüfprotokoll festgehalten. Regel 21: Bei einem Kunden mit Einzelverfügung wird der Vorgang mit dem Status „in Klärung“ gekennzeichnet und das Ergebnis mit der Regelversion 4.2 im Prüfprotokoll festgehalten. Regel 22: Bei einem Auftrag über Gemeinschaftskonten wird der Vorgang zur Sachbearbeitung geleitet und das Ergebnis mit der Regelversion 6.2 im Prüfprotokoll festgehalten. Regel 23: Bei einer Verfügung durch Bevollmächtigte wird der Vorgang mit dem Status „in Klärung“ gekennzeichnet und das Ergebnis mit der Regelversion 4.6 im Prüfprotokoll festgehalten. Regel 24: Bei einem Auftrag außerhalb der Annahmezeit wird der Vorgang zur Sachbearbeitung geleitet und das Ergebnis mit der Regelversion 3.6 im Prüfprotokoll festgehalten. Regel 25: Bei einer abgelehnten Prüfung wird der Vorgang mit dem Status „in Klärung“ gekennzeichnet und das Ergebnis mit der Regelversion 5.3 im Prüfprotokoll festgehalten. Regel 26: Bei einem Auftrag mit Terminvorgabe wird der Vorgang zur Sachbearbeitung geleitet und das Ergebnis mit der Regelversion 2.2 im Prüfprotokoll festgehalten. Regel 27: Bei einer Wiederholung nach Zeitüberschreitung wird der Vorgang mit dem Status „in Klärung“ gekennzeichnet und das Ergebnis mit der Regelversion 4.6 im Prüfprotokoll festgehalten.

Hinweis: Für Firmenkunden gelten abweichende Rahmenwerte, die im Vertrag geregelt sind.
Priorität: Kann
Status: Zur Prüfung

Abnahmekriterien:
- Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
- Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.

###### REQ-FA-198 Fotos und Belege

Das Versicherungsmodul soll bis zu 20 Fotos und Belege je Schadenfall entgegennehmen. Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt.

Priorität: Soll
Quelle: Regulatorik-Katalog 2026, Abschnitt 7
Abhängigkeiten: REQ-FA-071, REQ-FA-076

Abnahmekriterien:
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
- Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
- Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.

###### REQ-FA-199 Auswahl des Vertrags

Das Versicherungsmodul muss den betroffenen Vertrag aus der Vertragsübersicht vorschlagen.

Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten.

Abnahmekriterien:
- Die Funktion „Auswahl des Vertrags“ ist nach erfolgreicher Anmeldung innerhalb von 2 Sekunden erreichbar.
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.

Priorität: Muss
Quelle: Workshop Fachbereich vom 14.03.2026

###### REQ-FA-200 Plausibilitätsprüfung

Das Versicherungsmodul muss Angaben auf Vollständigkeit und Widersprüche prüfen, bevor
die Meldung abgeschlossen wird.

Priorität: Muss

Abnahmekriterien:
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 1.9.

###### REQ-FA-201 Schadennummer

Das Versicherungsmodul soll nach Abschluss unverzüglich eine eindeutige Schadennummer vergeben und anzeigen.

Priorität: Soll

Abnahmekriterien:
- Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-065.
- Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.

###### REQ-FA-202 Statusverfolgung des Schadens

Das Versicherungsmodul muss den Bearbeitungsstand mit den Schritten Eingang, Prüfung, Regulierung und Abschluss darstellen.

Abnahmekriterien:
- Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-295.
- Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.

Priorität: Muss

###### REQ-FA-203 Rückfragen des Sachbearbeiters

Das Versicherungsmodul soll Rückfragen der Sachbearbeitung im Portal beantwortbar machen. Die Regelung gilt in Verbindung mit NFA-AVL-001. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung.

Priorität: Soll

Abnahmekriterien:
- Ein Test mit 500 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,5 Prozent.
- Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-140.
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
- Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.

###### REQ-FA-204 Gutachtertermin

Das Versicherungsmodul muss einen Termin mit dem Gutachter im Portal vereinbaren und ändern lassen.

Priorität: Muss
Status: Freigegeben

Abnahmekriterien:
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
- Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
- Ein Test mit 50 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 1 Prozent.

###### REQ-FA-205 Auszahlung der Entschädigung

Das Versicherungsmodul soll die Auszahlung der Entschädigung auf das hinterlegte Konto anstoßen und im Portal bestätigen. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung.

Priorität: Soll

Abnahmekriterien:
- Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 2.0.

###### REQ-FA-206 Betrugsindikatoren

Das Versicherungsmodul soll auffällige Schadenmeldungen nach festgelegten Regeln zur gesonderten Prüfung markieren. Die Angaben stammen aus dem Kernbanksystem und werden nicht lokal dupliziert.

Hinweis: Für Firmenkunden gelten abweichende Rahmenwerte, die im Vertrag geregelt sind.
Priorität: Soll
Status: In Abstimmung

Abnahmekriterien:
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.

## 4 Nichtfunktionale Anforderungen

### 4.1 Leistung und Skalierung

#### 4.1.1 Antwortzeiten

##### 4.1.1.1 Antwortzeiten im Normalbetrieb

###### NFA-PERF-001 Antwortzeit der Startseite

Das System muss die Startseite nach der Anmeldung im 95. Perzentil in höchstens 1,5 Sekunden vollständig darstellen. Die Verarbeitung ist für den Kunden spätestens nach 8 Sekunden abgeschlossen. Die Regelung gilt in Verbindung mit REQ-FA-193.

Priorität: Muss
Jira: KRED-294

Abnahmekriterien:
1. Die Funktion „Antwortzeit der Startseite“ ist nach erfolgreicher Anmeldung innerhalb von 1 Sekunden erreichbar.
2. Ein Test mit 1000 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,1 Prozent.

###### NFA-PERF-002 Antwortzeit der Umsatzliste

Das System muss die Umsatzliste mit 50 Einträgen im 95. Perzentil in höchstens 800 Millisekunden ausliefern. Die Funktion steht in der mobilen App und im Browser mit gleichem Funktionsumfang zur Verfügung. Die Verarbeitung ist für den Kunden spätestens nach 3 Sekunden abgeschlossen.

Priorität: Muss
Quelle: Betriebskonzept, Kapitel 5

Abnahmekriterien:
1. Ein Test mit 1000 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,5 Prozent.
2. Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
3. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.

###### NFA-PERF-003 Antwortzeit der Auftragserfassung

Das System soll die Bestätigung eines Zahlungsauftrags im 99. Perzentil in höchstens 2
Sekunden liefern.

Priorität: Soll

Abnahmekriterien:
1. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
2. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-774.
3. Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
4. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.

###### NFA-PERF-004 Antwortzeit der Suche

Das System soll Suchanfragen im Postfach im 95. Perzentil in höchstens 1 Sekunde
beantworten. Die Verarbeitung ist für den Kunden spätestens nach 9 Sekunden
abgeschlossen.

Priorität: Soll

Abnahmekriterien:
1. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
2. Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.

###### NFA-PERF-005 Zeit bis zur Interaktion (mobil)

Das System muss auf einem Mittelklasse-Smartphone im Mobilfunknetz den ersten bedienbaren Zustand in höchstens 3 Sekunden erreichen.

Priorität: Muss

###### NFA-PERF-006 Größe der Startseite

Das System kann die übertragene Datenmenge der Startseite auf höchstens 1,2 MB begrenzen. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung.

Abnahmekriterien:
1. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
2. Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
3. Die Funktion „Größe der Startseite“ ist nach erfolgreicher Anmeldung innerhalb von 4 Sekunden erreichbar.
4. Die Darstellung entspricht dem freigegebenen Entwurf in Version 3.0.
5. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
6. Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-105.

Hinweis: Für Firmenkunden gelten abweichende Rahmenwerte, die im Vertrag geregelt sind.
Priorität: Kann
Quelle: Regulatorik-Katalog 2026, Abschnitt 7

###### NFA-PERF-007 Dateiimport

Das System kann eine Zahlungsdatei mit 10.000 Positionen in höchstens 60 Sekunden einlesen und prüfen.

Priorität: Kann
Quelle: Fachkonzept Zahlungsverkehr, Kapitel 4
Jira: KRED-162

Abnahmekriterien:
1. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
2. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.

###### NFA-PERF-008 Batch-Fenster

Das System soll alle nächtlichen Verarbeitungsläufe bis 05:00 Uhr abschließen. Die
Funktion steht in der mobilen App und im Browser mit gleichem Funktionsumfang zur
Verfügung. Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind
gesondert ausgewiesen.

Hinweis: Der Fachbereich bewertet die Anforderung als wettbewerbsrelevant.
Priorität: Soll
Jira: KRED-84

Abnahmekriterien:
1. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
2. Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
3. Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-164.

#### 4.1.2 Last und Kapazität

##### 4.1.2.1 Lastprofile

NFA-PERF-009: Gleichzeitige Nutzer

Das System muss mindestens 25.000 gleichzeitig angemeldete Kunden bedienen. Die Funktion steht in der mobilen App und im Browser mit gleichem Funktionsumfang zur Verfügung.

Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe SCH-IF-026).

Priorität: Muss
Abhängigkeiten: NFA-PERF-007, REQ-FA-163
Jira: KRED-40

Abnahmekriterien:
- Die Abnahme berücksichtigt die Wechselwirkung mit NFA-PERF-013.
- Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.

NFA-PERF-010: Spitzenlast zum Monatsende

Das System soll am Monatsende bis zu 400 Zahlungsaufträge pro Sekunde annehmen.

Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe SCH-IF-013).

Priorität: Soll
Quelle: Fachkonzept Zahlungsverkehr, Kapitel 4

Abnahmekriterien:
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 4.7.
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
- Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
- Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.

NFA-PERF-011: Lastspitzen zu Gehaltseingang

Das System soll die Anzahl der Transaktionen am Gehaltstag um den Faktor drei gegenüber dem Mittel verkraften.

Abnahmekriterien:
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.

Priorität: Soll
Quelle: Fachkonzept Zahlungsverkehr, Kapitel 4

NFA-PERF-012: Horizontale Skalierung

Das System muss bei steigender Last automatisch weitere Instanzen zuschalten. Die Angaben stammen aus dem Kernbanksystem und werden nicht lokal dupliziert. Die Verarbeitung ist für den Kunden spätestens nach 9 Sekunden abgeschlossen.

Priorität: Muss
Abhängigkeiten: ABN-45.5, REQ-FA-014

Abnahmekriterien:
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.

NFA-PERF-013: Rückbau bei sinkender Last

Das System muss ungenutzte Instanzen nach 15 Minuten geringer Auslastung wieder abbauen.

Die Angaben stammen aus dem Kernbanksystem und werden nicht lokal dupliziert.

Hinweis: Der Fachbereich bewertet die Anforderung als wettbewerbsrelevant.
Priorität: Muss

Abnahmekriterien:
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
- Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
- Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.

NFA-PERF-014: Datenwachstum

Das System kann ein jährliches Datenwachstum von 40 Prozent ohne Architekturänderung bewältigen. Die Verarbeitung ist für den Kunden spätestens nach 5 Sekunden abgeschlossen. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten.

Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten.

Priorität: Kann

Abnahmekriterien:
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
- Die Funktion „Datenwachstum“ ist nach erfolgreicher Anmeldung innerhalb von 1 Sekunden erreichbar.
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.

NFA-PERF-015: Lasttest vor Freigabe

Das System muss vor jeder Hauptversion einen Lasttest mit 150 Prozent der erwarteten Spitzenlast bestehen.

Hinweis: Für Firmenkunden gelten abweichende Rahmenwerte, die im Vertrag geregelt sind.
Priorität: Muss
Quelle: Sicherheitskonzept, Kapitel 3
Abhängigkeiten: REQ-FA-030, REQ-FA-120

Abnahmekriterien:
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
- Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-156.
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.

NFA-PERF-016: Begrenzung je Client

Das System soll Anfragen je Client auf 100 pro Minute begrenzen.

Priorität: Soll

Abnahmekriterien:
- Die Funktion „Begrenzung je Client“ ist nach erfolgreicher Anmeldung innerhalb von 4 Sekunden erreichbar.
- Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.

### 4.2 Verfügbarkeit und Betrieb

#### 4.2.1 Verfügbarkeit

##### 4.2.1.1 Verfügbarkeitsziele

###### NFA-AVL-001 Verfügbarkeit des Portals

Das System muss eine Verfügbarkeit von 99,9 Prozent je Kalendermonat erreichen.

Priorität: Muss
Quelle: Workshop Fachbereich vom 14.03.2026

###### NFA-AVL-002 Verfügbarkeit des Zahlungsverkehrs

Das System kann die Annahme von Echtzeitüberweisungen mit 99,95 Prozent Verfügbarkeit
betreiben.

Priorität: Kann

Abnahmekriterien:
1. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
2. Die Funktion „Verfügbarkeit des Zahlungsverkehrs“ ist nach erfolgreicher Anmeldung innerhalb von 4 Sekunden erreichbar.
3. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
4. Die Darstellung entspricht dem freigegebenen Entwurf in Version 4.6.
5. Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
6. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.

###### NFA-AVL-003 Wartungsfenster

Das System muss geplante Wartungen auf höchstens vier Stunden pro Monat in der Nacht von Sonntag auf Montag beschränken. Die Angaben stammen aus dem Kernbanksystem und werden nicht lokal dupliziert.

Priorität: Muss
Jira: KRED-382

Abnahmekriterien:
1. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
2. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
3. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
4. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
5. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.

###### NFA-AVL-004 Ankündigung von Wartungen

Das System kann geplante Wartungen mindestens fünf Werktage vorher im Portal ankündigen. Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe ABN-45.8).

Priorität: Kann

Abnahmekriterien:
1. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
2. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.

###### NFA-AVL-005 Wiederanlaufzeit (RTO)

Das System soll nach einem Ausfall des Rechenzentrums den Betrieb innerhalb von 60 Minuten wiederherstellen.

Priorität: Soll

Abnahmekriterien:
1. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.

###### NFA-AVL-006 Datenverlust (RPO)

Das System soll bei einem Ausfall höchstens fünf Minuten an bestätigten Transaktionen verlieren.

Priorität: Soll
Status: In Abstimmung

###### NFA-AVL-007 Georedundanz

Das System soll alle Dienste in zwei räumlich getrennten Rechenzentren betreiben. Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert ausgewiesen.

Hinweis: Die Umsetzung erfolgt in der zweiten Ausbaustufe des Portals.
Priorität: Soll
Quelle: Sicherheitskonzept, Kapitel 3

Abnahmekriterien:
1. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-268.
2. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
3. Die Darstellung entspricht dem freigegebenen Entwurf in Version 1.0.
4. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
5. Die Abnahme berücksichtigt die Wechselwirkung mit SCH-IF-010.

###### NFA-AVL-008 Degradierter Betrieb

Das System kann bei Ausfall nachgelagerter Systeme die Anzeige der Konten und Umsätze aus dem Zwischenspeicher fortsetzen. Die Funktion steht in der mobilen App und im Browser mit gleichem Funktionsumfang zur Verfügung.

Priorität: Kann

Abnahmekriterien:
1. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
2. Ein Test mit 500 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,5 Prozent.
3. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
4. Die Abnahme berücksichtigt die Wechselwirkung mit SCH-IF-025.
5. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
6. Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.

#### 4.2.2 Betrieb und Überwachung

##### 4.2.2.1 Monitoring und Alarmierung

NFA-OPS-001: Technisches Monitoring

Der Betrieb muss alle Dienste mit Metriken zu Latenz, Fehlerrate und Auslastung überwachen. Die Funktion steht in der mobilen App und im Browser mit gleichem Funktionsumfang zur Verfügung. Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert ausgewiesen.

Die Angaben stammen aus dem Kernbanksystem und werden nicht lokal dupliziert.

Abnahmekriterien:
- Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
- Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.

Prio: Muss
Quelle: Workshop Fachbereich vom 14.03.2026

NFA-OPS-002: Fachliches Monitoring

Der Betrieb soll fachliche Kennzahlen wie die Zahl erfolgreicher Anmeldungen und Zahlungen minütlich erfassen. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten. Die Verarbeitung ist für den Kunden spätestens nach 4 Sekunden abgeschlossen.

Hinweis: Die fachliche Abstimmung mit der Rechtsabteilung ist noch ausstehend.
Prio: Soll

Abnahmekriterien:
- Die Funktion „Fachliches Monitoring“ ist nach erfolgreicher Anmeldung innerhalb von 1 Sekunden erreichbar.
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 2.8.
- Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-348.

NFA-OPS-003: Alarmierung

Der Betrieb muss bei Überschreitung der Schwellwerte den Bereitschaftsdienst innerhalb von zwei Minuten alarmieren.

Die Abgrenzung zu den Vorgaben des Kernbanksystems ist in REQ-FA-073 beschrieben.

Prio: Muss
Jira: KRED-100

NFA-OPS-004: Zentrale Protokollierung

Der Betrieb soll alle Protokolle der Dienste zentral sammeln und 13 Monate vorhalten. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten. Die Funktion steht in der mobilen App und im Browser mit gleichem Funktionsumfang zur Verfügung.

Prio: Soll
Quelle: Regulatorik-Katalog 2026, Abschnitt 7
Abhängigkeiten: MIG_ROL-001, SCH-IF-030

Abnahmekriterien:
- Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
- Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
- Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-174.

NFA-OPS-005: Korrelations-ID

Der Betrieb muss jede Anfrage mit einer Korrelations-ID über alle beteiligten Dienste verfolgen. Die Funktion steht in der mobilen App und im Browser mit gleichem Funktionsumfang zur Verfügung. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten.

Prio: Muss
Quelle: Workshop Fachbereich vom 14.03.2026
Status: In Abstimmung

Abnahmekriterien:
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 1.2.
- Die Abnahme berücksichtigt die Wechselwirkung mit NFA-REG-005.
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.

NFA-OPS-006: Dashboards

Der Betrieb muss für Betrieb und Fachbereich getrennte Dashboards bereitstellen. Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert ausgewiesen.

Abnahmekriterien:
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 1.5.
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.

Prio: Muss
Jira: KRED-39

NFA-OPS-007: Störungsmanagement

Der Betrieb muss Störungen nach den Prioritäten 1 bis 4 mit definierten Reaktionszeiten behandeln. Die Regelung gilt in Verbindung mit NFA-REG-005.

Die Angaben stammen aus dem Kernbanksystem und werden nicht lokal dupliziert.

Abnahmekriterien:
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 1.2.
- Ein Test mit 50 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,1 Prozent.
- Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
- Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
- Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-173.

Prio: Muss

NFA-OPS-008: Post-Mortem

Der Betrieb soll für jede Störung der Priorität 1 innerhalb von fünf Werktagen eine Nachbetrachtung erstellen. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung.

Abnahmekriterien:
- Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.

Prio: Soll

### 4.3 Sicherheit

#### 4.3.1 Zugriff und Verschlüsselung

##### 4.3.1.1 Transport- und Datenverschlüsselung

###### NFA-SEC-001 Transportverschlüsselung

Das System muss alle externen Verbindungen ausschließlich mit TLS 1.2 oder höher absichern. Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert ausgewiesen.

Abnahmekriterien:
1. Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
2. Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.

Priorität: Muss
Quelle: Sicherheitskonzept, Kapitel 3
Abhängigkeiten: REQ-FA-051, REQ-FA-149

###### NFA-SEC-002 Perfect Forward Secrecy

Das System soll nur Cipher-Suites mit Perfect Forward Secrecy zulassen.

Priorität: Soll
Quelle: Fachkonzept Kundenportal, Kapitel 2
Jira: KRED-267

Abnahmekriterien:
1. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
2. Ein Test mit 200 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 1 Prozent.
3. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
4. Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
5. Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-086.
6. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.

###### NFA-SEC-003 Verschlüsselung gespeicherter Daten

Das System soll personenbezogene Daten im Ruhezustand mit AES-256 verschlüsseln.

Priorität: Soll

Abnahmekriterien:
1. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.

###### NFA-SEC-004 Schlüsselverwaltung

Das System muss kryptographische Schlüssel in einem zertifizierten
Hardware-Sicherheitsmodul erzeugen und speichern. Die Angaben stammen aus dem
Kernbanksystem und werden nicht lokal dupliziert. Fehlerhafte Eingaben werden dem Nutzer
verständlich und ohne technische Fehlercodes angezeigt.

Die Regelung gilt in Verbindung mit REQ-FA-036.

Hinweis: Die Umsetzung erfolgt in der zweiten Ausbaustufe des Portals.
Priorität: Muss
Jira: KRED-120

###### NFA-SEC-005 Schlüsselrotation

Das System muss Schlüssel mindestens jährlich und bei Verdacht auf Kompromittierung sofort wechseln.

Hinweis: Die technische Machbarkeit wurde im Architekturboard bestätigt.
Priorität: Muss
Quelle: Betriebskonzept, Kapitel 5
Jira: KRED-226

Abnahmekriterien:
1. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.

###### NFA-SEC-006 Hashing von Passwörtern

Das System kann Passwörter nur mit einem adaptiven Hashverfahren und individuellem Salt speichern. Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert ausgewiesen.

Priorität: Kann
Quelle: Workshop Fachbereich vom 14.03.2026

Abnahmekriterien:
1. Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
2. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
3. Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.

###### NFA-SEC-007 Zertifikatsverwaltung

Das System kann Zertifikate vor Ablauf automatisch erneuern und den Ablauf 30 Tage vorher überwachen.

Abnahmekriterien:
1. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
2. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-641.
3. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.

Priorität: Kann

###### NFA-SEC-008 Sichere HTTP-Header

Das System kann alle Antworten mit Sicherheits-Headern wie HSTS und Content-Security-Policy ausliefern. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten.

Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe REQ-FA-079).

Priorität: Kann
Quelle: Workshop Fachbereich vom 14.03.2026

Abnahmekriterien:
1. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
2. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
3. Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
4. Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
5. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
6. Ein Test mit 1000 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,1 Prozent.

##### 4.3.1.2 Rollen und Berechtigungen

NFA-SEC-009: Rollenbasierte Zugriffssteuerung

Das System soll den Zugriff auf Funktionen und Daten ausschließlich über Rollen steuern.
Die Funktion steht in der mobilen App und im Browser mit gleichem Funktionsumfang zur
Verfügung. Die Verarbeitung ist für den Kunden spätestens nach 3 Sekunden abgeschlossen.

Priorität: Soll
Abhängigkeiten: NFA-OPS-006, REQ-FA-080

Abnahmekriterien:
- Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
- Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-731.
- Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.

NFA-SEC-010: Prinzip der minimalen Rechte

Das System muss jedem Benutzer und Dienst nur die für die Aufgabe notwendigen Rechte
erteilen. Die Regelung gilt in Verbindung mit SCH-IF-025.

Priorität: Muss
Status: Zur Prüfung

Abnahmekriterien:
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 4.6.
- Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-546.
- Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-142.

NFA-SEC-011: Funktionstrennung

Das System kann kritische Rollen wie Erfassung und Freigabe nie derselben Person zuweisen. Die Regelung gilt in Verbindung mit SCH-IF-036. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung.

Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten.

Priorität: Kann

Abnahmekriterien:
- Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
- Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 1.7.

NFA-SEC-012: Rezertifizierung

Das System soll die Berechtigungen aller Mitarbeiter halbjährlich durch die Vorgesetzten bestätigen lassen. Die Angaben stammen aus dem Kernbanksystem und werden nicht lokal dupliziert. Die Abgrenzung zu den Vorgaben des Kernbanksystems ist in REQ-FA-116 beschrieben.

Priorität: Soll

Abnahmekriterien:
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.

NFA-SEC-013: Privilegierte Zugriffe

Das System soll administrative Zugriffe nur über eine Sitzungsaufzeichnung mit Vier-Augen-Prinzip gewähren.

Abnahmekriterien:
- Ein Test mit 200 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,1 Prozent.
- Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-836.
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
- Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
- Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.

Priorität: Soll

NFA-SEC-014: Entzug bei Austritt

Das System muss Berechtigungen ausscheidender Mitarbeiter am letzten Arbeitstag entziehen. Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt.

Hinweis: Die Umsetzung erfolgt in der zweiten Ausbaustufe des Portals.
Priorität: Muss

Abnahmekriterien:
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
- Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
- Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.

NFA-SEC-015: Dienstkonten

Das System soll technische Dienstkonten mit Besitzer, Zweck und Ablaufdatum führen. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung.

Priorität: Soll

NFA-SEC-016: Mandantentrennung

Das System kann Daten verschiedener Mandanten logisch trennen und Zugriffe über Mandantengrenzen verhindern. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung. Die Regelung gilt in Verbindung mit REQ-FA-129.

Abnahmekriterien:
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.

Priorität: Kann
Quelle: Betriebskonzept, Kapitel 5

#### 4.3.2 Schutz vor Angriffen

##### 4.3.2.1 Anwendungssicherheit

###### NFA-SEC-017 Schutz vor Injection

Das System kann alle Eingaben serverseitig validieren und Datenbankzugriffe
ausschließlich parametrisiert ausführen. Die Funktion steht in der mobilen App und im
Browser mit gleichem Funktionsumfang zur Verfügung. Die Angaben stammen aus dem
Kernbanksystem und werden nicht lokal dupliziert.

Priorität: Kann
Status: Zur Prüfung
Jira: KRED-225

Abnahmekriterien:
1. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
2. Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
3. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
4. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
5. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.

###### NFA-SEC-018 Schutz vor Cross-Site-Scripting

Das System muss Ausgaben kontextabhängig kodieren und eingebettete Skripte durch eine
Content-Security-Policy unterbinden.

Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert ausgewiesen.

Priorität: Muss
Quelle: Fachkonzept Kundenportal, Kapitel 2
Abhängigkeiten: NFA-SEC-021, REQ-FA-049

Abnahmekriterien:
1. Ein Test mit 50 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,1 Prozent.
2. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-473.
3. Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.

###### NFA-SEC-019 Schutz vor CSRF

Das System kann zustandsändernde Anfragen durch ein Token gegen Cross-Site-Request-Forgery absichern.

Hinweis: Die fachliche Abstimmung mit der Rechtsabteilung ist noch ausstehend.
Priorität: Kann
Abhängigkeiten: BET-SLA-006, MIG_ROL-005

Abnahmekriterien:
1. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-569.
2. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
3. Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.

###### NFA-SEC-020 Ratenbegrenzung

Das System soll wiederholte Anmeldeversuche je Konto und Quelladresse begrenzen. Die Abgrenzung zu den Vorgaben des Kernbanksystems ist in REQ-FA-145 beschrieben.

Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung.

Abnahmekriterien:
1. Die Funktion „Ratenbegrenzung“ ist nach erfolgreicher Anmeldung innerhalb von 2 Sekunden erreichbar.
2. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
3. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
4. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.

Priorität: Soll
Quelle: Regulatorik-Katalog 2026, Abschnitt 7

###### NFA-SEC-021 Web Application Firewall

Das System muss alle öffentlichen Endpunkte hinter einer Web Application Firewall betreiben. Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe REQ-FA-068).

Priorität: Muss
Quelle: Sicherheitskonzept, Kapitel 3

Abnahmekriterien:
1. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
2. Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
3. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
4. Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.

###### NFA-SEC-022 Schutz vor Bots

Das System kann automatisierte Zugriffe erkennen und mit angemessenen Mitteln abwehren, ohne Barrierefreiheit einzuschränken. Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten.

Priorität: Kann

Abnahmekriterien:
1. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-155.
2. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.

###### NFA-SEC-023 Abwehr von DDoS

Das System muss volumetrische Angriffe durch einen vorgelagerten Schutzdienst abwehren. Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert ausgewiesen.

Hinweis: Für Firmenkunden gelten abweichende Rahmenwerte, die im Vertrag geregelt sind.
Priorität: Muss
Quelle: Workshop Fachbereich vom 14.03.2026
Status: Zur Prüfung

Abnahmekriterien:
1. Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
2. Die Darstellung entspricht dem freigegebenen Entwurf in Version 3.4.
3. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-524.
4. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
5. Ein Test mit 50 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,5 Prozent.

###### NFA-SEC-024 Schwachstellenmanagement

Das System muss kritische Schwachstellen in Komponenten innerhalb von sieben Tagen beheben. Die Funktion steht in der mobilen App und im Browser mit gleichem Funktionsumfang zur Verfügung. Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe REQ-FA-143).

Priorität: Muss
Jira: KRED-328

###### NFA-SEC-025 Penetrationstest

Das System kann vor jeder Hauptversion einen Penetrationstest durch eine unabhängige Stelle durchführen lassen.

Hinweis: Für Firmenkunden gelten abweichende Rahmenwerte, die im Vertrag geregelt sind.
Priorität: Kann

Abnahmekriterien:
1. Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
2. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
3. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.

##### 4.3.2.2 Protokollierung und Nachvollziehbarkeit

NFA-SEC-026: Sicherheitsrelevante Ereignisse

Das System muss Anmeldungen, Berechtigungsänderungen und Zahlungsfreigaben revisionssicher protokollieren. Die Abgrenzung zu den Vorgaben des Kernbanksystems ist in NFA-DSG-006 beschrieben. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung.

Priorität: Muss
Abhängigkeiten: BET-SLA-007, REQ-FA-021

Abnahmekriterien:
- Ein Test mit 200 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 1 Prozent.
- Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-394.
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
- Die Abnahme berücksichtigt die Wechselwirkung mit NFA-OPS-008.

NFA-SEC-027: Schutz der Protokolle

Das System kann Protokolle gegen nachträgliche Änderung und Löschung schützen. Die
Angaben stammen aus dem Kernbanksystem und werden nicht lokal dupliziert.

Abnahmekriterien:
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.

Priorität: Kann
Quelle: Betriebskonzept, Kapitel 5

NFA-SEC-028: Keine Geheimnisse im Protokoll

Das System soll Passwörter, Einmalcodes und vollständige Kartennummern niemals in Protokolle schreiben. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung. Die Verarbeitung ist für den Kunden spätestens nach 5 Sekunden abgeschlossen.

Abnahmekriterien:
- Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.

Priorität: Soll

NFA-SEC-029: Zeitsynchronisation

Das System soll alle Systeme auf eine gemeinsame, abgesicherte Zeitquelle synchronisieren.

Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt.

Priorität: Soll
Status: Freigegeben

Abnahmekriterien:
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.

NFA-SEC-030: Auswertung durch das SIEM

Das System soll sicherheitsrelevante Ereignisse in Echtzeit an das zentrale SIEM übertragen. Die Verarbeitung ist für den Kunden spätestens nach 8 Sekunden abgeschlossen.

Priorität: Soll

Abnahmekriterien:
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 4.7.
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.

NFA-SEC-031: Aufbewahrungsdauer

Das System soll Sicherheitsprotokolle mindestens 24 Monate vorhalten. Die Abgrenzung zu den Vorgaben des Kernbanksystems ist in SCH-IF-009 beschrieben. Die Angaben stammen aus dem Kernbanksystem und werden nicht lokal dupliziert.

Priorität: Soll
Quelle: Betriebskonzept, Kapitel 5
Jira: KRED-106

Abnahmekriterien:
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
- Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-199.

NFA-SEC-032: Manipulationsnachweis

Das System kann die Integrität der Protokolle durch kryptographische Verkettung nachweisbar machen. Die Abgrenzung zu den Vorgaben des Kernbanksystems ist in REQ-FA-193 beschrieben. Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert ausgewiesen.

Priorität: Kann
Quelle: Workshop Fachbereich vom 14.03.2026

Abnahmekriterien:
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 1.8.

### 4.4 Datenschutz und Compliance

#### 4.4.1 Datenschutz

##### 4.4.1.1 Datenschutz durch Technikgestaltung

###### NFA-DSG-001 Datenminimierung

Das System muss nur diejenigen personenbezogenen Daten erheben, die für den jeweiligen Zweck erforderlich sind. Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt. Die Funktion steht in der mobilen App und im Browser mit gleichem Funktionsumfang zur Verfügung.

Priorität: Muss
Quelle: Workshop Fachbereich vom 14.03.2026

###### NFA-DSG-002 Löschkonzept

Das System kann für jede Datenart eine Aufbewahrungsfrist hinterlegen und Daten nach Fristende automatisch löschen.

Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung.

Abnahmekriterien:
1. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
2. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
3. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
4. Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
5. Die Funktion „Löschkonzept“ ist nach erfolgreicher Anmeldung innerhalb von 4 Sekunden erreichbar.

Priorität: Kann
Quelle: Fachkonzept Zahlungsverkehr, Kapitel 4

###### NFA-DSG-003 Pseudonymisierung in Testumgebungen

Das System muss in Test- und Entwicklungsumgebungen ausschließlich pseudonymisierte oder synthetische Daten verwenden. Die Angaben stammen aus dem Kernbanksystem und werden nicht lokal dupliziert. Die Verarbeitung ist für den Kunden spätestens nach 2 Sekunden abgeschlossen.

Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt.

Priorität: Muss
Quelle: Regulatorik-Katalog 2026, Abschnitt 7

Abnahmekriterien:
1. Ein Test mit 1000 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,5 Prozent.
2. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
3. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-825.

###### NFA-DSG-004 Verzeichnis der Verarbeitungstätigkeiten

Das System muss zu jeder Verarbeitung Zweck, Rechtsgrundlage und Empfänger im Verzeichnis dokumentieren. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung. Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe REQ-FA-188).

Priorität: Muss

Abnahmekriterien:
1. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-188.
2. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
3. Ein Test mit 200 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 1 Prozent.

###### NFA-DSG-005 Auftragsverarbeitung

Das System soll Auftragsverarbeiter nur mit abgeschlossener Vereinbarung nach Artikel 28
DSGVO einsetzen. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus
der zentralen Textverwaltung. Die Angaben stammen aus dem Kernbanksystem und werden
nicht lokal dupliziert.

Priorität: Soll
Abhängigkeiten: NFA-SEC-032, SCH-IF-003

Abnahmekriterien:
1. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
2. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
3. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.

###### NFA-DSG-006 Datenverarbeitung in der EU

Das System kann personenbezogene Daten ausschließlich in Rechenzentren innerhalb der Europäischen Union verarbeiten.

Priorität: Kann

Abnahmekriterien:
1. Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
2. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-123.
3. Die Darstellung entspricht dem freigegebenen Entwurf in Version 2.1.
4. Ein Test mit 50 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,1 Prozent.
5. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
6. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.

###### NFA-DSG-007 Meldung von Datenschutzverletzungen

Das System kann Datenschutzverletzungen innerhalb von 72 Stunden an die Aufsichtsbehörde
melden können. Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen
sind gesondert ausgewiesen. Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten
gilt ergänzend (siehe NFA-UX-014).

Priorität: Kann

Abnahmekriterien:
1. Die Darstellung entspricht dem freigegebenen Entwurf in Version 4.9.

###### NFA-DSG-008 Datenschutz-Folgenabschätzung

Das System muss vor Einführung neuer Verarbeitungen mit hohem Risiko eine Folgenabschätzung durchführen. Die Regelung gilt in Verbindung mit NFA-UX-001. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung.

Priorität: Muss

Abnahmekriterien:
1. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
2. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
3. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.

#### 4.4.2 Regulatorik

##### 4.4.2.1 Aufsichtsrechtliche Vorgaben

| ID | Titel | Anforderung | Priorität |
| --- | --- | --- | --- |
| NFA-REG-001 | Geldwäscheprävention | Das System muss Transaktionen nach den Vorgaben des Geldwäschegesetzes überwachen und Verdachtsfälle melden. Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt. | Muss |
| NFA-REG-002 | Kundenidentifizierung | Das System muss Kunden vor Aufnahme der Geschäftsbeziehung nach dem Geldwäschegesetz identifizieren. Die Funktion steht in der mobilen App und im Browser mit gleichem Funktionsumfang zur Verfügung. | Muss |
| NFA-REG-003 | Einhaltung von DORA | Das System kann die Anforderungen der Verordnung über die digitale operationale Resilienz für IKT-Risiken umsetzen. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung. | Kann |
| NFA-REG-004 | BAIT und MaRisk | Das System muss die bankaufsichtlichen Anforderungen an die IT in Dokumentation und Betrieb nachweisen. Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert ausgewiesen. | Muss |
| NFA-REG-005 | Auslagerungssteuerung | Das System soll wesentliche Auslagerungen mit Prüf- und Kündigungsrechten vertraglich absichern. Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert ausgewiesen. | Soll |
| NFA-REG-006 | Meldung schwerwiegender Vorfälle | Das System soll schwerwiegende IKT-Vorfälle fristgerecht an die Aufsicht melden. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung. | Soll |
| NFA-REG-007 | Aufbewahrung nach HGB und AO | Das System muss buchungsrelevante Unterlagen für zehn Jahre aufbewahren. Die Angaben stammen aus dem Kernbanksystem und werden nicht lokal dupliziert. | Muss |
| NFA-REG-008 | Transparenz nach Preisangabenverordnung | Das System muss Entgelte vor Auftragserteilung vollständig ausweisen. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten. | Muss |

### 4.5 Bedienbarkeit und Barrierefreiheit

#### 4.5.1 Barrierefreiheit

##### 4.5.1.1 Zugänglichkeit

###### NFA-UX-001 WCAG-Konformität

Das Kundenportal soll die Erfolgskriterien der WCAG 2.1 Stufe AA erfüllen.

Priorität: Soll

Abnahmekriterien:
1. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.

###### NFA-UX-002 Bedienung per Tastatur

Das Kundenportal soll alle Funktionen ohne Maus bedienbar machen. Die Funktion steht in der mobilen App und im Browser mit gleichem Funktionsumfang zur Verfügung. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung.

Abnahmekriterien:
1. Die Funktion „Bedienung per Tastatur“ ist nach erfolgreicher Anmeldung innerhalb von 2 Sekunden erreichbar.
2. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
3. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.

Hinweis: Die fachliche Abstimmung mit der Rechtsabteilung ist noch ausstehend.
Priorität: Soll

###### NFA-UX-003 Screenreader-Unterstützung

Das Kundenportal soll alle Bedienelemente mit sinnvollen Beschriftungen für Screenreader versehen. Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung.

Priorität: Soll
Status: Freigegeben

Abnahmekriterien:
1. Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-072.
2. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
3. Die Darstellung entspricht dem freigegebenen Entwurf in Version 4.0.
4. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-364.

###### NFA-UX-004 Kontraste

Das Kundenportal muss ein Kontrastverhältnis von mindestens 4,5 zu 1 für Text einhalten. Die Angaben stammen aus dem Kernbanksystem und werden nicht lokal dupliziert.

Priorität: Muss

Abnahmekriterien:
1. Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
2. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.

###### NFA-UX-005 Skalierbare Schrift

Das Kundenportal soll bei einer Vergrößerung der Schrift auf 200 Prozent ohne Verlust von Inhalten und Funktionen bedienbar bleiben.

Hinweis: Für Firmenkunden gelten abweichende Rahmenwerte, die im Vertrag geregelt sind.
Priorität: Soll
Abhängigkeiten: MIG_ROL-002, REQ-FA-143

Abnahmekriterien:
1. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
2. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.

###### NFA-UX-006 Einfache Sprache

Das Kundenportal muss wesentliche Informationen zusätzlich in einfacher Sprache anbieten. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten.

Hinweis: Die Umsetzung erfolgt in der zweiten Ausbaustufe des Portals.
Priorität: Muss

Abnahmekriterien:
1. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
2. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
3. Die Funktion „Einfache Sprache“ ist nach erfolgreicher Anmeldung innerhalb von 2 Sekunden erreichbar.

###### NFA-UX-007 Fehlermeldungen

Das Kundenportal kann Fehler nicht allein durch Farbe, sondern auch durch Text und Symbol kennzeichnen. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung.

Priorität: Kann

Abnahmekriterien:
1. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-334.
2. Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-191.

###### NFA-UX-008 Zeitlimits

Das Kundenportal soll bei Zeitlimits die Verlängerung ohne Datenverlust ermöglichen.
Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert
ausgewiesen.

Priorität: Soll

Abnahmekriterien:
1. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-561.
2. Die Funktion „Zeitlimits“ ist nach erfolgreicher Anmeldung innerhalb von 4 Sekunden erreichbar.
3. Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.

#### 4.5.2 Benutzerführung

##### 4.5.2.1 Oberfläche und Sprache

NFA-UX-009: Responsives Layout

Das Kundenportal soll auf Bildschirmbreiten von 320 bis 2560 Pixeln ohne horizontales Scrollen nutzbar sein.

Hinweis: Die Umsetzung erfolgt in der zweiten Ausbaustufe des Portals.
Priorität: Soll

Abnahmekriterien:
- Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-546.
- Ein Test mit 200 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 1 Prozent.

NFA-UX-010: Mehrsprachigkeit

Das Kundenportal soll die Oberfläche in Deutsch, Englisch und Türkisch anbieten. Die Abgrenzung zu den Vorgaben des Kernbanksystems ist in ABN-45.3 beschrieben.

Priorität: Soll
Jira: KRED-39

Abnahmekriterien:
- Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-143.
- Die Funktion „Mehrsprachigkeit“ ist nach erfolgreicher Anmeldung innerhalb von 1 Sekunden erreichbar.
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.

NFA-UX-011: Formatierung von Beträgen und Daten

Das Kundenportal kann Beträge und Datumsangaben nach der Spracheinstellung des Kunden formatieren. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten. Die Funktion steht in der mobilen App und im Browser mit gleichem Funktionsumfang zur Verfügung.

Hinweis: Die Umsetzung erfolgt in der zweiten Ausbaustufe des Portals.
Priorität: Kann
Quelle: Fachkonzept Zahlungsverkehr, Kapitel 4

Abnahmekriterien:
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
- Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
- Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-197.

NFA-UX-012: Konsistente Begriffe

Das Kundenportal muss für gleiche Sachverhalte durchgängig dieselben Begriffe aus dem Glossar verwenden. Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt.

Hinweis: Die technische Machbarkeit wurde im Architekturboard bestätigt.
Priorität: Muss
Quelle: Workshop Fachbereich vom 14.03.2026

Abnahmekriterien:
- Ein Test mit 500 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,5 Prozent.
- Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.

NFA-UX-013: Hilfe im Kontext

Das Kundenportal soll an komplexen Eingaben eine kurze Erläuterung anbieten.

Priorität: Soll
Status: In Abstimmung

Abnahmekriterien:
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
- Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-316.
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 1.4.

NFA-UX-014: Dunkler Modus

Das Kundenportal muss einen dunklen Darstellungsmodus anbieten.

Hinweis: Die technische Machbarkeit wurde im Architekturboard bestätigt.
Priorität: Muss

Abnahmekriterien:
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
- Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
- Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
- Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.

NFA-UX-015: Zuletzt verwendete Funktionen

Das Kundenportal soll die vom Kunden zuletzt genutzten Funktionen auf der Startseite verlinken. Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe SCH-IF-036). Die Angaben stammen aus dem Kernbanksystem und werden nicht lokal dupliziert.

Priorität: Soll

Abnahmekriterien:
- Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 1.2.

NFA-UX-016: Rückmeldung bei Aktionen

Das Kundenportal muss jede Aktion innerhalb von 200 Millisekunden sichtbar bestätigen.

Abnahmekriterien:
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 2.9.

Priorität: Muss

## 5 Schnittstellen

### 5.1 Innere Systeme

#### 5.1.1 Kernbanksystem

##### 5.1.1.1 Kontodaten und Buchungen

###### SCH-IF-001 Abfrage von Kontosalden

Die Schnittstelle zum Kernbanksystem kann Kontosalden synchron über eine
REST-Schnittstelle in höchstens 300 Millisekunden liefern. Die Regelung gilt in
Verbindung mit REQ-FA-014. Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt
ergänzend (siehe REQ-FA-031).

Hinweis: Für Firmenkunden gelten abweichende Rahmenwerte, die im Vertrag geregelt sind.
Priority: Could

Acceptance criteria:
1. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
2. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
3. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
4. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
5. Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.

###### SCH-IF-002 Abruf von Umsätzen

Die Schnittstelle zum Kernbanksystem soll Umsätze seitenweise mit Cursor und stabiler
Sortierung bereitstellen.

Priority: Should
Quelle: Regulatorik-Katalog 2026, Abschnitt 7

Acceptance criteria:
1. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-558.
2. Ein Test mit 1000 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,5 Prozent.
3. Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
4. Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.

###### SCH-IF-003 Buchung von Zahlungsaufträgen

Die Schnittstelle zum Kernbanksystem soll Zahlungsaufträge idempotent anhand einer Auftrags-ID entgegennehmen. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung.

Hinweis: Die Umsetzung erfolgt in der zweiten Ausbaustufe des Portals.
Priority: Should

Acceptance criteria:
1. Die Abnahme berücksichtigt die Wechselwirkung mit MIG_DAT-005.
2. Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
3. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.

###### SCH-IF-004 Fehlercodes

Die Schnittstelle zum Kernbanksystem muss Fehler mit einem fachlichen Fehlercode und einer Korrelations-ID beantworten. Die Regelung gilt in Verbindung mit REQ-FA-097.

Priority: Must

Acceptance criteria:
1. Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
2. Die Darstellung entspricht dem freigegebenen Entwurf in Version 3.1.

###### SCH-IF-005 Versionierung

Die Schnittstelle zum Kernbanksystem muss Änderungen an der Schnittstelle abwärtskompatibel über eine Versionsnummer im Pfad einführen.

Priority: Must

###### SCH-IF-006 Authentifizierung zwischen Diensten

Die Schnittstelle zum Kernbanksystem muss Aufrufe über gegenseitig authentifiziertes TLS
absichern. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der
zentralen Textverwaltung. Die Regelung gilt in Verbindung mit REQ-FA-198.

Priority: Must
Quelle: Fachkonzept Zahlungsverkehr, Kapitel 4

###### SCH-IF-007 Zeitüberschreitung

Die Schnittstelle zum Kernbanksystem muss Aufrufe nach spätestens drei Sekunden mit einem definierten Fehler abbrechen.

Priority: Must
Quelle: Betriebskonzept, Kapitel 5

Acceptance criteria:
1. Die Funktion „Zeitüberschreitung“ ist nach erfolgreicher Anmeldung innerhalb von 1 Sekunden erreichbar.
2. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
3. Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.

###### SCH-IF-008 Wiederholbarkeit

Die Schnittstelle zum Kernbanksystem soll bei vorübergehenden Fehlern Wiederholungen mit exponentiellem Backoff erlauben.

Priority: Should
Quelle: Fachkonzept Zahlungsverkehr, Kapitel 4

Acceptance criteria:
1. Die Funktion „Wiederholbarkeit“ ist nach erfolgreicher Anmeldung innerhalb von 4 Sekunden erreichbar.
2. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
3. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
4. Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
5. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
6. Ein Test mit 200 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,5 Prozent.

#### 5.1.2 Dokumenten- und Archivsystem

##### 5.1.2.1 Dokumentenablage

SCH-IF-009: Ablage von Dokumenten

Die Schnittstelle zum Archivsystem muss Dokumente mit Metadaten zu Kunde, Dokumentart
und Aufbewahrungsfrist entgegennehmen. Die Regelung gilt in Verbindung mit REQ-FA-156.
Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll
festgehalten.

Priority: Muss

Acceptance criteria:
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
- Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
- Die Funktion „Ablage von Dokumenten“ ist nach erfolgreicher Anmeldung innerhalb von 1 Sekunden erreichbar.

SCH-IF-010: Abruf von Dokumenten

Die Schnittstelle zum Archivsystem muss Dokumente anhand der Dokumenten-ID in höchstens
einer Sekunde ausliefern. Die Verarbeitung ist für den Kunden spätestens nach 4 Sekunden
abgeschlossen.

Priority: Muss
Abhängigkeiten: NFA-OPS-003, NFA-PERF-011

Acceptance criteria:
- Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
- Die Funktion „Abruf von Dokumenten“ ist nach erfolgreicher Anmeldung innerhalb von 4 Sekunden erreichbar.
- Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-861.

SCH-IF-011: Revisionssichere Ablage

Die Schnittstelle zum Archivsystem soll abgelegte Dokumente unveränderbar speichern. Die Angaben stammen aus dem Kernbanksystem und werden nicht lokal dupliziert. Die Funktion steht in der mobilen App und im Browser mit gleichem Funktionsumfang zur Verfügung.

Acceptance criteria:
- Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
- Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
- Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.

Priority: Soll
Quelle: Fachkonzept Zahlungsverkehr, Kapitel 4

SCH-IF-012: Löschung nach Fristablauf

Die Schnittstelle zum Archivsystem muss Dokumente nach Ablauf der Aufbewahrungsfrist auf Anforderung löschen und die Löschung bestätigen. Die Verarbeitung ist für den Kunden spätestens nach 2 Sekunden abgeschlossen.

Priority: Muss

Acceptance criteria:
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
- Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
- Die Funktion „Löschung nach Fristablauf“ ist nach erfolgreicher Anmeldung innerhalb von 2 Sekunden erreichbar.
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 1.0.
- Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.

SCH-IF-013: Volltextindex

Die Schnittstelle zum Archivsystem soll eine Suche über Metadaten der Dokumente anbieten. Die Angaben stammen aus dem Kernbanksystem und werden nicht lokal dupliziert. Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert ausgewiesen.

Hinweis: Der Fachbereich bewertet die Anforderung als wettbewerbsrelevant.
Priority: Soll

Acceptance criteria:
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 1.3.
- Die Funktion „Volltextindex“ ist nach erfolgreicher Anmeldung innerhalb von 3 Sekunden erreichbar.
- Ein Test mit 200 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 1 Prozent.

SCH-IF-014: Massenablage

Die Schnittstelle zum Archivsystem soll die Ablage von bis zu 5.000 Dokumenten pro Stunde unterstützen. Die Angaben stammen aus dem Kernbanksystem und werden nicht lokal dupliziert.

Priority: Soll

SCH-IF-015: Prüfsumme

Die Schnittstelle zum Archivsystem kann für jedes Dokument eine Prüfsumme mit SHA-256
ablegen und beim Abruf prüfen. Jede Änderung wird mit Zeitstempel, Benutzerkennung und
Kanal im Prüfprotokoll festgehalten.

Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung.

Priority: Kann

Acceptance criteria:
- Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
- Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.

### 5.2 Äußere Systeme

#### 5.2.1 Zahlungsverkehrsnetze

##### 5.2.1.1 SEPA und Zahlungsdienstleister

| ID | Titel | Anforderung | Priorität |
| --- | --- | --- | --- |
| SCH-IF-016 | Anbindung an das SEPA-Clearing | Die Schnittstelle zum Zahlungsverkehrsnetz muss Zahlungen im Format pain.001 und pacs.008 über das Clearing einreichen und empfangen. Die Regelung gilt in Verbindung mit REQ-FA-048. | Muss |
| SCH-IF-017 | Anbindung an TIPS | Die Schnittstelle zum Zahlungsverkehrsnetz muss Echtzeitüberweisungen über den Zahlungsverkehrsdienst TIPS abwickeln. Die Verarbeitung ist für den Kunden spätestens nach 7 Sekunden abgeschlossen. | Muss |
| SCH-IF-018 | Empfang von Rückläufern | Die Schnittstelle zum Zahlungsverkehrsnetz soll Rückläufer im Format pacs.004 automatisch verarbeiten. Die Abgrenzung zu den Vorgaben des Kernbanksystems ist in REQ-FA-151 beschrieben. | Soll |
| SCH-IF-019 | Statusmeldungen | Die Schnittstelle zum Zahlungsverkehrsnetz soll Statusmeldungen im Format pacs.002 dem Auftrag zuordnen. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung. | Soll |
| SCH-IF-020 | Kontoauszüge im Format CAMT | Die Schnittstelle zum Zahlungsverkehrsnetz muss Kontoinformationen im Format camt.052, camt.053 und camt.054 bereitstellen. Die Angaben stammen aus dem Kernbanksystem und werden nicht lokal dupliziert. | Muss |
| SCH-IF-021 | Prüfung der Nachrichtensignatur | Die Schnittstelle zum Zahlungsverkehrsnetz soll eingehende Nachrichten auf gültige Signatur prüfen. Die Regelung gilt in Verbindung mit REQ-FA-028. | Soll |
| SCH-IF-022 | Notfallverfahren | Die Schnittstelle zum Zahlungsverkehrsnetz soll bei Ausfall des primären Anschlusses auf den Ersatzanschluss umschalten. Die Verarbeitung ist für den Kunden spätestens nach 6 Sekunden abgeschlossen. | Soll |

#### 5.2.2 Drittanbieter und Open Banking

##### 5.2.2.1 PSD2-Schnittstelle

###### SCH-IF-023 Kontoinformationsdienst

Die PSD2-Schnittstelle muss registrierten Drittanbietern mit Einwilligung des Kunden Kontoinformationen bereitstellen.

Priority: Muss
Quelle: Sicherheitskonzept, Kapitel 3

Acceptance criteria:
- Ein Test mit 50 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 1 Prozent.
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 1.6.
- Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-332.

###### SCH-IF-024 Zahlungsauslösedienst

Die PSD2-Schnittstelle muss von Drittanbietern ausgelöste Zahlungen nach starker Kundenauthentifizierung ausführen.

Priority: Muss

Acceptance criteria:
- Die Abnahme berücksichtigt die Wechselwirkung mit SCH-IF-005.
- Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-750.
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.

###### SCH-IF-025 Prüfung des Zertifikats

Die PSD2-Schnittstelle muss Drittanbieter anhand eines qualifizierten Zertifikats nach
eIDAS identifizieren. Die Funktion steht in der mobilen App und im Browser mit gleichem
Funktionsumfang zur Verfügung. Alle Texte stehen in Deutsch und Englisch zur Verfügung
und stammen aus der zentralen Textverwaltung.

Acceptance criteria:
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
- Ein Test mit 1000 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 1 Prozent.
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.

Priority: Muss
Quelle: Sicherheitskonzept, Kapitel 3

###### SCH-IF-026 Einwilligungsverwaltung

Die PSD2-Schnittstelle muss erteilte Einwilligungen für Drittanbieter mit Gültigkeit von 180 Tagen führen.

Priority: Muss

Acceptance criteria:
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
- Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-204.
- Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.

###### SCH-IF-027 Verfügbarkeit der Schnittstelle

Die PSD2-Schnittstelle muss für die Schnittstelle dieselbe Verfügbarkeit wie für das Portal sicherstellen. Die Abgrenzung zu den Vorgaben des Kernbanksystems ist in MIG_ROL-001 beschrieben.

Priority: Muss
Status: Zur Prüfung

Acceptance criteria:
- Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
- Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
- Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-127.

###### SCH-IF-028 Testumgebung für Drittanbieter

Die PSD2-Schnittstelle muss eine Sandbox mit Beispieldaten bereitstellen.

Priority: Muss

Acceptance criteria:
- Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
- Ein Test mit 1000 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,5 Prozent.
- Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-865.
- Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.

###### SCH-IF-029 Statistik zur Nutzung

Die PSD2-Schnittstelle muss Verfügbarkeit und Antwortzeiten der Schnittstelle quartalsweise für die Aufsicht auswerten. Die Abgrenzung zu den Vorgaben des Kernbanksystems ist in NFA-PERF-006 beschrieben. Die Regelung gilt in Verbindung mit REQ-FA-055.

Die Verarbeitung ist für den Kunden spätestens nach 5 Sekunden abgeschlossen.

Hinweis: Die Umsetzung erfolgt in der zweiten Ausbaustufe des Portals.
Priority: Muss
Abhängigkeiten: REQ-FA-013, REQ-FA-084

Acceptance criteria:
- Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
- Die Abnahme berücksichtigt die Wechselwirkung mit MIG_ROL-005.
- Ein Test mit 200 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,1 Prozent.

###### SCH-IF-030 Notfallmechanismus

Die PSD2-Schnittstelle muss bei Ausfall der Schnittstelle einen Ersatzzugang für Drittanbieter bereitstellen.

Priority: Muss
Abhängigkeiten: NFA-UX-012, REQ-FA-201

Acceptance criteria:
- Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-150.
- Die Funktion „Notfallmechanismus“ ist nach erfolgreicher Anmeldung innerhalb von 3 Sekunden erreichbar.
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.

#### 5.2.3 Weitere Dienste

##### 5.2.3.1 Auskunftei, Identitätsprüfung und Versicherungspartner

SCH-IF-031: Bonitätsauskunft

Die Anbindung kann Auskünfte der Auskunftei verschlüsselt abrufen und mit dem Antrag verknüpfen. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten. Die Verarbeitung ist für den Kunden spätestens nach 2 Sekunden abgeschlossen.

Hinweis: Der Fachbereich bewertet die Anforderung als wettbewerbsrelevant.
Priority: Kann
Abhängigkeiten: NFA-UX-014, SCH-IF-026

Acceptance criteria:
1. Die Darstellung entspricht dem freigegebenen Entwurf in Version 4.6.
2. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
3. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
4. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-728.
5. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
6. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.

SCH-IF-032: Video-Identifikation

Die Anbindung muss eine zertifizierte Video-Identifikation in den Registrierungsprozess einbinden.

Priority: Muss

Acceptance criteria:
1. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
2. Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.

SCH-IF-033: Postdienst für Aktivierungsbriefe

Die Anbindung muss Briefe über einen Druck- und Versanddienstleister verschicken.

Hinweis: Der Fachbereich bewertet die Anforderung als wettbewerbsrelevant.
Priority: Muss
Quelle: Sicherheitskonzept, Kapitel 3

Acceptance criteria:
1. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
2. Die Darstellung entspricht dem freigegebenen Entwurf in Version 1.1.

SCH-IF-034: SMS-Gateway

Die Anbindung muss Einmalcodes über zwei redundante SMS-Anbieter versenden. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung. Die Funktion steht in der mobilen App und im Browser mit gleichem Funktionsumfang zur Verfügung.

Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe NFA-SEC-020).

Acceptance criteria:
1. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
2. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
3. Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.

Hinweis: Die Umsetzung erfolgt in der zweiten Ausbaustufe des Portals.
Priority: Muss
Quelle: Fachkonzept Kundenportal, Kapitel 2

SCH-IF-035: Anbindung der Versicherungspartner

Die Anbindung soll Schadenmeldungen über eine gesicherte Schnittstelle an den
Versicherer übermitteln. Die Regelung gilt in Verbindung mit NFA-SEC-031. Die Angaben
stammen aus dem Kernbanksystem und werden nicht lokal dupliziert.

Priority: Soll

Acceptance criteria:
1. Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
2. Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
3. Die Darstellung entspricht dem freigegebenen Entwurf in Version 2.5.
4. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.

SCH-IF-036: Sanktionslisten-Dienst

Die Anbindung muss die aktuellen Sanktionslisten täglich automatisch aktualisieren. Die Abgrenzung zu den Vorgaben des Kernbanksystems ist in REQ-FA-183 beschrieben.

Hinweis: Die technische Machbarkeit wurde im Architekturboard bestätigt.
Priority: Muss

Acceptance criteria:
1. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
2. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
3. Die Darstellung entspricht dem freigegebenen Entwurf in Version 1.4.
4. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
5. Die Funktion „Sanktionslisten-Dienst“ ist nach erfolgreicher Anmeldung innerhalb von 2 Sekunden erreichbar.
6. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-877.

SCH-IF-037: Anbindung des Gutachterportals

Die Anbindung soll Gutachtertermine mit dem Gutachterportal abgleichen. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten.

Priority: Soll
Quelle: Regulatorik-Katalog 2026, Abschnitt 7

Acceptance criteria:
1. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.

SCH-IF-038: Adressprüfung

Die Anbindung muss Postanschriften über einen Verzeichnisdienst validieren und vorschlagen. Die Abgrenzung zu den Vorgaben des Kernbanksystems ist in BET-SLA-004 beschrieben. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten.

Die Angaben stammen aus dem Kernbanksystem und werden nicht lokal dupliziert.

Hinweis: Die fachliche Abstimmung mit der Rechtsabteilung ist noch ausstehend.
Priority: Muss
Abhängigkeiten: REQ-FA-119, REQ-FA-165

Acceptance criteria:
1. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
2. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
3. Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
4. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
5. Die Abnahme berücksichtigt die Wechselwirkung mit NFA-PERF-014.

## 6 Betrieb, Migration und Abnahme

### 6.1 Migration

#### 6.1.1 Datenmigration

##### 6.1.1.1 Übernahme von Altdaten

###### MIG_DAT-001 Übernahme der Kundenstammdaten

Die Migration muss die Stammdaten aller aktiven Kunden verlustfrei aus dem Altsystem übernehmen. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung.

Die Angaben stammen aus dem Kernbanksystem und werden nicht lokal dupliziert.

Priorität: Muss

Abnahmekriterien:
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 2.3.
- Die Funktion „Übernahme der Kundenstammdaten“ ist nach erfolgreicher Anmeldung innerhalb von 1 Sekunden erreichbar.
- Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
- Ein Test mit 500 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,1 Prozent.
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.

###### MIG_DAT-002 Übernahme der Umsatzhistorie

Die Migration soll die Umsätze der letzten 36 Monate bei der Migration mitnehmen. Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt. Die Abgrenzung zu den Vorgaben des Kernbanksystems ist in REQ-FA-072 beschrieben.

Abnahmekriterien:
- Ein Test mit 50 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,1 Prozent.
- Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
- Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
- Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-085.

Priorität: Soll
Quelle: Fachkonzept Zahlungsverkehr, Kapitel 4
Status: In Abstimmung
Abhängigkeiten: REQ-FA-121, REQ-FA-123

###### MIG_DAT-003 Übernahme von Daueraufträgen

Die Migration muss alle Daueraufträge und Vorlagen mit ihren Terminen übertragen.

Abnahmekriterien:
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
- Die Funktion „Übernahme von Daueraufträgen“ ist nach erfolgreicher Anmeldung innerhalb von 2 Sekunden erreichbar.

Priorität: Muss
Quelle: Sicherheitskonzept, Kapitel 3

###### MIG_DAT-004 Abgleich nach der Migration

Die Migration soll nach jedem Lauf die Summen und Anzahlen je Datenart gegen das Altsystem abstimmen. Die Angaben stammen aus dem Kernbanksystem und werden nicht lokal dupliziert.

Priorität: Soll

Abnahmekriterien:
- Die Funktion „Abgleich nach der Migration“ ist nach erfolgreicher Anmeldung innerhalb von 1 Sekunden erreichbar.
- Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-870.

###### MIG_DAT-005 Wiederholbarkeit des Migrationslaufs

Die Migration muss den Migrationslauf beliebig oft wiederholbar ausführen.

Priorität: Muss
Status: In Abstimmung

Abnahmekriterien:
- Die Abnahme berücksichtigt die Wechselwirkung mit NFA-UX-008.
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.

###### MIG_DAT-006 Fehlerbehandlung der Migration

Die Migration kann nicht migrierbare Datensätze in einer Fehlerliste mit Grund ausweisen. Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert ausgewiesen. Die Abgrenzung zu den Vorgaben des Kernbanksystems ist in REQ-FA-045 beschrieben.

Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert ausgewiesen.

Priorität: Kann

###### MIG_DAT-007 Rückfallplan

Die Migration kann im Fehlerfall innerhalb von vier Stunden zum Altsystem zurückkehren. Die Regelung gilt in Verbindung mit REQ-FA-077. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung.

Hinweis: Die Umsetzung erfolgt in der zweiten Ausbaustufe des Portals.
Priorität: Kann

Abnahmekriterien:
- Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-322.
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
- Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 1.0.
- Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
- Ein Test mit 200 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 1 Prozent.

###### MIG_DAT-008 Migration von Zustimmungen

Die Migration muss bestehende Einwilligungen mit Nachweis in das neue System übernehmen. Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe NFA-SEC-009). Die Abgrenzung zu den Vorgaben des Kernbanksystems ist in REQ-FA-006 beschrieben.

Priorität: Muss
Quelle: Regulatorik-Katalog 2026, Abschnitt 7
Jira: KRED-119

Abnahmekriterien:
- Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-013.
- Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 1.4.
- Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.

#### 6.1.2 Einführung

##### 6.1.2.1 Stufenweiser Umstieg

MIG_ROL-001: Pilotkunden

Die Einführung kann in einer ersten Stufe mit höchstens 2.000 Pilotkunden starten. Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert ausgewiesen. Die Funktion steht in der mobilen App und im Browser mit gleichem Funktionsumfang zur Verfügung.

Priorität: Kann

Abnahmekriterien:
1. Die Funktion „Pilotkunden“ ist nach erfolgreicher Anmeldung innerhalb von 1 Sekunden erreichbar.
2. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
3. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.

MIG_ROL-002: Staffelung der Kunden

Die Einführung soll die weiteren Kunden in vier Wellen mit je einer Woche Abstand umstellen. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten. Die Abgrenzung zu den Vorgaben des Kernbanksystems ist in NFA-AVL-005 beschrieben.

Die Verarbeitung ist für den Kunden spätestens nach 3 Sekunden abgeschlossen.

Priorität: Soll
Quelle: Fachkonzept Kundenportal, Kapitel 2

Abnahmekriterien:
1. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
2. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.

MIG_ROL-003: Parallelbetrieb

Die Einführung soll während der Einführung beide Portale mit einheitlichen Daten betreiben. Die Regelung gilt in Verbindung mit REQ-FA-153. Die Funktion steht in der mobilen App und im Browser mit gleichem Funktionsumfang zur Verfügung.

Hinweis: Die Umsetzung erfolgt in der zweiten Ausbaustufe des Portals.
Priorität: Soll
Status: Freigegeben

Abnahmekriterien:
1. Ein Test mit 1000 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,1 Prozent.
2. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
3. Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.

MIG_ROL-004: Kommunikation an Kunden

Die Einführung soll Kunden vier Wochen vor ihrer Umstellung schriftlich und im Portal informieren.

Priorität: Soll

Abnahmekriterien:
1. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
2. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.

MIG_ROL-005: Schulung der Kundenbetreuung

Die Einführung muss alle Mitarbeiter der Kundenbetreuung vor Start ihrer Welle schulen. Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt. Die Angaben stammen aus dem Kernbanksystem und werden nicht lokal dupliziert.

Abnahmekriterien:
1. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
2. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
3. Die Darstellung entspricht dem freigegebenen Entwurf in Version 4.8.
4. Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
5. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
6. Die Funktion „Schulung der Kundenbetreuung“ ist nach erfolgreicher Anmeldung innerhalb von 3 Sekunden erreichbar.

Priorität: Muss

MIG_ROL-006: Abschaltung des Altsystems

Die Einführung muss das Altsystem erst nach 90 Tagen ohne Nutzung abschalten. Die Verarbeitung ist für den Kunden spätestens nach 7 Sekunden abgeschlossen. Die Funktion steht in der mobilen App und im Browser mit gleichem Funktionsumfang zur Verfügung.

Priorität: Muss

MIG_ROL-007: Hypercare

Die Einführung soll nach jeder Welle eine erhöhte Betriebsbereitschaft für vierzehn Tage vorsehen. Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung.

Hinweis: Der Fachbereich bewertet die Anforderung als wettbewerbsrelevant.
Priorität: Soll

Abnahmekriterien:
1. Die Darstellung entspricht dem freigegebenen Entwurf in Version 2.1.
2. Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
3. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.

### 6.2 Abnahme

#### 6.2.1 Abnahmekriterien

##### 6.2.1.1 Abnahme der Lieferung

###### ABN-45.1 Funktionsumfang

Der Auftragnehmer muss den im Lastenheft beschriebenen Funktionsumfang vollständig liefern. Die Regelung gilt in Verbindung mit NFA-PERF-012. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten.

Abnahmekriterien:
- Ein Test mit 200 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,1 Prozent.
- Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
- Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-101.
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
- Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-367.
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 1.7.

Hinweis: Die Umsetzung erfolgt in der zweiten Ausbaustufe des Portals.
Priorität: Muss
Jira: KRED-82

###### ABN-45.2 Testabdeckung

Der Auftragnehmer muss für jede Muss-Anforderung mindestens einen automatisierten Abnahmetest liefern. Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe REQ-FA-110).

Priorität: Muss
Status: Zur Prüfung

Abnahmekriterien:
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.
- Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.

###### ABN-45.3 Fehlerfreiheit

Der Auftragnehmer muss zur Abnahme keine offenen Fehler der Kategorien 1 und 2 aufweisen.

Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung.

Abnahmekriterien:
- Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-751.
- Die Darstellung entspricht dem freigegebenen Entwurf in Version 4.3.
- Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.

Priorität: Muss

###### ABN-45.4 Dokumentation

Der Auftragnehmer muss Betriebs-, Benutzer- und Schnittstellendokumentation in deutscher
Sprache liefern. Die Verarbeitung ist für den Kunden spätestens nach 8 Sekunden
abgeschlossen.

Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe REQ-FA-203).

Hinweis: Für Firmenkunden gelten abweichende Rahmenwerte, die im Vertrag geregelt sind.
Priorität: Muss

###### ABN-45.5 Übergabe des Quelltextes

Der Auftragnehmer muss den vollständigen Quelltext einschließlich Build-Skripten übergeben. Die Verarbeitung ist für den Kunden spätestens nach 8 Sekunden abgeschlossen. Die Funktion steht in der mobilen App und im Browser mit gleichem Funktionsumfang zur Verfügung.

Priorität: Muss
Abhängigkeiten: NFA-SEC-002, REQ-FA-056

Abnahmekriterien:
- Die Funktion „Übergabe des Quelltextes“ ist nach erfolgreicher Anmeldung innerhalb von 1 Sekunden erreichbar.
- Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
- Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
- Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-889.
- Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.

###### ABN-45.6 Nachweis der Lasttests

Der Auftragnehmer muss die Ergebnisse der Lasttests nach NFA-PERF vorlegen. Für
Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe REQ-FA-126).
Die Abgrenzung zu den Vorgaben des Kernbanksystems ist in SCH-IF-023 beschrieben.

Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten.

Abnahmekriterien:
- Die Abnahme berücksichtigt die Wechselwirkung mit NFA-DSG-003.
- Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
- Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
- Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.

Priorität: Muss

###### ABN-45.7 Schulungsunterlagen

Der Auftragnehmer soll Schulungsunterlagen für Kunden und Mitarbeiter bereitstellen.
Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll
festgehalten.

Priorität: Soll
Status: Zur Prüfung
Abhängigkeiten: REQ-FA-173, SCH-IF-022

###### ABN-45.8 Gewährleistung

Der Auftragnehmer soll für die Dauer von 24 Monaten ab Abnahme Fehler kostenfrei beheben. Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe NFA-REG-008). Die Angaben stammen aus dem Kernbanksystem und werden nicht lokal dupliziert.

Hinweis: Die technische Machbarkeit wurde im Architekturboard bestätigt.
Priorität: Soll
Status: In Abstimmung

Abnahmekriterien:
- Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.

#### 6.2.2 Support und Betrieb

##### 6.2.2.1 Service-Level

###### BET-SLA-001 Servicezeiten

Der Betreiber muss den Support montags bis freitags von 07:00 bis 20:00 Uhr bereitstellen. Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten.

Priorität: Muss

Abnahmekriterien:
1. Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-250.
2. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.
3. Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.

###### BET-SLA-002 Reaktionszeit bei Störungen der Priorität 1

Der Betreiber muss bei Störungen der Priorität 1 innerhalb von 15 Minuten reagieren. Die Abgrenzung zu den Vorgaben des Kernbanksystems ist in NFA-REG-007 beschrieben.

Priorität: Muss
Quelle: Sicherheitskonzept, Kapitel 3

Abnahmekriterien:
1. Ein Test mit 50 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,5 Prozent.
2. Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
3. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
4. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.
5. Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.

###### BET-SLA-003 Wiederherstellungszeit bei Priorität 1

Der Betreiber muss Störungen der Priorität 1 innerhalb von vier Stunden beheben.

Priorität: Muss
Quelle: Regulatorik-Katalog 2026, Abschnitt 7

Abnahmekriterien:
1. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
2. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
3. Ein Test mit 200 gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens 0,5 Prozent.

###### BET-SLA-004 Reaktionszeit bei Priorität 2

Der Betreiber muss bei Störungen der Priorität 2 innerhalb von zwei Stunden reagieren. Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt.

Priorität: Muss
Abhängigkeiten: REQ-FA-009, SCH-IF-007

Abnahmekriterien:
1. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
2. Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.
3. Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.
4. Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.

###### BET-SLA-005 Berichtswesen

Der Betreiber soll monatlich einen Bericht über Verfügbarkeit, Störungen und Antwortzeiten liefern.

Priorität: Soll

Abnahmekriterien:
1. Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.
2. Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.
3. Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.

###### BET-SLA-006 Vertragsstrafe

Der Betreiber soll bei Unterschreitung der Verfügbarkeit eine Gutschrift nach Vertrag gewähren. Die Funktion steht in der mobilen App und im Browser mit gleichem Funktionsumfang zur Verfügung. Die Verarbeitung ist für den Kunden spätestens nach 5 Sekunden abgeschlossen.

Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten.

Priorität: Soll
Quelle: Sicherheitskonzept, Kapitel 3
Jira: KRED-105

Abnahmekriterien:
1. Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.
2. Die Abnahme berücksichtigt die Wechselwirkung mit REQ-FA-119.

###### BET-SLA-007 Wartung und Aktualisierung

Der Betreiber muss sicherheitsrelevante Aktualisierungen innerhalb von 14 Tagen einspielen. Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert ausgewiesen. Die Regelung gilt in Verbindung mit SCH-IF-006.

Abnahmekriterien:
1. Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.
2. Die Darstellung entspricht dem freigegebenen Entwurf in Version 2.4.

Priorität: Muss
Quelle: Workshop Fachbereich vom 14.03.2026
Abhängigkeiten: NFA-UX-007, REQ-FA-185

## 7 Anhang

### 7.1 Fehlercodes

#### 7.1.1 Fehlercodes der Schnittstellen

##### 7.1.1.1 Tabelle der Fehlercodes

| Code | Bedeutung |
| --- | --- |
| ERR-4001 | Ungültige IBAN |
| ERR-4002 | Betrag außerhalb des zulässigen Bereichs |
| ERR-4003 | Verwendungszweck zu lang |
| ERR-4010 | Empfängerüberprüfung nicht möglich |
| ERR-4031 | Limit überschritten |
| ERR-4032 | Konto gesperrt |
| ERR-4091 | Doppelte Auftrags-ID |
| ERR-5001 | Kernbanksystem nicht erreichbar |
| ERR-5002 | Zeitüberschreitung beim Clearing |
| ERR-5030 | Dienst vorübergehend nicht verfügbar |

### 7.2 Rückverfolgbarkeit

#### 7.2.1 Zuordnung zu Abnahmetests

##### 7.2.1.1 Testfallzuordnung

| Anforderungs-ID | Testfall | Status |
| --- | --- | --- |
| REQ-FA-001 | TC-100 | Bestanden |
| REQ-FA-015 | TC-101 | Geplant |
| REQ-FA-029 | TC-102 | Geplant |
| REQ-FA-043 | TC-103 | Bestanden |
| REQ-FA-057 | TC-104 | Geplant |
| REQ-FA-071 | TC-105 | Geplant |
| REQ-FA-085 | TC-106 | Bestanden |
| REQ-FA-099 | TC-107 | Geplant |
| REQ-FA-113 | TC-108 | Geplant |
| REQ-FA-127 | TC-109 | Bestanden |
| REQ-FA-141 | TC-110 | Geplant |
| REQ-FA-155 | TC-111 | Geplant |
| REQ-FA-169 | TC-112 | Bestanden |
| REQ-FA-183 | TC-113 | Geplant |
| REQ-FA-197 | TC-114 | Geplant |
| NFA-PERF-005 | TC-115 | Bestanden |
| NFA-AVL-003 | TC-116 | Geplant |
| NFA-SEC-001 | TC-117 | Geplant |
| NFA-SEC-015 | TC-118 | Bestanden |
| NFA-SEC-029 | TC-119 | Geplant |
| NFA-REG-003 | TC-120 | Geplant |
| NFA-UX-009 | TC-121 | Bestanden |
| SCH-IF-007 | TC-122 | Geplant |
| SCH-IF-021 | TC-123 | Geplant |
| SCH-IF-035 | TC-124 | Bestanden |
| MIG_ROL-003 | TC-125 | Geplant |
| BET-SLA-002 | TC-126 | Geplant |

### 7.3 Änderungshistorie

#### 7.3.1 Versionen

##### 7.3.1.1 Verlauf

| Version | Datum | Autor | Änderung |
| --- | --- | --- | --- |
| 1.0 | 12.01.2026 | Fachbereich | Erste Fassung |
| 1.2 | 03.05.2026 | Fachbereich | Ergänzung Zahlungsverkehr |
| 1.4 | 07.11.2026 | Fachbereich | Ergänzung Schnittstellen und Migration |
