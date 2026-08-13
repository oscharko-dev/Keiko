// Keiko gapless PCM playback worklet (Issue #1556). Plays streamed assistant-speech audio sample-
// accurately on the audio render thread so the buffered whole-clip <audio> path can be replaced by a
// start-on-first-chunk path with instant barge-in.
//
// Hardened beyond a naive demo: a pre-allocated Float32 ring buffer (no per-message array spread, no
// per-quantum allocation), a configurable prime threshold so playback does not start mid-underrun, and
// a frames-played counter so the main thread has a precise media position for the interrupt offset.
//
// Wire protocol (main thread -> worklet, via port.postMessage):
//   { type: "config", primeFrames }   set the prime threshold (samples buffered before output starts)
//   Int16Array                        enqueue mono PCM samples at the AudioContext sample rate
//   { type: "end" }                   no more samples will be sent; emit "ended" once the buffer drains
//   null | { type: "flush" }          clear the buffer immediately (barge-in / stop) — sub-frame
// Worklet -> main thread:
//   { type: "position", frames }      periodic frames-played report
//   { type: "ended" }                 the buffer drained after the "end" marker (natural completion)
//   { type: "backpressure", dropped } PCM samples refused because MAX_CAPACITY_SAMPLES was reached
//                                     (audit KEIKO-0471); the producer should pause sending.
//
// Raw audio is transient render-thread data only; nothing is persisted.

// Hard ceiling on ring-buffer growth (audit KEIKO-0471). Without one, a producer that keeps
// posting PCM into a worklet whose output is never drained (a detached/never-started
// AudioContext, or a runaway sender) grows the buffer without bound. Sized generously for one
// realistic worst-case streamed utterance: 30s at the 24kHz mono rate this pipeline actually
// runs at (see TARGET_SAMPLE_RATE in assistant-speech-streaming.ts, which creates the
// AudioContext at 24kHz so the worklet plays samples 1:1 with no resample). The real
// AudioWorkletGlobalScope exposes a live `sampleRate` global, but this file already hardcodes the
// 24kHz assumption elsewhere (see `primeFrames = 2400 // ~100ms at 24kHz` below) rather than
// reading it, so the ceiling follows the same convention instead of adding a second, inconsistent
// way to learn the rate.
const MAX_CAPACITY_SAMPLES = 720000; // 30s * 24000 Hz — no numeric separators for ES2019 compat

class KeikoPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = 0;
    this.ring = null; // Float32Array
    this.head = 0;
    this.tail = 0;
    this.size = 0;
    this.primeFrames = 2400; // ~100ms at 24kHz; overridden by the config message
    this.primed = false;
    this.draining = false;
    this.everPlayed = false;
    this.ended = false;
    this.framesPlayed = 0;
    this.sinceReport = 0;
    this.port.onmessage = (event) => {
      this.handle(event.data);
    };
  }

  ensureCapacity(extra) {
    const need = this.size + extra;
    if (this.ring !== null && need <= this.capacity) {
      return;
    }
    let cap = this.capacity === 0 ? 1 << 15 : this.capacity;
    while (cap < need && cap < MAX_CAPACITY_SAMPLES) {
      cap *= 2;
    }
    cap = Math.min(cap, MAX_CAPACITY_SAMPLES);
    if (this.ring !== null && cap === this.capacity) {
      // Already at the bounded ceiling (or the ceiling did not change): nothing to reallocate.
      // The caller must not write more than the remaining free space — see handle()'s `writable`.
      return;
    }
    const next = new Float32Array(cap);
    for (let i = 0; i < this.size; i += 1) {
      next[i] = this.ring[(this.head + i) % this.capacity];
    }
    this.ring = next;
    this.capacity = cap;
    this.head = 0;
    this.tail = this.size;
  }

  reset() {
    this.head = 0;
    this.tail = 0;
    this.size = 0;
    this.primed = false;
    this.draining = false;
    this.ended = false;
  }

  handle(data) {
    if (data === null || (typeof data === "object" && data.type === "flush")) {
      this.reset();
      return;
    }
    if (typeof data === "object" && data.type === "config") {
      if (typeof data.primeFrames === "number" && data.primeFrames >= 0) {
        this.primeFrames = data.primeFrames;
      }
      return;
    }
    if (typeof data === "object" && data.type === "end") {
      this.draining = true;
      // Force any sub-prime remainder to play out, then complete once drained.
      this.primed = true;
      if (this.size === 0) {
        this.finish();
      }
      return;
    }
    // Otherwise: an Int16Array of PCM samples.
    const pcm = data;
    const n = pcm.length;
    if (n === 0) {
      return;
    }
    this.ensureCapacity(n);
    // Bound the write to whatever room ensureCapacity actually secured. Once the ring is pinned at
    // MAX_CAPACITY_SAMPLES, `ensureCapacity` refuses to grow further, so `n` can exceed the free
    // space — writing past it would wrap the tail into not-yet-drained head data and silently
    // corrupt the buffer. Instead we write only what fits and report the remainder as dropped
    // (audit KEIKO-0471) so the producer can react to backpressure instead of losing audio unseen.
    const writable = Math.min(n, Math.max(0, this.capacity - this.size));
    for (let i = 0; i < writable; i += 1) {
      this.ring[this.tail] = pcm[i] / 32768;
      this.tail = (this.tail + 1) % this.capacity;
    }
    this.size += writable;
    const dropped = n - writable;
    if (dropped > 0) {
      this.port.postMessage({ type: "backpressure", dropped });
    }
    if (this.size >= this.primeFrames) {
      this.primed = true;
    }
  }

  finish() {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.port.postMessage({ type: "ended" });
  }

  process(_inputs, outputs) {
    const channel = outputs[0][0];
    if (channel !== undefined) {
      if (this.primed) {
        this.drainInto(channel);
      } else {
        // Before the prime threshold is reached, output silence (the source node stays alive).
        channel.fill(0);
      }
    }
    // Web Audio contract: return true to keep the processor node alive across quanta.
    return true;
  }

  drainInto(channel) {
    const need = channel.length;
    let i = 0;
    for (; i < need && this.size > 0; i += 1) {
      channel[i] = this.ring[this.head];
      this.head = (this.head + 1) % this.capacity;
      this.size -= 1;
    }
    const produced = i;
    for (; i < need; i += 1) {
      channel[i] = 0; // underrun → silence rather than a glitch
    }
    this.recordProduced(produced);
    // Natural completion: the sender marked the end and the buffer has fully drained.
    if (this.draining && this.size === 0) {
      this.finish();
    }
  }

  recordProduced(produced) {
    if (produced <= 0) return;
    this.everPlayed = true;
    this.framesPlayed += produced;
    this.sinceReport += produced;
    // Report position roughly every ~50ms so the main thread has a fresh media offset.
    if (this.sinceReport >= 1200) {
      this.sinceReport = 0;
      this.port.postMessage({ type: "position", frames: this.framesPlayed });
    }
  }
}

registerProcessor("keiko-playback", KeikoPlaybackProcessor);
