"use client";

import { useMemo } from "react";
import { useLocale, type Locale, type MessageValues } from "@/lib/i18n";

const VOICE_EN_MESSAGES = {
  "common.tryAgain": "Try again",
  "common.dismiss": "Dismiss",
  "memoria.approve": "Approve",
  "memoria.reject": "Reject",
  "voice.error.noMicrophone": "No microphone was found. Connect a microphone and try again.",
  "voice.dictation.starting": "Starting microphone…",
  "voice.dictation.stop": "Stop dictation",
  "voice.dictation.finishing": "Finishing dictation…",
  "voice.dictation.transcribing": "Transcribing your dictation…",
  "voice.dictation.start": "Dictate a message",
  "voice.dictation.privacy":
    "Audio is sent only to your configured speech-to-text endpoint and is not stored.",
  "voice.dictation.error.permission":
    "Microphone access was denied. Allow microphone access in your browser to dictate.",
  "voice.dictation.error.unsupported": "This browser does not support microphone dictation.",
  "voice.dictation.error.unavailable": "Speech-to-text dictation is not available right now.",
  "voice.dictation.error.failed": "Dictation could not be completed.",
  "voice.dictation.preparingMic": "Preparing mic…",
  "voice.dictation.capturing": "Capturing speech…",
  "voice.dictation.listening": "Listening…",
  "voice.dictation.preview": "Dictation transcript preview",
  "voice.dictation.ready": "Transcript ready for review.",
  "voice.dictation.review": "Review your dictation",
  "voice.dictation.insertAria": "Insert transcript into the message",
  "voice.dictation.insert": "Insert",
  "voice.dictation.rerecordAria": "Re-record the dictation",
  "voice.dictation.rerecord": "Re-record",
  "voice.dictation.discardAria": "Discard the dictation",
  "voice.dictation.discard": "Discard",
  "voice.realtime.starting": "Starting microphone…",
  "voice.realtime.connecting": "Connecting realtime voice…",
  "voice.realtime.stop": "Stop realtime voice",
  "voice.realtime.start": "Start realtime voice",
  "voice.realtime.privacy":
    "Your audio is streamed directly to your configured realtime provider and is not stored.",
  "voice.realtime.error.permission":
    "Microphone access was denied. Allow microphone access in your browser to use realtime voice.",
  "voice.realtime.error.unsupported": "This browser does not support realtime voice.",
  "voice.realtime.error.unavailable": "Realtime voice is not available right now.",
  "voice.realtime.error.negotiationFailed": "Realtime voice connection could not be established.",
  "voice.realtime.error.connectionFailed": "Realtime voice connection was lost.",
  "voice.realtime.memory.one": "1 recalled memory active.",
  "voice.realtime.memory.many": "{count} recalled memories active.",
  "voice.realtime.memory.contextActive": "MemoriaViva context active.",
  "voice.realtime.memory.updateFailed": "Unable to update memory.",
  "voice.realtime.memory.region": "MemoriaViva voice memory",
  "voice.realtime.status": "Realtime voice status",
  "voice.realtime.connected": "Realtime voice connected.",
  "voice.playback.mute": "Mute assistant voice",
  "voice.playback.unmute": "Unmute assistant voice",
  "voice.playback.privacy":
    "Assistant speech is optional. The full response is always available as text in the conversation.",
  "voice.playback.preparing": "Preparing the spoken response…",
  "voice.playback.speaking": "The assistant is speaking.",
  "voice.playback.paused": "Spoken response paused.",
  "voice.playback.interrupted": "Spoken response interrupted.",
  "voice.playback.stopped": "Spoken response stopped.",
  "voice.playback.failed":
    "The spoken response could not be played. The full reply is shown as text.",
  "voice.playback.finished": "Spoken response finished.",
  "voice.playback.pause": "Pause",
  "voice.playback.resume": "Resume",
  "voice.playback.stop": "Stop",
  "voice.playback.replay": "Replay",
  "voice.playback.textFallback":
    "The assistant's full response is available as text in the conversation.",
} as const;

