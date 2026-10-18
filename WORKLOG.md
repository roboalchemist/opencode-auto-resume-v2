# WORKLOG

Challenges encountered while building this adapter, so they don't get rediscovered.

## 2026-10-18 — 0.1.1 killed live tool calls ("Tool execution interrupted" storm)

### Symptom

On OpenCode 2.0.25 every tool call that ran longer than ~18s (or every tool in a
session whose location did not own the plugin's tool hooks) died with
`Tool execution interrupted` / `Step interrupted`, then nothing resumed.

### What was actually happening

The upstream v1 engine decides a session is "stuck" and calls
`session.abort()` + `session.prompt("continue")`. Three adapter bugs made that
fire on healthy sessions:

1. **In-flight tools were invisible.** The engine's
   `checkSessionHasActiveTool()` reads v1 message shape
   (`parts[].type === "tool_use"`, `tool_calls`, `toolCall`) and
   `session.status()`. The v2 adapter returned `{}` for status, and v2
   messages store tools as `content: [{type:"tool", state:{status}}]`, so both
   checks said "no tool running" while `sleep 25` was running. The engine's 15s
   orphan/stuck-parent branch (`subagentWaitMs`) then aborted at 15s + 3s grace
   + 5s poll ≈ 18–25s. That is exactly the duration band users saw.
2. **The adapter ate its own resume.** OpenCode v2 emits
   `session.execution.interrupted` for *every* abort, including programmatic
   ones. The adapter translated it to `session.interrupted`, whose handler sets
   `w.userCancelled = true` ("interrupted by user, backing off").
   `tryAbortAndResume()` sleeps 2s and then checks `userCancelled` before
   sending the continue prompt — so the resume was skipped, or (when the event
   lost the race) sent and then aborted again ~20s later.
3. **Activity was blind.** Every unrecognised v2 event was forwarded as
   `message.updated` with no `info.role` / no tokens. The engine's activity
   tracking therefore never saw `session.step.*`, `session.tool.*`,
   `session.text.*` or `session.reasoning.*`.

### How it was proven

An isolated `opencode serve` (own `OPENCODE_DB`, stderr captured) with the
plugin config, driving sessions in a *second* directory:

- `sleep 25` in the plugin's own location: fine (the `execute.before` hook kept
  `pendingTools=1`).
- `sleep 25` in a different location: aborted at "21s idle" with
  `Parent ... stuck with no active subagents. Triggering abort+resume.`
- Removing the plugin: same test passed 4/4.

That is the regression test shape to keep: **two locations, one long tool,
plus a second session finishing mid-tool** (the 2→1 busy transition sets the
engine's orphan watch on the remaining session).

### v2 event model (as observed on 2.0.25)

`context.session.context({sessionID})` returns the message array directly.
Messages are `{id, type: "user"|"assistant"|"idle", text?, content?[], tokens?,
finish?}`. The event bus emits, among others:

```
session.execution.started | succeeded | failed | interrupted   {sessionID, error?}
session.step.started | streamed | ended                        {assistantMessageID, finish, tokens}
session.tool.input.started | input.ended | called | progress | success   {id, name?, input?, content?}
session.text.* | session.reasoning.*                           {ordinal, delta?, text?}
session.inbox.enqueued | delivered                             {inboxID, item?}
session.created | updated | renamed
```

There is **no `message.updated` event** in v2, which is why the blanket
translation in 0.1.1 was useless.

### Fix

- `adapter.ts`: pure state machine over the event bus (per-session `running`,
  live tool ids, `lastActivityAt`), `normalizeMessages()`, explicit event
  mapping, self-abort suppression (15s window).
- `status()` reports `busy` while a tool is live or while a running session
  emitted an event in the last 90s. It deliberately goes `idle` after that so
  the engine's 180s chunk-timeout recovery still works.
- Default `continuePrompt` replaced with a guarded instruction (upstream #45
  notes the bare `"continue"` caused harm).
- `tool.ids` answered from `context.tool.list()` instead of throwing
  `undefined is not an object (evaluating 'ctx.client.tool.ids')` on every
  check.

### Gotchas

- The plugin is loaded **once per location** in a server process; a
  module-level singleton keeps one engine. But `tool.execute.before/after`
  hooks are registered per location, so a session in another directory never
  increments `pendingTools`. Never rely on `pendingTools` alone for
  cross-location sessions — the event-derived status is what makes this safe.
- `session.step.started` clears tracked in-flight tools: a new step only
  starts after the previous step's tools settled, so anything still marked
  live is stale and would otherwise pin the session "busy" forever.
- A failed shell command is still `session.tool.success` (the tool returns an
  exit code in its content). Only real tool failures emit
  `session.tool.failed`/`error`, so handle both.
