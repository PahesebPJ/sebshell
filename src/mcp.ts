import { statSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import type { ShellHost } from './config.ts'
import { type CrewClient, describeEntry, hostFor, invocationFor, isCrewRole } from './crew.ts'
import { type DispatchDeps, isValidAgentName, type PermissionMode, runTurn } from './dispatch.ts'
import { formatTokens } from './usage.ts'

const JSONRPC = '2.0'
const PROTOCOL_VERSION = '2024-11-05'
export const MAX_DELEGATION_DEPTH = 2
export const DEPTH_ENV = 'SEBSHELL_DELEGATION_DEPTH'
export const CALLER_ENV = 'SEBSHELL_CALLER'

export const MCP_TOOLS = [
  {
    name: 'seb_delegate',
    description:
      'Runs a crewseb specialist on the host it is routed to (Claude Code or Antigravity) with its configured model and effort, and returns its handoff. Use it for roles listed in the routing table of your directives.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'crewseb role, e.g. developer, researcher, code-reviewer' },
        prompt: { type: 'string', description: 'Self-contained task for the specialist (it does not see your conversation)' },
        host: { type: 'string', enum: ['claude', 'antigravity', 'agy'], description: 'Override the routed host' },
        cwd: { type: 'string', description: 'Absolute working directory; defaults to the current project' },
      },
      required: ['agent', 'prompt'],
    },
  },
  {
    name: 'seb_routing',
    description: 'Shows, per crewseb role, which host executes it and with which model and effort.',
    inputSchema: { type: 'object', properties: {} },
  },
] as const

export interface McpDeps {
  crew: CrewClient
  dispatch: DispatchDeps
  /** Env for the target host's active account profile; must throw rather than fall back. */
  profileEnv(host: ShellHost): Promise<NodeJS.ProcessEnv>
  permission(): Promise<PermissionMode>
  env: NodeJS.ProcessEnv
  cwd: string
}

type Json = Record<string, unknown>

const textResult = (text: string, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) })

function parseHost(v: unknown): ShellHost | null {
  if (v === 'agy' || v === 'antigravity') return 'antigravity'
  return v === 'claude' ? 'claude' : null
}

export async function delegate(deps: McpDeps, args: Json): Promise<ReturnType<typeof textResult>> {
  const agent = typeof args.agent === 'string' ? args.agent.trim() : ''
  const prompt = typeof args.prompt === 'string' ? args.prompt : ''
  if (!isValidAgentName(agent) || !prompt.trim()) return textResult('seb_delegate requiere "agent" (nombre de rol válido) y "prompt".', true)
  if (args.host !== undefined && !parseHost(args.host)) return textResult(`Host inválido "${String(args.host)}".`, true)

  const depth = Number.parseInt(deps.env[DEPTH_ENV] ?? '0', 10) || 0
  if (depth >= MAX_DELEGATION_DEPTH) {
    return textResult(`Delegación rechazada: profundidad máxima ${MAX_DELEGATION_DEPTH} alcanzada (evita bucles entre hosts). Resuélvelo en este nivel.`, true)
  }

  let cwd = deps.cwd
  if (args.cwd !== undefined) {
    if (typeof args.cwd !== 'string' || !path.isAbsolute(args.cwd)) return textResult('"cwd" debe ser una ruta absoluta.', true)
    try {
      if (!statSync(args.cwd).isDirectory()) return textResult(`"${args.cwd}" no es un directorio.`, true)
    } catch {
      return textResult(`"${args.cwd}" no existe.`, true)
    }
    cwd = args.cwd
  }

  const caller = parseHost(deps.env[CALLER_ENV]) ?? 'claude'
  let info
  try {
    info = isCrewRole(agent) ? await deps.crew.role(agent) : undefined
  } catch {
    info = undefined // crewseb unavailable: still delegate with host defaults
  }
  const host = parseHost(args.host) ?? hostFor(info, caller)
  const { model, effort } = invocationFor(info, host)

  let env: NodeJS.ProcessEnv
  try {
    env = await deps.profileEnv(host)
  } catch (e) {
    return textResult(`Perfil de ${host} no disponible: ${e instanceof Error ? e.message : String(e)}`, true)
  }

  const res = await runTurn(deps.dispatch, {
    host,
    prompt,
    agent,
    model,
    effort,
    permission: await deps.permission(),
    cwd,
    env: { ...env, [DEPTH_ENV]: String(depth + 1), [CALLER_ENV]: host },
  })
  const label = `${host === 'antigravity' ? 'agy' : host}:${agent}${model ? ` · ${model}` : ''}${effort ? `@${effort}` : ''}`
  const ctx = res.context ? ` · ctx ${formatTokens(res.context.usedTokens)}/${formatTokens(res.context.windowTokens)}` : ''
  if (!res.ok) return textResult(`[sebshell ${label}] ✖ ${res.error ?? 'error'}`, true)
  return textResult(`${res.text.trimEnd()}\n\n[sebshell ${label}${ctx}]`)
}

export async function routingSummary(deps: McpDeps): Promise<ReturnType<typeof textResult>> {
  try {
    const roles = await deps.crew.roles(true)
    const lines = roles.map(
      (r) => `- ${r.role}: corre en ${r.runsOn ?? 'el orquestador'} · claude=${describeEntry(r.hosts.claude)} · agy=${describeEntry(r.hosts.antigravity)}`,
    )
    return textResult(lines.join('\n'))
  } catch (e) {
    return textResult(`No se pudo leer la configuración de crewseb: ${e instanceof Error ? e.message : String(e)}`, true)
  }
}

export async function handleMcpRequest(deps: McpDeps, req: Json, version: string): Promise<Json | null> {
  const method = typeof req.method === 'string' ? req.method : ''
  if (!('id' in req) || req.id === undefined || method.startsWith('notifications/')) return null
  const id = req.id
  const ok = (result: unknown) => ({ jsonrpc: JSONRPC, id, result })

  switch (method) {
    case 'initialize':
      return ok({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'sebshell', version } })
    case 'ping':
      return ok({})
    case 'tools/list':
      return ok({ tools: MCP_TOOLS })
    case 'tools/call': {
      const params = (req.params && typeof req.params === 'object' ? req.params : {}) as Json
      const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Json
      if (params.name === 'seb_delegate') return ok(await delegate(deps, args))
      if (params.name === 'seb_routing') return ok(await routingSummary(deps))
      return { jsonrpc: JSONRPC, id, error: { code: -32602, message: `Unknown tool: ${String(params.name)}` } }
    }
    default:
      return { jsonrpc: JSONRPC, id, error: { code: -32601, message: `Method not found: ${method}` } }
  }
}

/** Newline-delimited JSON-RPC over stdio. Requests run concurrently; each reply carries its id. */
export function serveMcp(deps: McpDeps, version: string, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
    const pending = new Set<Promise<void>>()
    const send = (msg: Json) => output.write(`${JSON.stringify(msg)}\n`)
    rl.on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      let req: Json
      try {
        req = JSON.parse(trimmed) as Json
      } catch {
        send({ jsonrpc: JSONRPC, id: null, error: { code: -32700, message: 'Parse error' } })
        return
      }
      const task = handleMcpRequest(deps, req, version)
        .then((res) => {
          if (res) send(res)
        })
        .catch((err: unknown) => {
          send({ jsonrpc: JSONRPC, id: (req.id as never) ?? null, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } })
        })
        .finally(() => pending.delete(task))
      pending.add(task)
    })
    rl.on('close', () => {
      void Promise.allSettled([...pending]).then(() => resolve())
    })
  })
}
