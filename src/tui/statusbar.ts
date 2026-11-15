import { contextRatio, type ContextSnapshot, formatTokens } from '../usage.ts'
import { ansi, truncateVisible, visibleWidth } from './ansi.ts'
import { createPainter, type Rgb, type Theme } from './theme.ts'

export interface StatusModel {
  orchestrator: string
  profile: string | null
  agent: string | null
  context: ContextSnapshot | null
  activeSubagents: readonly string[]
  services: readonly { id: string; healthy: boolean }[]
  busy: boolean
}

const BAR_CELLS = 10

export function contextMeter(ratio: number, cells = BAR_CELLS): string {
  const filled = Math.round(Math.min(1, Math.max(0, ratio)) * cells)
  return `${'█'.repeat(filled)}${'░'.repeat(cells - filled)}`
}

function meterColor(theme: Theme, ratio: number): Rgb {
  if (ratio >= 0.85) return theme.danger
  if (ratio >= 0.6) return theme.warn
  return theme.ok
}

/** Renders the single-line status bar content (no positioning), clipped to `columns`. */
export function renderStatusLine(model: StatusModel, theme: Theme, color: boolean, columns: number): string {
  const p = createPainter(color)
  const sep = p.fg(theme.muted, ' │ ')
  const who = `${model.orchestrator}${model.profile ? `@${model.profile}` : ''}${model.agent ? `:${model.agent}` : ''}`
  const parts: string[] = [`${p.fg(theme.accent, model.busy ? '◌' : '◆')} orq ${p.bold(who)}`]

  if (model.context) {
    const ratio = contextRatio(model.context)
    const pct = Math.round(ratio * 100)
    parts.push(
      `ctx ${p.fg(meterColor(theme, ratio), contextMeter(ratio))} ${pct}% ` +
        p.fg(theme.muted, `(${formatTokens(model.context.usedTokens)}/${formatTokens(model.context.windowTokens)})`),
    )
  } else {
    parts.push(`ctx ${p.fg(theme.muted, `${'░'.repeat(BAR_CELLS)} —`)}`)
  }

  const subs = model.activeSubagents
  parts.push(
    subs.length === 0 ? p.fg(theme.muted, 'sub 0') : `sub ${subs.length} ${p.fg(theme.muted, `(${subs.join(', ')})`)}`,
  )

  for (const s of model.services) {
    parts.push(`${s.id} ${p.fg(s.healthy ? theme.ok : theme.danger, '●')}`)
  }

  const line = ` ${parts.join(sep)} `
  const clipped = truncateVisible(line, columns)
  const pad = Math.max(0, columns - visibleWidth(clipped))
  if (!color) return `${clipped}${' '.repeat(pad)}`
  return `${ansi.bg(...theme.barBg)}${clipped}${ansi.bg(...theme.barBg)}${' '.repeat(pad)}${ansi.reset}`
}

export interface Terminal {
  write(chunk: string): boolean
  rows?: number
  columns?: number
  isTTY?: boolean
  on(event: 'resize', listener: () => void): unknown
  off(event: 'resize', listener: () => void): unknown
}

/**
 * Pins the status line to the last terminal row by shrinking the scroll region
 * to rows 1..N-1, so regular output scrolls above it untouched.
 */
export class StatusBar {
  private model: StatusModel
  private readonly onResize = () => this.layout()
  private attached = false
  private readonly term: Terminal
  private readonly theme: Theme
  private readonly color: boolean

  constructor(term: Terminal, theme: Theme, color: boolean, initial: StatusModel) {
    this.term = term
    this.theme = theme
    this.color = color
    this.model = initial
  }

  get enabled(): boolean {
    return Boolean(this.term.isTTY) && (this.term.rows ?? 0) >= 4
  }

  attach(): void {
    if (this.attached || !this.enabled) return
    this.attached = true
    this.term.on('resize', this.onResize)
    this.layout()
  }

  detach(): void {
    if (!this.attached) return
    this.attached = false
    this.term.off('resize', this.onResize)
    const rows = this.term.rows ?? 24
    this.term.write(
      `${ansi.saveCursor}${ansi.resetScrollRegion}${ansi.moveTo(rows)}${ansi.clearLine}${ansi.restoreCursor}`,
    )
  }

  update(patch: Partial<StatusModel>): void {
    this.model = { ...this.model, ...patch }
    this.draw()
  }

  get state(): StatusModel {
    return this.model
  }

  private layout(): void {
    if (!this.attached) return
    const rows = this.term.rows ?? 24
    // Scrolling the region first keeps the cursor inside it after a resize.
    this.term.write(`${ansi.saveCursor}${ansi.scrollRegion(1, rows - 1)}${ansi.restoreCursor}`)
    this.draw()
  }

  private draw(): void {
    if (!this.attached) return
    const rows = this.term.rows ?? 24
    const cols = this.term.columns ?? 80
    const line = renderStatusLine(this.model, this.theme, this.color, cols)
    this.term.write(`${ansi.saveCursor}${ansi.moveTo(rows)}${ansi.clearLine}${line}${ansi.restoreCursor}`)
  }
}
