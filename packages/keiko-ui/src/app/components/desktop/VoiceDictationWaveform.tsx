"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DictationController } from "./hooks/useDictation";
import { useVoiceTranslate, type I18nTranslate } from "./voice-i18n";
import styles from "./VoiceDictation.module.css";

const SAMPLE_COUNT = 64;
const SAMPLE_INTERVAL_MS = 80;
const SAMPLE_SPACING = 6;
// Below this normalized RMS the room, not the speaker, moves the needle: it stays a quiet dot.
const NOISE_FLOOR = 0.06;
// A bar never fills the composer bar; loud speech reads as emphasis, not as clipping.
const MAX_EXTENT = 0.82;
// The envelope follows a rising voice quickly and lets it fall gently, so syllables read as one
// phrase instead of a flicker (shared by Chat and the Coding Workbench, #3907).
const ATTACK = 0.65;
const RELEASE = 0.3;

interface LevelSample {
  readonly id: number;
  readonly level: number;
}

/** The recorder's normalized RMS mapped to the drawn extent: gated, eased and capped. */
export function shapedVoiceLevel(level: number): number {
  const safe = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  const gated = Math.max(0, (safe - NOISE_FLOOR) / (1 - NOISE_FLOOR));
  return Math.pow(gated, 0.65) * MAX_EXTENT;
}

/** One envelope step from the previous drawn extent toward the newly shaped level. */
export function nextVoiceEnvelope(previous: number, level: number): number {
  const target = shapedVoiceLevel(level);
  const rate = target > previous ? ATTACK : RELEASE;
  return previous + (target - previous) * rate;
}

/** The y coordinates of a bar for an envelope value, centred in the 32-unit-high view box. */
export function voiceBarSpan(envelope: number): { readonly y1: number; readonly y2: number } {
  const half = 1 + envelope * 13;
  return { y1: 16 - half, y2: 16 + half };
}

function silentHistory(): readonly LevelSample[] {
  return Array.from({ length: SAMPLE_COUNT }, (_, index) => ({
    id: index - SAMPLE_COUNT,
    level: 0,
  }));
}

function useLevelHistory(level: number, recording: boolean): readonly LevelSample[] {
  const current = useRef(0);
  current.current = level;
  const [samples, setSamples] = useState<readonly LevelSample[]>(silentHistory);
  useEffect(() => {
    setSamples(silentHistory());
    if (!recording) return;
    let envelope = 0;
    let next = 0;
    const timer = setInterval(() => {
      envelope = nextVoiceEnvelope(envelope, current.current);
      const sample = { id: next, level: envelope };
      next += 1;
      setSamples((previous) => [...previous.slice(1), sample]);
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

// Each measured sample keeps its own line, keyed by its sequence number, and only its horizontal
// offset changes: the CSS transition glides it one step left over the sampling interval, so the
// trace drifts continuously instead of jumping 12.5 times a second.
function WaveformTrace({ samples }: { readonly samples: readonly LevelSample[] }): ReactNode {
  return (
    <svg viewBox="0 0 384 32" preserveAspectRatio="none" aria-hidden="true">
      {samples.map((sample, index) => {
        const { y1, y2 } = voiceBarSpan(sample.level);
        return (
          <line
            key={sample.id}
            x1={0}
            x2={0}
            y1={y1}
            y2={y2}
            data-speech={sample.level > 0.04}
            style={{ transform: `translateX(${String(index * SAMPLE_SPACING + 3)}px)` }}
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
    </svg>
  );
}

/** A bounded history of the existing recorder's RMS levels, never synthetic animation or audio. */
export function VoiceDictationWaveform({
  controller,
  visible = true,
}: {
  readonly controller: DictationController;
  readonly visible?: boolean;
}): ReactNode {
  const t = useVoiceTranslate();
  const recording = visible && controller.phase === "recording" && controller.micReady;
  const samples = useLevelHistory(controller.audioLevel, recording);
  const label = captureLabel(controller, t);
  if (!visible || !controller.busy) return null;
  return (
    <div className={styles.cmpWaveform} data-recording={recording} role="status" aria-live="polite">
      {recording ? (
        <>
          <span className="sr-only">{label}</span>
          <WaveformTrace samples={samples} />
        </>
      ) : (
        <span className={styles.cmpStatus}>{label}</span>
      )}
    </div>
  );
}
