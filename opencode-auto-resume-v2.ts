import { z } from "zod"
import AutoResumePlugin from "opencode-auto-resume"

type LegacyEvent = { type: string; properties?: Record<string, any> }

function translateEvent(ev: any): LegacyEvent[] {
  const type: string = ev?.type ?? ""
  const data: Record<string, any> = ev?.data ?? {}
  const sid: string | undefined = data.sessionID
  const props = { ...data, sessionID: sid }

  switch (type) {
    case "session.execution.started":
      return [{ type: "session.status", properties: { sessionID: sid, status: { type: "busy" } } }]
    case "session.execution.succeeded":
      return [
        { type: "session.status", properties: { sessionID: sid, status: { type: "idle" } } },
        { type: "session.idle", properties: { sessionID: sid } },
      ]
    case "session.execution.failed":
      return [
        { type: "session.error", properties: { sessionID: sid, error: data.error } },
        { type: "session.status", properties: { sessionID: sid, status: { type: "idle" } } },
      ]
    case "session.execution.interrupted":
      return [{ type: "session.interrupted", properties: { sessionID: sid } }]
    case "session.created":
      return [{ type: "session.created", properties: { sessionID: sid, parentID: data.parentID, session: data } }]
    case "session.updated":
    case "session.renamed":
      return [{ type: "session.updated", properties: { sessionID: sid } }]
    default:
      if (sid) return [{ type: "message.updated", properties: props }]
      return []
  }
}

// OpenCode loads a plugin once per location/workspace inside the same server
// process. Each load would otherwise start its own v1 engine, event loop and
// stall detector — N engines then all fire "continue" prompts for the same
// stall, and each prompt interrupts whatever tool call is in flight (the
// "non-stop Tool execution interrupted" storm). Only the first instance in a
// process may run the engine; later loads become no-ops.
let instanceActive = false

export default {
  id: "opencode-auto-resume-v2",
  setup: async (context: any) => {
    if (instanceActive) {
      console.error("[auto-resume-v2] duplicate instance in this process - skipping (singleton)")
      return () => {}
    }
    instanceActive = true
    const abort = new AbortController()

    const bridgeClient = {
      app: {
        log: async ({ body }: any) => {
          try {
            console.error(`[auto-resume] ${body?.level ?? "info"}: ${body?.message ?? ""}`)
          } catch {}
        },
      },
      session: {
        prompt: async (input: any) => {
          const body = input?.body ?? {}
          const text = Array.isArray(body.parts)
            ? body.parts.map((p: any) => p?.text ?? "").join("")
            : (body.text ?? "")
          const req: any = { sessionID: input?.path?.id ?? input?.sessionID, text }
          const agent = body.agent ?? body.agents?.[0]?.name
          if (agent) req.agents = [{ name: agent }]
          return await context.session.prompt(req)
        },
        abort: async (input: any) => context.session.interrupt({ sessionID: input?.path?.id ?? input?.sessionID }),
        interrupt: async (input: any) => context.session.interrupt({ sessionID: input?.path?.id ?? input?.sessionID }),
        messages: async (input: any) => ({ data: await context.session.context({ sessionID: input?.path?.id ?? input?.sessionID }) }),
        context: async (input: any) => ({ data: await context.session.context({ sessionID: input?.path?.id ?? input?.sessionID }) }),
        status: async () => ({ data: {} }),
        list: async () => ({ data: [] }),
        todo: async () => ({ data: [] }),
        summarize: async () => undefined,
        command: async (input: any) =>
          context.session.command({
            sessionID: input?.path?.id ?? input?.sessionID,
            command: input?.body?.command ?? "",
            text: input?.body?.arguments ?? input?.body?.text ?? "",
          }),
      },
      config: { get: async () => ({ data: {} }) },
      provider: { get: async () => ({ data: {} }) },
    }

    const legacyCtx = {
      client: bridgeClient,
      app: {},
      directory: context.location?.directory ?? process.cwd(),
      worktree: context.location?.directory ?? process.cwd(),
      serverUrl: undefined,
      $: undefined,
    }

    let hooks: any
    try {
      hooks = await (AutoResumePlugin as any)(legacyCtx, context.options ?? {})
    } catch (e) {
      console.error("[auto-resume-v2] construction failed:", e)
      instanceActive = false
      return () => {}
    }

    try {
      await hooks?.config?.()
    } catch {}

    if (hooks?.tool) {
      try {
        await context.tool.transform((draft: any) => {
          for (const [name, def] of Object.entries<any>(hooks.tool)) {
            let input: any
            try {
              input = z.toJSONSchema(z.object(def.args ?? {}))
            } catch {
              input = { type: "object", properties: {}, additionalProperties: true }
            }
            draft.add({
              name,
              description: def.description,
              input,
              execute: async (args: any, toolContext: any) => {
                try {
                  const r = await def.execute(args, { sessionID: toolContext?.sessionID })
                  return { content: typeof r === "string" ? r : "" }
                } catch (e) {
                  return { content: `auto-resume tool error: ${String((e as any)?.message ?? e)}` }
                }
              },
            })
          }
        })
      } catch (e) {
        console.error("[auto-resume-v2] tool registration failed:", e)
      }
    }

    if (hooks?.["chat.message"]) {
      try {
        await context.session.hook("prompt", (input: any) => hooks["chat.message"]({ sessionID: input?.sessionID }))
      } catch (e) {
        console.error("[auto-resume-v2] prompt hook failed:", e)
      }
    }

    if (hooks?.["tool.execute.before"]) {
      try {
        await context.tool.hook("execute.before", (input: any) =>
          hooks["tool.execute.before"]({ sessionID: input?.sessionID, tool: input?.tool, args: input?.input }, { args: input?.input }),
        )
      } catch (e) {
        console.error("[auto-resume-v2] tool.execute.before hook failed:", e)
      }
    }

    if (hooks?.["tool.execute.after"]) {
      try {
        await context.tool.hook("execute.after", (input: any) => hooks["tool.execute.after"]({ sessionID: input?.sessionID }))
      } catch (e) {
        console.error("[auto-resume-v2] tool.execute.after hook failed:", e)
      }
    }

    ;(async () => {
      try {
        const sub: any = context.event.subscribe({ signal: abort.signal })
        const it = sub[Symbol.asyncIterator]()
        while (true) {
          const { done, value } = await it.next()
          if (done) break
          let ev = value
          if (typeof ev === "string") {
            try {
              ev = JSON.parse(ev)
            } catch {
              continue
            }
          }
          for (const legacyEvent of translateEvent(ev)) {
            try {
              await hooks?.event?.({ event: legacyEvent })
            } catch (e) {
              console.error("[auto-resume-v2] event handling failed:", e)
            }
          }
        }
      } catch (e) {
        if (!abort.signal.aborted) console.error("[auto-resume-v2] event loop stopped:", e)
      }
    })()

    return () => {
      instanceActive = false
      abort.abort()
    }
  },
}
