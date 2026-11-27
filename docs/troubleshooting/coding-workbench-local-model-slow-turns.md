# Coding Workbench turns are slow or stall on a self-hosted local model

| Field             | Value                                                                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Severity          | Medium                                                                                                                                                                 |
| Surface           | Model gateway / Run engine                                                                                                                                             |
| Stable identifier | `gateway.prompt.admission` (`promptTokens`), `http.gateway.fetch.completed` (duration) and `http.gateway.fetch.failed` with a cancelled kind on the Activity Log lines |

**Symptom**

A Coding Workbench run on a self-hosted model served through a LiteLLM proxy in front of Ollama (for
example a 31B model on Apple silicon with the mlx runtime) behaves in one of four ways:

- The first model response of a new coding task takes one to five minutes, while later turns answer
  quickly.
- Partway through a run, one turn is suddenly as slow as the first one again.
- After pressing Stop and sending a new message, the next turn waits for minutes before the model
  starts to answer.
- A turn that followed a very large test output or a large file read is slow.

No error is shown in any of these cases; the run is waiting for the model server.

**Root Cause**

All four cases are properties of local model serving, not defects in Keiko. Keiko sends the prompt and
waits for the model server to answer.

1. **First-turn latency is prompt prefill.** The first prompt of a coding task carries the system
   prompt, the tool catalog, the repository instructions and, on large repositories, search results.
   It is typically 9k to 40k tokens. A 31B local model processes prompt tokens (prefill) at roughly
   120 to 150 tokens per second, so the first response can take one to five minutes. Later turns share
   a long prefix with the earlier ones and reuse the server's prefix cache, so only the new tokens are
   prefilled.
2. **A full re-prefill in the middle of a run means the cache was lost.** The model was unloaded, either
   because `OLLAMA_KEEP_ALIVE` (default five minutes) expired during a long tool step such as a build
   or a test run, or because someone ran `ollama stop` from outside. The next turn then reloads the
   model and prefills the whole prompt again. A too-small context, or several parallel sequences
   sharing one GPU, can also evict the cached prefix.
3. **Stop does not stop the model server.** Keiko cancels its own gateway request at once. The proxy or
   the model server may not notice the client disconnect and keeps prefilling the abandoned prompt. The
   next turn queues behind that work.
4. **Very large tool results** (huge test output, a big file read) add tens of thousands of tokens to
   the next prompt and therefore minutes of prefill. Keiko caps tool output at the upstream OpenCode
   limits and shows when output was shortened; a result below those limits can still be large for a
   local model.

**Diagnostic Steps**

1. Read the Activity Log for the slow turn. The two lines to compare share one `correlationId`:

   ```bash
   keiko support query --op gateway.prompt.admission --json
   keiko support query --op http.gateway.fetch.completed --json
   keiko support query --op http.gateway.fetch.failed --json
   ```

   `promptTokens` on `gateway.prompt.admission` is the size of the prompt that was sent; the duration
   on `http.gateway.fetch.completed` is the time the model server needed. A large `promptTokens` with a
   long duration on the first turn and short durations afterwards confirms case 1. A long duration on
   a later turn whose `promptTokens` barely grew confirms case 2. A `http.gateway.fetch.failed` line
   with a cancelled kind right before a slow turn confirms case 3. A single turn whose `promptTokens`
   jumped by tens of thousands confirms case 4.

2. Read the Ollama server log on the host that runs the model. Look for the `Prompt processing
progress` lines and the prefix cache lines: a `cache hit` means the prefix was reused, a
   `cache miss` on a later turn means a full re-prefill. A model load line shortly before the slow turn
   confirms an unload.

3. Check what the model server holds right now. If the model is not listed, it was unloaded:

   ```bash
   ollama ps
   ```

4. For case 3, look at the model server while Keiko is idle after a Stop. If it still reports
   prompt processing for a request Keiko no longer has open, the abandoned prompt is still running
   upstream.

If the duration is long but `promptTokens` is small and the model server shows no work, consult
[LiteLLM Production Gateway](litellm-production-gateway.md) instead.

**Resolution**

1. **First turn:** nothing is wrong. Expect the first response to take as long as prefill needs, and
   plan the first prompt of a task accordingly. Keep repository instruction files short, and prefer a
   focused task over one that makes the model search a large repository first. Later turns are fast
   while the prefix cache stays warm.
2. **Unloads and cache loss:** configure the model server, not Keiko.
   - Set `OLLAMA_KEEP_ALIVE` to a long value such as `2h` so a long tool step does not unload the model.
   - Set `OLLAMA_NUM_PARALLEL=1` on a single-GPU host so one sequence keeps its cache.
   - Use a context of at least 128k tokens for coding runs.
   - Do not run `ollama stop` against the model while a run is active.
3. **After Stop:** make sure the proxy propagates a client disconnect to the model server, or wait for
   the server to go idle before sending the next message. This is outside Keiko; Keiko's own request is
   already cancelled.
4. **Large tool results:** ask the model to narrow the command (a single test file, a filtered output,
   a line range of the file) instead of reading everything. Keiko shows when output was shortened; the
   cap is an upstream limit and is not raised to save prefill time.

Do not weaken any Keiko limit, redaction or authority setting to shorten a slow turn: the time is spent
in the model server, and those settings do not change it.
