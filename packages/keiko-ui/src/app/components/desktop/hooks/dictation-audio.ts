// Decode browser containers locally and send one interoperable PCM16 WAV clip to STT.
// OfflineAudioContext performs codec decoding, channel mixing and band-limited resampling;
// audio stays in memory. No server codec dependency or provider-specific retry is needed.
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";

const SAMPLE_RATE = 16_000;
const MAX_AUDIO_BYTES = 4_000_000;
const WAV_HEADER_BYTES = 44;

function writeTag(view: DataView, offset: number, tag: string): void {
  for (const [index, byte] of new TextEncoder().encode(tag).entries()) {
    view.setUint8(offset + index, byte);
  }
}

function encodeWav(samples: Float32Array): Blob {
  const bytes = new ArrayBuffer(WAV_HEADER_BYTES + samples.length * 2);
  const view = new DataView(bytes);
  writeTag(view, 0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  writeTag(view, 8, "WAVE");
  writeTag(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeTag(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(WAV_HEADER_BYTES + index * 2, sample * (sample < 0 ? 32768 : 32767), true);
  }
  return new Blob([bytes], { type: "audio/wav" });
}

async function normalizeAudio(blob: Blob): Promise<Blob> {
  if (blob.size === 0 || blob.size > MAX_AUDIO_BYTES) {
    throw new RangeError("Dictation audio exceeds the capture bounds.");
  }
  const decoder = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  const decoded = await decoder.decodeAudioData(await blob.arrayBuffer());
  const frames = Math.ceil(decoded.duration * SAMPLE_RATE);
  if (
    !Number.isSafeInteger(frames) ||
    frames <= 0 ||
    WAV_HEADER_BYTES + frames * 2 > MAX_AUDIO_BYTES
  ) {
    throw new RangeError("Decoded dictation audio exceeds the capture bounds.");
  }
  const renderer = new OfflineAudioContext(1, frames, SAMPLE_RATE);
  const source = renderer.createBufferSource();
  source.buffer = decoded;
  source.connect(renderer.destination);
  source.start();
  const rendered = await renderer.startRendering();
  return encodeWav(rendered.getChannelData(0));
}

export async function normalizeDictationAudio(blob: Blob): Promise<Blob> {
  try {
    return await normalizeAudio(blob);
  } catch (error) {
    reportClientDiagnostic("Dictation audio normalization failed.", {
      kind: "other",
      errorKind: "validation-failed",
      errorEvidence: clientErrorEvidence(error),
    });
    throw error;
  }
}
