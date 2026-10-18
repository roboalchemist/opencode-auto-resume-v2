import { describe, expect, test } from "bun:test"
import {
  BUSY_WINDOW_MS,
  DEFAULT_CONTINUE_PROMPT,
  createState,
  normalizeMessages,
  noteSelfAbort,
  sessionRuntime,
  statusSnapshot,
  translateEvent,
} from "../adapter"

const SID = "ses_test"

describe("normalizeMessages", () => {
  test("keeps users and assistants, drops idle/system entries", () => {
    const out = normalizeMessages([
      { id: "m1", type: "user", text: "hello" },
      { id: "m2", type: "assistant", content: [{ type: "text", text: "hi" }] },
      { id: "m3", type: "idle", outcome: "succeeded" },
    ])
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(out[0].parts).toEqual([{ type: "text", text: "hello" }])
  })

  test("only live tools become tool_use/pending", () => {
    const out = normalizeMessages({
      data: [
        {
          id: "m2",
          type: "assistant",
          content: [
            { type: "text", text: "working" },
            { type: "tool", id: "c1", name: "shell", state: { status: "running", input: { command: "sleep 60" } } },
            { type: "tool", id: "c0", name: "read", state: { status: "completed", input: {} } },
            { type: "tool", id: "c2", name: "write", state: { status: "error" } },
          ],
        },
      ],
    })[0]

    const toolParts = out.parts.filter((p: any) => p.type === "tool_use")
    expect(toolParts).toHaveLength(3)
    expect(toolParts[0].state.status).toBe("pending")
    expect(toolParts[1].state.status).toBe("completed")
    expect(toolParts[2].state.status).toBe("error")
  })

  test("carries finish and tokens into info", () => {
    const out = normalizeMessages([
      { id: "m2", type: "assistant", finish: "stop", tokens: { input: 1, output: 2 }, content: [] },
    ])[0]
    expect(out.info.finish).toBe("stop")
    expect(out.info.tokens).toEqual({ input: 1, output: 2 })
    expect(out.info.role).toBe("assistant")
  })
})

describe("statusSnapshot", () => {
  test("a live tool is busy regardless of age", () => {
    const state = createState()
    const rt = sessionRuntime(state, SID)
    rt.tools.add("c1")
    rt.lastActivityAt = 0
    expect(statusSnapshot(state, Date.now())[SID]).toBe("busy")
  })

  test("a recently active running session is busy", () => {
    const state = createState()
    const rt = sessionRuntime(state, SID)
    rt.running = true
    rt.lastActivityAt = Date.now()
    expect(statusSnapshot(state)[SID]).toBe("busy")
  })

  test("a running session goes idle after the busy window so stalls can recover", () => {
    const state = createState()
    const rt = sessionRuntime(state, SID)
    rt.running = true
    rt.lastActivityAt = Date.now() - BUSY_WINDOW_MS - 1
    expect(statusSnapshot(state)[SID]).toBe("idle")
    expect(BUSY_WINDOW_MS).toBeLessThan(180_000)
  })
})

describe("translateEvent", () => {
  test("execution.started marks busy and clears stale tools", () => {
    const state = createState()
    sessionRuntime(state, SID).tools.add("stale")
    const events = translateEvent(state, { type: "session.execution.started", data: { sessionID: SID } })
    expect(events).toEqual([
      { type: "session.status", properties: { sessionID: SID, status: { type: "busy" } } },
    ])
    expect(sessionRuntime(state, SID).tools.size).toBe(0)
  })

  test("tool.called/success track live tools", () => {
    const state = createState()
    translateEvent(state, { type: "session.tool.called", data: { sessionID: SID, id: "c1" } })
    expect(sessionRuntime(state, SID).tools.has("c1")).toBe(true)
    expect(statusSnapshot(state)[SID]).toBe("busy")
    translateEvent(state, { type: "session.tool.success", data: { sessionID: SID, id: "c1" } })
    expect(sessionRuntime(state, SID).tools.size).toBe(0)
  })

  test("our own abort's interrupted event is swallowed", () => {
    const state = createState()
    noteSelfAbort(state, SID)
    const events = translateEvent(state, { type: "session.execution.interrupted", data: { sessionID: SID } })
    expect(events).toEqual([])
    expect(state.selfAbortAt.has(SID)).toBe(false)
  })

  test("a genuine user interrupt still reaches the engine", () => {
    const state = createState()
    const events = translateEvent(state, { type: "session.execution.interrupted", data: { sessionID: SID } })
    expect(events).toEqual([{ type: "session.interrupted", properties: { sessionID: SID } }])
  })

  test("stale self-abort markers do not swallow later interrupts", () => {
    const state = createState()
    noteSelfAbort(state, SID, Date.now() - 60_000)
    const events = translateEvent(state, { type: "session.execution.interrupted", data: { sessionID: SID } })
    expect(events[0]?.type).toBe("session.interrupted")
  })

  test("a new step clears stale in-flight tools", () => {
    const state = createState()
    sessionRuntime(state, SID).tools.add("crashed")
    translateEvent(state, { type: "session.step.started", data: { sessionID: SID } })
    expect(sessionRuntime(state, SID).tools.size).toBe(0)
  })

  test("step.ended feeds finish and tokens to the engine", () => {
    const state = createState()
    const [event] = translateEvent(state, {
      type: "session.step.ended",
      data: { sessionID: SID, assistantMessageID: "m2", finish: "stop", rawFinish: "end_turn", tokens: { input: 5, output: 6 }, cost: 0.01 },
    })
    expect(event.type).toBe("message.updated")
    expect(event.properties?.info.role).toBe("assistant")
    expect(event.properties?.info.finish).toBe("stop")
    expect(event.properties?.info.tokens).toEqual({ input: 5, output: 6 })
  })

  test("inbox.delivered marks a user message", () => {
    const state = createState()
    const [event] = translateEvent(state, { type: "session.inbox.delivered", data: { sessionID: SID, inboxID: "i1" } })
    expect(event.type).toBe("message.updated")
    expect(event.properties?.info.role).toBe("user")
  })

  test("the old blanket message.updated mapping is gone", () => {
    const state = createState()
    expect(translateEvent(state, { type: "session.reasoning.delta", data: { sessionID: SID, delta: "x" } })).toEqual([])
    expect(translateEvent(state, { type: "provider.updated", data: {} })).toEqual([])
  })
})

test("continue prompt is guarded rather than a bare 'continue'", () => {
  expect(DEFAULT_CONTINUE_PROMPT).not.toBe("continue")
  expect(DEFAULT_CONTINUE_PROMPT.toLowerCase()).toContain("re-run")
})