const VOICE_DE_MESSAGES: VoiceMessageCatalog = {
  "common.tryAgain": "Erneut versuchen",
  "common.dismiss": "Ausblenden",
  "memoria.approve": "Freigeben",
  "memoria.reject": "Ablehnen",
  "voice.error.noMicrophone":
    "Es wurde kein Mikrofon gefunden. Schließe ein Mikrofon an und versuche es erneut.",
  "voice.dictation.starting": "Mikrofon wird gestartet…",
  "voice.dictation.stop": "Diktat beenden",
  "voice.dictation.finishing": "Diktat wird abgeschlossen…",
  "voice.dictation.transcribing": "Diktat wird transkribiert…",
  "voice.dictation.start": "Nachricht diktieren",
  "voice.dictation.privacy":
    "Audio wird nur an deinen konfigurierten Speech-to-Text-Endpunkt gesendet und nicht gespeichert.",
  "voice.dictation.error.permission":
    "Der Zugriff auf das Mikrofon wurde verweigert. Erlaube den Mikrofonzugriff im Browser, um diktieren zu können.",
  "voice.dictation.error.unsupported": "Dieser Browser unterstützt kein Mikrofondiktat.",
  "voice.dictation.error.unavailable": "Speech-to-Text-Diktat ist gerade nicht verfügbar.",
  "voice.dictation.error.failed": "Das Diktat konnte nicht abgeschlossen werden.",
  "voice.dictation.preparingMic": "Mikrofon wird vorbereitet…",
  "voice.dictation.capturing": "Sprache wird erfasst…",
  "voice.dictation.listening": "Hört zu…",
  "voice.dictation.preview": "Vorschau des Diktat-Transkripts",
  "voice.dictation.ready": "Transkript ist zur Prüfung bereit.",
  "voice.dictation.review": "Diktat prüfen",
  "voice.dictation.insertAria": "Transkript in die Nachricht einfügen",
  "voice.dictation.insert": "Einfügen",
  "voice.dictation.rerecordAria": "Diktat erneut aufnehmen",
  "voice.dictation.rerecord": "Neu aufnehmen",
  "voice.dictation.discardAria": "Diktat verwerfen",
  "voice.dictation.discard": "Verwerfen",
  "voice.realtime.starting": "Mikrofon wird gestartet…",
  "voice.realtime.connecting": "Realtime Voice wird verbunden…",
  "voice.realtime.stop": "Realtime Voice beenden",
  "voice.realtime.start": "Realtime Voice starten",
  "voice.realtime.privacy":
    "Dein Audio wird direkt an den konfigurierten Realtime-Anbieter gestreamt und nicht gespeichert.",
  "voice.realtime.error.permission":
    "Der Zugriff auf das Mikrofon wurde verweigert. Erlaube den Mikrofonzugriff im Browser, um Realtime Voice zu nutzen.",
  "voice.realtime.error.unsupported": "Dieser Browser unterstützt Realtime Voice nicht.",
  "voice.realtime.error.unavailable": "Realtime Voice ist gerade nicht verfügbar.",
  "voice.realtime.error.negotiationFailed":
    "Die Realtime-Voice-Verbindung konnte nicht aufgebaut werden.",
  "voice.realtime.error.connectionFailed": "Die Realtime-Voice-Verbindung wurde getrennt.",
  "voice.realtime.memory.one": "1 abgerufene Erinnerung aktiv.",
  "voice.realtime.memory.many": "{count} abgerufene Erinnerungen aktiv.",
  "voice.realtime.memory.contextActive": "MemoriaViva-Kontext aktiv.",
  "voice.realtime.memory.updateFailed": "Erinnerung konnte nicht aktualisiert werden.",
  "voice.realtime.memory.region": "MemoriaViva-Sprachspeicher",
  "voice.realtime.status": "Realtime-Voice-Status",
  "voice.realtime.connected": "Realtime Voice verbunden.",
  "voice.playback.mute": "Assistenzstimme stummschalten",
  "voice.playback.unmute": "Assistenzstimme aktivieren",
  "voice.playback.privacy":
    "Sprachausgabe ist optional. Die vollständige Antwort bleibt immer als Text in der Konversation verfügbar.",
  "voice.playback.preparing": "Sprachausgabe wird vorbereitet…",
  "voice.playback.speaking": "Die Assistenz spricht.",
  "voice.playback.paused": "Sprachausgabe pausiert.",
  "voice.playback.interrupted": "Sprachausgabe unterbrochen.",
  "voice.playback.stopped": "Sprachausgabe beendet.",
  "voice.playback.failed":
    "Die Sprachausgabe konnte nicht abgespielt werden. Die vollständige Antwort wird als Text angezeigt.",
  "voice.playback.finished": "Sprachausgabe abgeschlossen.",
  "voice.playback.pause": "Pausieren",
  "voice.playback.resume": "Fortsetzen",
  "voice.playback.stop": "Stoppen",
  "voice.playback.replay": "Erneut abspielen",
  "voice.playback.textFallback":
    "Die vollständige Antwort der Assistenz ist als Text in der Konversation verfügbar.",
};

export type VoiceMessageKey = keyof typeof VOICE_EN_MESSAGES;
export type I18nTranslate = (key: VoiceMessageKey, values?: MessageValues) => string;
type VoiceMessageCatalog = Readonly<Record<VoiceMessageKey, string>>;

function catalogFor(locale: Locale): VoiceMessageCatalog {
  return locale === "de" ? VOICE_DE_MESSAGES : VOICE_EN_MESSAGES;
}

function interpolate(template: string, values: MessageValues = {}): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/gu, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}

export function useVoiceTranslate(): I18nTranslate {
  const locale = useLocale();
  return useMemo<I18nTranslate>(() => {
    const catalog = catalogFor(locale);
    return (key, values) => interpolate(catalog[key] ?? VOICE_EN_MESSAGES[key], values);
  }, [locale]);
}
