/**
 * Installs a deterministic microphone and MediaRecorder before any application script runs.
 *
 * The fake makes dictation capability independent of the Playwright engine's host-media support
 * while the product still executes its real feature probe and recorder lifecycle. No microphone,
 * provider, or OS codec is touched by these browser journeys.
 */
export function fakeDictationMediaInit(mode: "grant" | "deny"): string {
  return `
    (() => {
      const mode = ${JSON.stringify(mode)};
      const fakeTrack = { stop() {} };
      const fakeStream = { getTracks: () => [fakeTrack] };
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: async () => {
            if (mode === "deny") {
              const error = new Error("denied");
              error.name = "NotAllowedError";
              throw error;
            }
            return fakeStream;
          },
        },
      });
      class FakeMediaRecorder {
        static isTypeSupported() { return true; }
        constructor() { this.state = "inactive"; this.mimeType = "audio/webm"; this._l = {}; }
        addEventListener(type, cb) { (this._l[type] ||= []).push(cb); }
        emit(type, event = {}) {
          for (const cb of this._l[type] || []) cb(event);
        }
        start() {
          this.state = "recording";
          queueMicrotask(() => this.emit("start"));
        }
        requestData() {
          if (this.state !== "recording") return;
          this.emit("dataavailable", {
            data: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }),
          });
        }
        stop() {
          this.state = "inactive";
          this.emit("dataavailable", {
            data: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }),
          });
          this.emit("stop");
        }
      }
      window.MediaRecorder = FakeMediaRecorder;
    })();
  `;
}
