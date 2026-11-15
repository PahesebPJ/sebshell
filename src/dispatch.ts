import type { ProcessOutcome } from 'hubseb'
import type { ShellHost } from './config.ts'
import { type ContextSnapshot, lastJsonObject, parseAgyResult, parseClaudeResult } from './usage.ts'

export interface TurnRequest {
  host: ShellHost
  prompt: string
  agent?: string | null
  sessionId?: string | null
  cwd?: string
  /** Extra env for the host process (e.g. CLAUDE_CONFIG_DIR of an account profile). */
  env?: NodeJS.ProcessEnv
  contextWindow?: number
}

export interface Invocation {
  bin: string
  args: string[]
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
  const args = ['-p', req.prompt, '--output-format', 'json']
  if (req.agent) args.push('--agent', req.agent)
  if (req.sessionId) args.push(req.host === 'claude' ? '--resume' : '--conversation', req.sessionId)
  return { bin: HOST_BIN[req.host], args }
}

export function parseTurnOutput(req: TurnRequest, outcome: ProcessOutcome): TurnResult {
  const raw = lastJsonObject(outcome.stdout)
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null

  if (req.host === 'claude') {
    const context = parseClaudeResult(raw, req.contextWindow)
    const text = typeof r?.result === 'string' ? r.result : ''
    const failed = outcome.exitCode !== 0 || r?.is_error === true
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
  exec(bin: string, args: readonly string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<ProcessOutcome>
}

export async function runTurn(deps: DispatchDeps, req: TurnRequest): Promise<TurnResult> {
  const inv = buildInvocation(req)
  const exe = deps.locate(inv.bin)
  if (!exe) return { ok: false, text: '', context: null, error: `"${inv.bin}" no está instalado` }
  try {
    const outcome = await deps.exec(exe, inv.args, {
      cwd: req.cwd,
      env: req.env ? { ...process.env, ...req.env } : undefined,
    })
    return parseTurnOutput(req, outcome)
  } catch (err) {
    return { ok: false, text: '', context: null, error: err instanceof Error ? err.message : String(err) }
  }
}
