/**
 * Pure adapter helpers: OpenCode v2 event/message shapes -> the shapes the v1
 * opencode-auto-resume engine reasons about.
 *
 * Kept free of runtime imports so it can be unit-tested without the host.
 */

export type LegacyEvent = { type: string; properties?: Record<string, any> }
export type SessionStatus = "busy" | "idle"

/**
 * A tool call counts as live while OpenCode is streaming its arguments or
 * running it. Anything else (completed/error) is history.
 */
export const ACTIVE_TOOL_STATES = new Set(["streaming", "running"])

/**
 * How long a session with no events still counts as "busy".
 *
 * The v1 engine's `checkSessionHasActiveTool()` treats "busy" as "probably
 * executing a tool" and skips every abort path. That is the safety net that
 * stops the adapter from killing live tool calls, so it must stay true while
 * the engine is producing events, but must expire before the engine's own
 * stall timeout (180s) so real stalls can still be recovered.
 */
export const BUSY_WINDOW_MS = 90_000

/**
 * The v1 engine aborts by calling `session.abort()`; OpenCode v2 reports that
 * as `session.execution.interrupted`, which the engine would otherwise read as
 * "the user cancelled" — set `userCancelled` and stand down before sending the
 * resume prompt. Events for aborts we initiated inside this window are
 * swallowed so the engine's own abort+resume can finish.
 */
export const SELF_ABORT_WINDOW_MS = 15_000

/**
 * Replaces the v1 default of the bare string "continue", which is an unbounded
 * instruction and makes resumed turns wander (Mte90/opencode-auto-resume#45).
 */
export const DEFAULT_CONTINUE_PROMPT =
  "Continue exactly where you left off. " +
  "If a tool call was interrupted before it finished, re-run that same command from the start now. " +
  "Do not repeat steps that already completed and do not redo work whose output you already have."

export type SessionRuntime = {
  running: boolean
  tools: Set<string>
  lastActivityAt: number
}

export type AdapterState = {
  sessions: Map<string, SessionRuntime>
  selfAbortAt: Map<string, number>
}

export function createState(): AdapterState {
  return { sessions: new Map(), selfAbortAt: new Map() }
}

export function sessionRuntime(state: AdapterState, sessionID: string): SessionRuntime {
  let rt = state.sessions.get(sessionID)
  if (!rt) {
    rt = { running: false, tools: new Set(), lastActivityAt: 0 }
    state.sessions.set(sessionID, rt)
  }
  return rt
}

/** Mark an abort as ours so the resulting `interrupted` event is ignored. */
export function noteSelfAbort(state: AdapterState, sessionID: string, at = Date.now()) {
  if (sessionID) state.selfAbortAt.set(sessionID, at)
}

/** True when the interrupted event belongs to an abort this adapter issued. */
export function consumeSelfAbort(state: AdapterState, sessionID: string, now = Date.now()): boolean {
  const at = state.selfAbortAt.get(sessionID) ?? 0
  if (!at) return false
  state.selfAbortAt.delete(sessionID)
  return now - at < SELF_ABORT_WINDOW_MS
}

/**
 * Snapshot in the shape v1's `session.status()` returns.
 *
 * Busy means "may be executing a tool": either a tool call is live, or the
 * session is running and produced an event recently. It deliberately goes idle
 * after `BUSY_WINDOW_MS` of silence so the engine's 180s stall recovery can
 * still fire on a genuinely dead stream.
 */
export function statusSnapshot(state: AdapterState, now = Date.now()): Record<string, SessionStatus> {
  const data: Record<string, SessionStatus> = {}
  for (const [sessionID, rt] of state.sessions) {
    const liveTool = rt.tools.size > 0
    const recent = rt.running && now - rt.lastActivityAt < BUSY_WINDOW_MS
    data[sessionID] = liveTool || recent ? "busy" : "idle"
  }
  return data
}

/**
 * Convert the v2 message model (`content: [{type:"tool", state:{status}}]`)
 * into the v1 shape the engine reasons about (`parts: [{type:"tool_use",
 * state:{status}}]`).
 *
 * Only live tools become `tool_use` with status `pending`; completed ones stay
 * `completed`. Mapping history as in-flight would make
 * `checkSessionHasActiveTool()` permanently true and disable all recovery.
 */
