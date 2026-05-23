import { Config } from "@/config/config"
import z from "zod"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
import { generateObject, streamObject, type ModelMessage } from "ai"
import { Truncate } from "@/tool/truncate"
import { Auth } from "../auth"
import { ProviderTransform } from "@/provider/transform"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import PROMPT_TEST from "./prompt/test.txt"
import PROMPT_RUNTIME_QA from "./prompt/runtime-qa.txt"
import PROMPT_USER_LEVEL_TEST from "./prompt/user-level-test.txt"
import PROMPT_DEVELOPER from "./prompt/developer.txt"
import PROMPT_ORCHESTRATION from "./prompt/orchestration.txt"
import PROMPT_MASTER from "./prompt/master.txt"
import PROMPT_RESEARCH from "./prompt/research.txt"
import PROMPT_DESIGN_UX from "./prompt/design-ux.txt"
import PROMPT_OPTIMIZATION from "./prompt/optimization.txt"
import { Permission } from "@/permission"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@opencode-ai/core/global"
import path from "path"
import { Plugin } from "@/plugin"
import { Skill } from "../skill"
import { Effect, Context, Layer, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { zod } from "@/util/effect-zod"
import { withStatics, type DeepMutable } from "@/util/schema"

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  native: Schema.optional(Schema.Boolean),
  hidden: Schema.optional(Schema.Boolean),
  topP: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  color: Schema.optional(Schema.String),
  permission: Permission.Ruleset,
  model: Schema.optional(
    Schema.Struct({
      modelID: ModelID,
      providerID: ProviderID,
    }),
  ),
  variant: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Unknown),
  steps: Schema.optional(Schema.Finite),
})
  .annotate({ identifier: "Agent" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>

export interface Interface {
  readonly get: (agent: string) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Info[]>
  readonly defaultAgent: () => Effect.Effect<string>
  readonly generate: (input: {
    description: string
    model?: { providerID: ProviderID; modelID: ModelID }
  }) => Effect.Effect<{
    identifier: string
    whenToUse: string
    systemPrompt: string
  }>
}

type State = Omit<Interface, "generate">

export class Service extends Context.Service<Service, Interface>()("@opencode/Agent") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const auth = yield* Auth.Service
    const plugin = yield* Plugin.Service
    const skill = yield* Skill.Service
    const provider = yield* Provider.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Agent.state")(function* (ctx) {
        const cfg = yield* config.get()
        const skillDirs = yield* skill.dirs()
        const whitelistedDirs = [
          Truncate.GLOB,
          path.join(Global.Path.tmp, "*"),
          ...skillDirs.map((dir) => path.join(dir, "*")),
        ]

        const defaults = Permission.fromConfig({
          "*": "allow",
          doom_loop: "ask",
          external_directory: {
            "*": "ask",
            ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
          },
          question: "deny",
          plan_enter: "deny",
          plan_exit: "deny",
          // mirrors github.com/github/gitignore Node.gitignore pattern for .env files
          read: {
            "*": "allow",
            "*.env": "ask",
            "*.env.*": "ask",
            "*.env.example": "allow",
          },
        })

        const user = Permission.fromConfig(cfg.permission ?? {})

        const agents: Record<string, Info> = {
          master: {
            name: "master",
            description:
              "Primary interface agent. Routes every request through orchestration, developer, test, and runtime QA subagents, then reports back to the user.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_enter: "allow",
                edit: {
                  "*": "deny",
                },
                write: {
                  "*": "deny",
                },
              }),
              user,
            ),
            prompt: PROMPT_MASTER,
            mode: "primary",
            native: true,
          },
          build: {
            name: "build",
            description: "The default agent. Executes tools based on configured permissions.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_enter: "allow",
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          plan: {
            name: "plan",
            description: "Plan mode. Disallows all edit tools.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_exit: "allow",
                external_directory: {
                  [path.join(Global.Path.data, "plans", "*")]: "allow",
                },
                edit: {
                  "*": "deny",
                  [path.join(".opencode", "plans", "*.md")]: "allow",
                  [path.relative(ctx.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow",
                },
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          orchestration: {
            name: "orchestration",
            description: `Expert software architect and orchestration agent. Analyzes requirements, designs software architecture, creates implementation plans, and writes TODO lists. Use this agent first to plan and structure software development before implementation begins.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                task: "deny",
                edit: {
                  "*": "deny",
                  "**/*.md": "allow",
                },
                write: {
                  "*": "deny",
                  "**/*.md": "allow",
                },
                todowrite: "allow",
                read: "allow",
                grep: "allow",
                glob: "allow",
                list: "allow",
                webfetch: "allow",
                websearch: "allow",
              }),
              user,
            ),
            prompt: PROMPT_ORCHESTRATION,
            options: {},
            mode: "subagent",
            native: true,
            steps: 50,
          },
          explore: {
            name: "explore",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                task: "deny",
                grep: "allow",
                glob: "allow",
                list: "allow",
                bash: "allow",
                webfetch: "allow",
                websearch: "allow",
                read: "allow",
                external_directory: {
                  "*": "ask",
                  ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
                },
              }),
              user,
            ),
            description: `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
            prompt: PROMPT_EXPLORE,
            options: {},
            mode: "subagent",
            native: true,
          },
          compaction: {
            name: "compaction",
            mode: "primary",
            native: true,
            hidden: true,
            prompt: PROMPT_COMPACTION,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            options: {},
          },
          title: {
            name: "title",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            temperature: 0.5,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_TITLE,
          },
          summary: {
            name: "summary",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_SUMMARY,
          },
          developer: {
            name: "developer",
            description: `Expert software developer. Implements features and writes code based on the TODO list created by the orchestration agent.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                edit: "allow",
                bash: "allow",
                task: "deny",
              }),
              user,
            ),
            prompt: PROMPT_DEVELOPER,
            options: {},
            steps: 100,
            mode: "subagent",
            native: true,
          },
          test: {
            name: "test",
            description: `Quality assurance and testing specialist. Creates test plans, writes comprehensive tests, and validates code quality. Use this agent after code development is complete to ensure thorough test coverage and code reliability. This agent may ONLY modify test files; it must not modify main source files. If changes to source are required, report them to the master agent instead of applying persistent edits.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                task: "deny",
                // Deny edits to main source by default; explicitly allow edits only under test file paths
                edit: {
                  "*": "deny",
                  "**/*.test.*": "allow",
                  "**/*.spec.*": "allow",
                  "tests/**": "allow",
                  "**/__tests__/**": "allow",
                },
                bash: "allow",
                todowrite: "allow",
              }),
              user,
            ),
            prompt: PROMPT_TEST,
            options: {},
            steps: 50,
            mode: "subagent",
            native: true,
          },
          runtime_qa: {
            name: "runtime_qa",
            description: `Runtime QA agent. Runs the app in an isolated environment (preferably Docker) and validates that the app starts and runs correctly. Use this agent to verify the app can run without runtime or Docker-related issues.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                task: "deny",
                edit: "deny",
                bash: "allow",
                todowrite: "allow",
                read: "allow",
                grep: "allow",
                glob: "allow",
                list: "allow",
              }),
              user,
            ),
            prompt: PROMPT_RUNTIME_QA,
            options: {},
            steps: 30,
            mode: "subagent",
            native: true,
          },
          user_level_test: {
            name: "user_level_test",
            description: `User-level test agent. Tests the application like a real user would, testing EVERY feature, button, and interaction to ensure the app works correctly and provides an EXCEPTIONAL user experience. This agent is EXTREMELY STRICT and will NOT pass the app unless it is PRODUCTION-READY with ZERO issues. Use this agent after runtime QA confirms the app runs.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                task: "deny",
                edit: "deny",
                bash: "allow",
                todowrite: "allow",
                read: "allow",
                grep: "allow",
                glob: "allow",
                list: "allow",
              }),
              user,
            ),
            prompt: PROMPT_USER_LEVEL_TEST,
            options: {},
            steps: 200,
            mode: "subagent",
            native: true,
          },
          research: {
            name: "research",
            description: `Research agent. Conducts deep, thorough research on requirements, best practices, patterns, and industry standards for the application to be built. Use this agent early in the process to ensure comprehensive understanding and planning.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                task: "deny",
                edit: "deny",
                bash: "allow",
                todowrite: "allow",
                read: "allow",
                grep: "allow",
                glob: "allow",
                list: "allow",
                websearch: "allow",
                webfetch: "allow",
              }),
              user,
            ),
            prompt: PROMPT_RESEARCH,
            options: {},
            steps: 50,
            mode: "subagent",
            native: true,
          },
          design_ux: {
            name: "design_ux",
            description: `Design and UX agent. Designs a professional, polished, and exceptional user experience for the application. Use this agent to create comprehensive design systems and UI specifications.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                task: "deny",
                edit: "allow",
                bash: "allow",
                todowrite: "allow",
                read: "allow",
                grep: "allow",
                glob: "allow",
                list: "allow",
                websearch: "allow",
                webfetch: "allow",
              }),
              user,
            ),
            prompt: PROMPT_DESIGN_UX,
            options: {},
            steps: 50,
            mode: "subagent",
            native: true,
          },
          optimization: {
            name: "optimization",
            description: `Optimization agent. Optimizes the application for performance, code quality, and production readiness. Use this agent after implementation to add advanced features, optimize performance, and ensure production readiness.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                task: "deny",
                edit: "allow",
                bash: "allow",
                todowrite: "allow",
                read: "allow",
                grep: "allow",
                glob: "allow",
                list: "allow",
              }),
              user,
            ),
            prompt: PROMPT_OPTIMIZATION,
            options: {},
            steps: 100,
            mode: "subagent",
            native: true,
          },
        }

        for (const [key, value] of Object.entries(cfg.agent ?? {})) {
          if (value.disable) {
            delete agents[key]
            continue
          }
          let item = agents[key]
          if (!item)
            item = agents[key] = {
              name: key,
              mode: "all",
              permission: Permission.merge(defaults, user),
              options: {},
              native: false,
            }
          if (value.model) item.model = Provider.parseModel(value.model)
          item.variant = value.variant ?? item.variant
          item.prompt = value.prompt ?? item.prompt
          item.description = value.description ?? item.description
          item.temperature = value.temperature ?? item.temperature
          item.topP = value.top_p ?? item.topP
          item.mode = value.mode ?? item.mode
          item.color = value.color ?? item.color
          item.hidden = value.hidden ?? item.hidden
          item.name = value.name ?? item.name
          item.steps = value.steps ?? item.steps
          item.options = mergeDeep(item.options, value.options ?? {})
          item.permission = Permission.merge(item.permission, Permission.fromConfig(value.permission ?? {}))
        }

        // Ensure Truncate.GLOB is allowed unless explicitly configured
        for (const name in agents) {
          const agent = agents[name]
          const explicit = agent.permission.some((r) => {
            if (r.permission !== "external_directory") return false
            if (r.action !== "deny") return false
            return r.pattern === Truncate.GLOB
          })
          if (explicit) continue

          agents[name].permission = Permission.merge(
            agents[name].permission,
            Permission.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }),
          )
        }

        const get = Effect.fnUntraced(function* (agent: string) {
          return agents[agent]
        })

        const list = Effect.fnUntraced(function* () {
          const cfg = yield* config.get()
          return pipe(
            agents,
            values(),
            sortBy(
              [(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "master"), "desc"],
              [(x) => x.name, "asc"],
            ),
          )
        })

        const defaultAgent = Effect.fnUntraced(function* () {
          const c = yield* config.get()
          if (c.default_agent) {
            const agent = agents[c.default_agent]
            if (!agent) throw new Error(`default agent "${c.default_agent}" not found`)
            if (agent.mode === "subagent") throw new Error(`default agent "${c.default_agent}" is a subagent`)
            if (agent.hidden === true) throw new Error(`default agent "${c.default_agent}" is hidden`)
            return agent.name
          }
            const visible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true && a.name === "master") ||
              Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
          if (!visible) throw new Error("no primary visible agent found")
          return visible.name
        })

        return {
          get,
          list,
          defaultAgent,
        } satisfies State
      }),
    )

    return Service.of({
      get: Effect.fn("Agent.get")(function* (agent: string) {
        return yield* InstanceState.useEffect(state, (s) => s.get(agent))
      }),
      list: Effect.fn("Agent.list")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.list())
      }),
      defaultAgent: Effect.fn("Agent.defaultAgent")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultAgent())
      }),
      generate: Effect.fn("Agent.generate")(function* (input: {
        description: string
        model?: { providerID: ProviderID; modelID: ModelID }
      }) {
        const cfg = yield* config.get()
        const model = input.model ?? (yield* provider.defaultModel())
        const resolved = yield* provider.getModel(model.providerID, model.modelID)
        const language = yield* provider.getLanguage(resolved)
        const tracer = cfg.experimental?.openTelemetry
          ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
          : undefined

        const system = [PROMPT_GENERATE]
        yield* plugin.trigger("experimental.chat.system.transform", { model: resolved }, { system })
        const existing = yield* InstanceState.useEffect(state, (s) => s.list())

        // TODO: clean this up so provider specific logic doesnt bleed over
        const authInfo = yield* auth.get(model.providerID).pipe(Effect.orDie)
        const isOpenaiOauth = model.providerID === "openai" && authInfo?.type === "oauth"

        const params = {
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            tracer,
            metadata: {
              userId: cfg.username ?? "unknown",
            },
          },
          temperature: 0.3,
          messages: [
            ...(isOpenaiOauth
              ? []
              : system.map(
                  (item): ModelMessage => ({
                    role: "system",
                    content: item,
                  }),
                )),
            {
              role: "user",
              content: `Create an agent configuration based on this request: "${input.description}".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
            },
          ],
          model: language,
          schema: z.object({
            identifier: z.string(),
            whenToUse: z.string(),
            systemPrompt: z.string(),
          }),
        } satisfies Parameters<typeof generateObject>[0]

        if (isOpenaiOauth) {
          return yield* Effect.promise(async () => {
            const result = streamObject({
              ...params,
              providerOptions: ProviderTransform.providerOptions(resolved, {
                instructions: system.join("\n"),
                store: false,
              }),
              onError: () => {},
            })
            for await (const part of result.fullStream) {
              if (part.type === "error") throw part.error
            }
            return result.object
          })
        }

        return yield* Effect.promise(() => generateObject(params).then((r) => r.object))
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Plugin.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Skill.defaultLayer),
)

export * as Agent from "./agent"
