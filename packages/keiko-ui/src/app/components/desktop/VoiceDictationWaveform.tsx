"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DictationController } from "./hooks/useDictation";
import { useVoiceTranslate, type I18nTranslate } from "./voice-i18n";
import styles from "./VoiceDictation.module.css";

const SAMPLE_COUNT = 64;
const SAMPLE_INTERVAL_MS = 80;

function useLevelHistory(level: number, recording: boolean): readonly number[] {
  const current = useRef(0);
  current.current = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  const [samples, setSamples] = useState<readonly number[]>(() =>
    Array<number>(SAMPLE_COUNT).fill(0),
  );
  useEffect(() => {
    setSamples(Array<number>(SAMPLE_COUNT).fill(0));
    if (!recording) return;
    const timer = setInterval(() => {
      setSamples((previous) => [...previous.slice(1), current.current]);
    }, SAMPLE_INTERVAL_MS);
    return (): void => clearInterval(timer);
  }, [recording]);
  return samples;
}

function captureLabel(controller: DictationController, t: I18nTranslate): string {
  if (controller.phase === "requesting") return t("voice.dictation.starting");
  if (controller.phase === "finalizing") return t("voice.dictation.finishing");
  if (controller.phase === "transcribing") return t("voice.dictation.transcribing");
  if (!controller.micReady) return t("voice.dictation.preparingMic");
  return t(controller.heardSpeech ? "voice.dictation.capturing" : "voice.dictation.listening");
}

/** A bounded history of the existing recorder's RMS levels, never synthetic animation or audio. */
export function VoiceDictationWaveform({
  controller,
}: {
  readonly controller: DictationController;
}): ReactNode {
  const t = useVoiceTranslate();
  const recording = controller.phase === "recording" && controller.micReady;
  const samples = useLevelHistory(controller.audioLevel, recording);
  const label = captureLabel(controller, t);
  if (!controller.busy) return null;
  return (
    <div className={styles.cmpWaveform} role="status" aria-live="polite">
      {recording ? (
        <>
          <span className="sr-only">{label}</span>
          <svg viewBox="0 0 384 32" preserveAspectRatio="none" aria-hidden="true">
            {samples.map((level, index) => (
              <line
                key={index}
                x1={index * 6 + 3}
                x2={index * 6 + 3}
                y1={15 - level * 13}
                y2={17 + level * 13}
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>
        </>
      ) : (
        <span className={styles.cmpStatus}>{label}</span>
      )}
    </div>
  );
}