export function normalizeMessages(payload: any): any[] {
  const raw: any[] = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.messages)
        ? payload.messages
        : []

  const out: any[] = []
  for (const message of raw) {
    const role = message?.type ?? message?.role ?? message?.info?.role
    if (role !== "user" && role !== "assistant") continue

    if (role === "user") {
      const text = typeof message.text === "string"
        ? message.text
        : Array.isArray(message.content)
          ? message.content.map((c: any) => c?.text ?? "").join("")
          : ""
      out.push({
        ...message,
        role: "user",
        info: { ...(message.info ?? {}), id: message.id, role: "user", time: message.time },
        parts: [{ type: "text", text }],
      })
      continue
    }

    const parts: any[] = []
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part?.type === "text") {
        parts.push({ type: "text", text: part.text ?? "" })
      } else if (part?.type === "reasoning") {
        parts.push({ type: "reasoning", text: part.text ?? "" })
      } else if (part?.type === "tool") {
        const rawStatus = part.state?.status
        const live = ACTIVE_TOOL_STATES.has(rawStatus)
        parts.push({
          type: "tool_use",
          id: part.id,
          name: part.name ?? "unknown",
          input: part.state?.input,
          state: {
            status: live ? "pending" : rawStatus === "error" ? "error" : "completed",
            input: part.state?.input,
          },
        })
      }
    }

    out.push({
      ...message,
      role: "assistant",
      info: {
        ...(message.info ?? {}),
        id: message.id,
        role: "assistant",
        time: message.time,
        tokens: message.tokens,
        finish: message.finish,
        error: message.error,
      },
      parts,
    })
  }
  return out
}

/**
 * Translate one OpenCode v2 event into the v1 events the engine subscribes to.
 * Unknown events are dropped on purpose: the previous adapter forwarded them
 * all as `message.updated`, which carried no role or tokens and only confused
 * the engine.
 */
export function translateEvent(state: AdapterState, ev: any, now = Date.now()): LegacyEvent[] {
  const type: string = ev?.type ?? ""
  const data: Record<string, any> = ev?.data ?? {}
  const sessionID: string | undefined = data.sessionID
  if (!sessionID) return []

  const rt = sessionRuntime(state, sessionID)
  const touch = () => {
    rt.lastActivityAt = now
  }

  switch (type) {
    case "session.execution.started":
      rt.running = true
      rt.tools.clear()
      touch()
      return [{ type: "session.status", properties: { sessionID, status: { type: "busy" } } }]

    case "session.execution.succeeded":
      rt.running = false
      rt.tools.clear()
      touch()
      return [
        { type: "session.status", properties: { sessionID, status: { type: "idle" } } },
        { type: "session.idle", properties: { sessionID } },
      ]

    case "session.execution.failed":
      rt.running = false
      rt.tools.clear()
      touch()
      return [
        { type: "session.error", properties: { sessionID, error: data.error } },
        { type: "session.status", properties: { sessionID, status: { type: "idle" } } },
      ]

    case "session.execution.interrupted": {
      rt.running = false
      rt.tools.clear()
      touch()
      if (consumeSelfAbort(state, sessionID, now)) return []
      return [{ type: "session.interrupted", properties: { sessionID } }]
    }

    case "session.tool.called":
      if (data.id) rt.tools.add(data.id)
      touch()
      return []

    case "session.tool.success":
    case "session.tool.failed":
    case "session.tool.error":
    case "session.tool.cancelled":
      if (data.id) rt.tools.delete(data.id)
      touch()
      return []

    case "session.step.started":
      // A new step only starts once the previous step's tools have settled, so
      // anything still marked in-flight is stale (e.g. a tool that crashed
      // without emitting a terminal event). Never let it pin the session busy.
      rt.tools.clear()
      touch()
      return []

    case "session.tool.input.started":
    case "session.tool.input.ended":
    case "session.tool.progress":
    case "session.step.streamed":
    case "session.text.started":
    case "session.text.delta":
    case "session.text.ended":
    case "session.reasoning.started":
    case "session.reasoning.delta":
    case "session.reasoning.ended":
    case "session.usage.updated":
      touch()
      return []

    case "session.step.ended":
      touch()
      return [{
        type: "message.updated",
        properties: {
          sessionID,
          info: {
            id: data.assistantMessageID,
            role: "assistant",
            finish: data.finish,
            rawFinish: data.rawFinish,
            cost: data.cost,
            tokens: data.tokens,
            time: { created: now },
          },
        },
      }]

    case "session.inbox.delivered":
      touch()
      return [{ type: "message.updated", properties: { sessionID, info: { role: "user", time: { created: now } } } }]

    case "session.created":
      return [{
        type: "session.created",
        properties: { sessionID, parentID: data.parentID ?? data.session?.parentID, session: data },
      }]

    case "session.updated":
    case "session.renamed":
      return [{ type: "session.updated", properties: { sessionID } }]

    default:
      return []
  }
}
