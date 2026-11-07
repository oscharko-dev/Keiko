# MemoriaViva learning passes

Keiko learns from a Chat later, in passes, never while the person waits for an answer (#4213,
ADR-0146 D4d). This page records how a pass is triggered, what bounds it and how the default pause
was measured.

## What a pass does

A turn written with memory on is marked on its stored message (`memory_learning`, plus the autonomy
mode the person asked for). Nothing is extracted at message time; the text stays in the Chat's own
messages. Each Chat keeps a learned position (`chat_memory_learning`: timestamp, insertion order)
that only moves forward.

A pass reads the messages after a Chat's position in Chat order, pairs each of the person's messages
with the answers up to their next message and learns from the person's words through the same
governed capture a turn used before (salience extraction, deterministic admission, mode-aware
status, hard denials first). After each turn the position moves past it, so a stopped server neither
loses nor repeats a turn.

| Trigger        | When                                                                             |
| -------------- | -------------------------------------------------------------------------------- |
| `inactivity`   | No Chat work for the pause after a marked turn (default 15 s)                    |
| `chat-change`  | The person opens a different Chat than the one opened before                     |
| `startup`      | 5 s after the server listens, for what was left before the last stop             |
| `retry`        | The model was unavailable; backoff from 60 s, doubling, at most 30 min           |
| `continuation` | The pass hit its bounds (8 Chats, 16 turns per Chat); the rest follows after 1 s |

`KEIKO_MEMORY_LEARNING_IDLE_MS` (0 to 3,600,000) replaces the default pause; `0` learns as soon as a
turn settles, which the end-to-end lanes use.

## Foreground work wins

Any serialized Chat turn (send, stream, grounded answer, delete) is foreground work. A pass does not
start while one runs, and a starting turn aborts a running pass. The abort reaches the provider
request (`ModelPort.call` signal, gateway cancellation, `fetch`), so the model slot is free for the
person at once. The cancelled turn stays pending and is learned by the next pass.

## Outcomes per turn

- **Learned**: the capture ran; the position moves on.
- **Memory off**: a message written with memory off is never learned, even if memory is switched on
  later.
- **Unavailable**: no model port or a `GATEWAY_*` failure; the turn stays pending and a `retry` pass
  follows.
- **Failed**: any other error is recorded as a body-free diagnostic and retried; after three attempts
  the turn is skipped so it cannot hold the Chat back.

A forget the pass reaches in Chat order ("Vergiss, dass …") is applied again to the facts the pass
has just learned from the same Chat's earlier messages, which were still pending when the person
asked. A forget that refers to the previous message ("Vergiss das") leaves its tombstone at message
time, which keeps that message from being learned.

An edited message is a new turn: Chat messages are not edited in place, so the edit is learned as
the person's later words and the ordinary supersession rules (ADR-0146 D4c) decide whether it
replaces the earlier fact.

## The default pause, measured

The pause decides two things: how often a pass starts only to be cancelled by the person's next
message, and how many turns are learned before the person writes again. Measured on the licensed
WildChat-de anchor corpus (2,357 conversations, 7,988 follow-ups; gaps between consecutive answer
timestamps only, no text was read), assuming a pass of 20 s and 15 s of answer generation inside
each gap:

| Pause | Passes cancelled by the next message | Turns learned before the next message |
| ----: | -----------------------------------: | ------------------------------------: |
|  15 s |                               10.9 % |                                80.1 % |
|  30 s |                               11.2 % |                                71.6 % |
|  45 s |                                9.9 % |                                64.3 % |
|  60 s |                                8.0 % |                                58.5 % |
| 120 s |                                4.4 % |                                41.8 % |

Between 15 and 60 s the cancellation share hardly moves, while every second of extra pause loses
turns that could have been learned before the next message. A cancelled pass costs only the aborted
model call; the turn is learned again. The default is therefore 15 s. Longer pauses only pay off
beyond two minutes, where most turns wait for the next pause or for a change of Chat.

## Evidence

`memory.learn.pass.started` and `memory.learn.pass.settled` carry the pass id as correlation and the
triggering request (or `UNKNOWN_CORRELATION_ID` for a timer) as parent. The settled line records the
closed trigger and outcome, Chat, turn, learned, skipped, memory-off, forgotten and failed counts,
the capture action count, the Chats still pending, the duration and, for a cancelled pass, the
cancellation latency. The learning model call carries the pass id as its parent correlation, and the
existing `memory.learn.extraction`, `memory.learn.dropped` and `memory.learn.relation` lines carry
the turn's correlation. No words of the person or of a fact enter the Activity Log.
