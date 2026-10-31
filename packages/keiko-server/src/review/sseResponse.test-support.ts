// A recording stand-in for the `ServerResponse` of a review progress stream (Issues #4136, #4137):
// it records every written frame and lets a test choose whether a write reports a full buffer.

import { EventEmitter } from "node:events";

export class FakeSseResponse extends EventEmitter {
  public destroyed = false;
  public writableEnded = false;
  public writableFinished = false;
  public writableNeedDrain = false;
  public accept = true;
  public readonly frames: string[] = [];

  public writeHead(): this {
    return this;
  }

  public write(chunk: string): boolean {
    this.frames.push(chunk);
    return this.accept;
  }

  public end(): this {
    this.writableEnded = true;
    this.writableFinished = true;
    this.emit("finish");
    this.emit("close");
    return this;
  }

  public destroy(): this {
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}

/** The parsed data of every frame with the given SSE event name. */
export function sseEvents<Event>(response: FakeSseResponse, eventName: string): Event[] {
  return response.frames
    .filter((frame) => frame.startsWith(`event: ${eventName}\n`))
    .map((frame) => JSON.parse(frame.slice(frame.indexOf("data: ") + 6)) as Event);
}
