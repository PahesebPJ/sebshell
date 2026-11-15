import type { ProcessOutcome } from 'hubseb'
import type { ShellHost } from './config.ts'
import type { ExecOptions } from './process.ts'
import { mergeEnv } from './profiles.ts'
import { type ContextSnapshot, lastJsonObject, parseAgyResult, parseClaudeResult } from './usage.ts'

export interface TurnRequest {
  host: ShellHost
  prompt: string
  agent?: string | null
  /** Concrete model for this turn (e.g. gemini-4-hydrogen); omitted = the host/agent default. */
  model?: string | null
  effort?: EffortLevel | null
  /** 'accept-edits' lets a headless turn edit files without an interactive approval prompt. */
  permission?: PermissionMode
  /** Tools the child must not use (Claude only), e.g. the delegate tool at the last depth level. */
  disallowedTools?: readonly string[]
  /** Drop secret-looking variables from the inherited env (delegated turns run model-chosen tasks). */
  scrubSecrets?: boolean
  sessionId?: string | null
  cwd?: string
  /** Extra env for the host process (e.g. CLAUDE_CONFIG_DIR of an account profile). */
  env?: NodeJS.ProcessEnv
  contextWindow?: number
}

export interface Invocation {
  bin: string
  args: string[]
  /** Prompt delivered on stdin so text starting with "-" can never be parsed as a flag. */
  input?: string
}

const AGENT_NAME = /^[A-Za-z0-9][\w.-]{0,63}$/
const MODEL_NAME = /^[A-Za-z0-9][\w.:/-]{0,95}$/

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]
export type PermissionMode = 'default' | 'accept-edits'

export function isEffortLevel(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v)
}

export function isValidAgentName(name: string): boolean {
  return AGENT_NAME.test(name)
}

const SECRET_KEY = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|AUTH)($|_)/i

/** Removes secret-looking variables (GH_TOKEN, AWS_SECRET_ACCESS_KEY, ANTHROPIC_API_KEY, …). */
export function scrubSecretEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) if (!SECRET_KEY.test(k)) out[k] = v
  return out
}

export function isValidModelName(name: string): boolean {
  return MODEL_NAME.test(name)
}

const EFFORT_SUFFIX = new RegExp(`^(.+)-(${EFFORT_LEVELS.join('|')})$`)

/**
 * agy rejects `--model <id-with-effort-suffix> --effort <other>`; when both are given the
 * suffix is dropped so the explicit effort wins.
 */
export function agyModelArgs(model: string | null | undefined, effort: EffortLevel | null | undefined): string[] {
  const args: string[] = []
  if (model) {
    const m = EFFORT_SUFFIX.exec(model)
    args.push('--model', effort && m ? (m[1] as string) : model)
  }
  if (effort) args.push('--effort', effort)
  return args
}

export interface TurnResult {
  ok: boolean
  text: string
  context: ContextSnapshot | null
  error?: string
}

const HOST_BIN: Record<ShellHost, string> = { claude: 'claude', antigravity: 'agy' }

export function hostBinary(host: ShellHost): string {
  return HOST_BIN[host]
}

export function buildInvocation(req: TurnRequest): Invocation {
  if (req.agent && !isValidAgentName(req.agent)) throw new Error(`Nombre de agente inválido "${req.agent}"`)
  if (req.sessionId && !isValidAgentName(req.sessionId)) throw new Error('ID de sesión inválido')
  if (req.model && !isValidModelName(req.model)) throw new Error(`Nombre de modelo inválido "${req.model}"`)
  if (req.effort && !isEffortLevel(req.effort)) throw new Error(`Esfuerzo inválido "${String(req.effort)}"`)
  const flags = ['--output-format', 'json']
  if (req.agent) flags.push('--agent', req.agent)
  if (req.host === 'claude') {
    if (req.model) flags.push('--model', req.model)
    if (req.effort) flags.push('--effort', req.effort)
    if (req.permission === 'accept-edits') flags.push('--permission-mode', 'acceptEdits')
    // `=` form: the flag is variadic and would otherwise swallow the following arguments.
    for (const tool of req.disallowedTools ?? []) {
      if (!/^[\w.()*: -]{1,128}$/.test(tool)) throw new Error(`Herramienta inválida "${tool}"`)
      flags.push(`--disallowedTools=${tool}`)
    }
  } else {
    flags.push(...agyModelArgs(req.model, req.effort))
    if (req.permission === 'accept-edits') flags.push('--mode', 'accept-edits')
  }
  if (req.sessionId) flags.push(req.host === 'claude' ? '--resume' : '--conversation', req.sessionId)
  // claude's -p is boolean and reads the prompt from stdin; agy's -p takes the next argv verbatim as its value.
  if (req.host === 'claude') return { bin: HOST_BIN.claude, args: ['-p', ...flags], input: req.prompt }
  return { bin: HOST_BIN.antigravity, args: ['-p', req.prompt, ...flags] }
}

export function parseTurnOutput(req: TurnRequest, outcome: ProcessOutcome): TurnResult {
  const raw = lastJsonObject(outcome.stdout)
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null

  if (req.host === 'claude') {
    const context = parseClaudeResult(raw, req.contextWindow)
    const text = typeof r?.result === 'string' ? r.result : ''
    const failed = outcome.exitCode !== 0 || r?.is_error === true || r?.type !== 'result'
    return failed
      ? { ok: false, text, context, error: text || outcome.stderr.trim() || `exit ${outcome.exitCode}` }
      : { ok: true, text, context }
  }

  const body = r?.event === 'result' && r.result && typeof r.result === 'object' ? (r.result as Record<string, unknown>) : r
  const context = parseAgyResult(raw, req.contextWindow)
  const text = typeof body?.response === 'string' ? body.response : ''
  const failed = outcome.exitCode !== 0 || (body?.status !== undefined && body.status !== 'SUCCESS')
  return failed
    ? { ok: false, text, context, error: outcome.stderr.trim() || String(body?.status ?? `exit ${outcome.exitCode}`) }
    : { ok: true, text, context }
}

export interface DispatchDeps {
  locate(bin: string): string | null
  exec(bin: string, args: readonly string[], opts: ExecOptions): Promise<ProcessOutcome>
}

export async function runTurn(deps: DispatchDeps, req: TurnRequest, signal?: AbortSignal): Promise<TurnResult> {
  let inv: Invocation
  try {
    inv = buildInvocation(req)
  } catch (err) {
    return { ok: false, text: '', context: null, error: err instanceof Error ? err.message : String(err) }
  }
  const exe = deps.locate(inv.bin)
  if (!exe) return { ok: false, text: '', context: null, error: `"${inv.bin}" no está instalado` }
  try {
    const outcome = await deps.exec(exe, inv.args, {
      cwd: req.cwd,
      env: req.env || req.scrubSecrets ? mergeEnv(req.scrubSecrets ? scrubSecretEnv(process.env) : process.env, req.env ?? {}) : undefined,
      input: inv.input,
      signal,
    })
    if (signal?.aborted) return { ok: false, text: '', context: null, error: 'cancelado' }
    return parseTurnOutput(req, outcome)
  } catch (err) {
    return { ok: false, text: '', context: null, error: err instanceof Error ? err.message : String(err) }
  }
}
