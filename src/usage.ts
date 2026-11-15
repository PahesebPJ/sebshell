import type { ShellHost } from './config.ts'

export interface ContextSnapshot {
  host: ShellHost
  usedTokens: number
  windowTokens: number
  sessionId: string | null
  model: string | null
}

/** Fallbacks when the host does not report its window (agy never does as of 2026-11). */
export const DEFAULT_CONTEXT_WINDOW: Record<ShellHost, number> = {
  claude: 200_000,
  antigravity: 1_000_000,
}

type Json = Record<string, unknown>

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const obj = (v: unknown): Json | null => (v && typeof v === 'object' ? (v as Json) : null)

/**
 * Parses the final result of `claude -p --output-format json` (or the `result` event of stream-json).
 * Context in use = prompt tokens of the last API iteration (fresh + cache read + cache write).
 */
export function parseClaudeResult(raw: unknown, fallbackWindow?: number): ContextSnapshot | null {
  const r = obj(raw)
  if (!r || r.type !== 'result') return null
  const usage = obj(r.usage)
  if (!usage) return null
  const iterations = Array.isArray(usage.iterations) ? usage.iterations : []
  const last = obj(iterations[iterations.length - 1]) ?? usage
  const usedTokens =
    num(last.input_tokens) + num(last.cache_read_input_tokens) + num(last.cache_creation_input_tokens)

  let windowTokens = 0
  let model: string | null = null
  const modelUsage = obj(r.modelUsage)
  if (modelUsage) {
    for (const [name, info] of Object.entries(modelUsage)) {
      const w = num(obj(info)?.contextWindow)
      if (w > windowTokens) {
        windowTokens = w
        model = name
      }
    }
  }
  return {
    host: 'claude',
    usedTokens,
    windowTokens: windowTokens || fallbackWindow || DEFAULT_CONTEXT_WINDOW.claude,
    sessionId: typeof r.session_id === 'string' ? r.session_id : null,
    model,
  }
}

/** Parses `agy -p --output-format json` output or the `{event:"result"}` line of stream-json. */
export function parseAgyResult(raw: unknown, fallbackWindow?: number): ContextSnapshot | null {
  const top = obj(raw)
  if (!top) return null
  const r = top.event === 'result' ? obj(top.result) : top
  if (!r || typeof r.conversation_id !== 'string') return null
  const usage = obj(r.usage)
  if (!usage) return null
  return {
    host: 'antigravity',
    usedTokens: num(usage.input_tokens) + num(usage.cache_read_tokens),
    windowTokens: fallbackWindow || DEFAULT_CONTEXT_WINDOW.antigravity,
    sessionId: r.conversation_id,
    model: null,
  }
}

/** Extracts the last parseable JSON object from (possibly NDJSON) host output. */
export function lastJsonObject(output: string): unknown {
  const lines = output.trim().split('\n').reverse()
  for (const line of lines) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      return JSON.parse(t)
    } catch {
      // keep scanning earlier lines
    }
  }
  return null
}

export function contextRatio(snap: ContextSnapshot): number {
  if (snap.windowTokens <= 0) return 0
  return Math.min(1, snap.usedTokens / snap.windowTokens)
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}
