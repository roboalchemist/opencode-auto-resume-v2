import { z } from "zod"
import AutoResumePlugin from "opencode-auto-resume"
import {
  DEFAULT_CONTINUE_PROMPT,
  createState,
  normalizeMessages,
  noteSelfAbort,
  statusSnapshot,
  translateEvent,
} from "./adapter"

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

    const state = createState()
    const abort = new AbortController()
    const sessionIDOf = (input: any) => input?.path?.id ?? input?.sessionID

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
          const req: any = { sessionID: sessionIDOf(input), text }
          const agent = body.agent ?? body.agents?.[0]?.name
          if (agent) req.agents = [{ name: agent }]
          return await context.session.prompt(req)
        },
        abort: async (input: any) => {
          const sessionID = sessionIDOf(input)
          noteSelfAbort(state, sessionID)
          return context.session.interrupt({ sessionID })
        },
        interrupt: async (input: any) => {
          const sessionID = sessionIDOf(input)
          noteSelfAbort(state, sessionID)
          return context.session.interrupt({ sessionID })
        },
        messages: async (input: any) => ({
          data: normalizeMessages(await context.session.context({ sessionID: sessionIDOf(input) })),
        }),
        context: async (input: any) => ({
          data: normalizeMessages(await context.session.context({ sessionID: sessionIDOf(input) })),
        }),
        status: async () => ({ data: statusSnapshot(state) }),
        list: async () => ({ data: [] }),
        todo: async () => ({ data: [] }),
        summarize: async () => undefined,
        command: async (input: any) =>
          context.session.command({
            sessionID: sessionIDOf(input),
            command: input?.body?.command ?? "",
            text: input?.body?.arguments ?? input?.body?.text ?? "",
          }),
      },
      tool: {
        // Lets the engine's unknown-tool detection see the real tool list.
        ids: async () => {
          try {
            const result = await context.tool.list()
            const list = Array.isArray(result) ? result : (result?.data ?? result?.tools ?? [])
            const ids = (Array.isArray(list) ? list : [])
              .map((tool: any) => (typeof tool === "string" ? tool : tool?.name))
              .filter((name: any) => typeof name === "string" && name.length > 0)
            return { data: ids }
          } catch {
            return { data: [] }
          }
        },
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
      hooks = await (AutoResumePlugin as any)(legacyCtx, {
        continuePrompt: DEFAULT_CONTINUE_PROMPT,
        ...(context.options ?? {}),
      })
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
          for (const legacyEvent of translateEvent(state, ev)) {
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
