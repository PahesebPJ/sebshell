import { emitKeypressEvents } from 'node:readline'
import { ansi } from './ansi.ts'
import { createPainter, type Theme } from './theme.ts'

export interface MenuOption<T extends string = string> {
  value: T
  label: string
  hint?: string
  disabled?: boolean
}

export type MenuMode = 'single' | 'multi'

export interface MenuState<T extends string = string> {
  mode: MenuMode
  options: readonly MenuOption<T>[]
  cursor: number
  selected: ReadonlySet<T>
  outcome: 'pending' | 'submitted' | 'back' | 'aborted'
  error?: string
}

export interface Key {
  name?: string
  ctrl?: boolean
  sequence?: string
}

export function initMenu<T extends string>(
  mode: MenuMode,
  options: readonly MenuOption<T>[],
  initial: readonly T[] = [],
): MenuState<T> {
  const enabled = options.filter((o) => !o.disabled).map((o) => o.value)
  const selected = new Set(initial.filter((v) => enabled.includes(v)))
  const firstSelected = options.findIndex((o) => selected.has(o.value))
  const firstEnabled = options.findIndex((o) => !o.disabled)
  const cursor = mode === 'single' && firstSelected >= 0 ? firstSelected : Math.max(0, firstEnabled)
  return { mode, options, cursor, selected, outcome: 'pending' }
}

function step<T extends string>(state: MenuState<T>, delta: 1 | -1): number {
  const n = state.options.length
  if (n === 0) return 0
  let idx = state.cursor
  for (let i = 0; i < n; i++) {
    idx = (idx + delta + n) % n
    if (!state.options[idx]?.disabled) return idx
  }
  return state.cursor
}

/** Pure key reducer: ↑/↓ (or k/j) move, space toggles (multi), Enter submits, Esc goes back, Ctrl+C aborts. */
export function reduceMenu<T extends string>(state: MenuState<T>, key: Key): MenuState<T> {
  if (state.outcome !== 'pending') return state
  if (key.ctrl && key.name === 'c') return { ...state, outcome: 'aborted' }

  switch (key.name) {
    case 'up':
    case 'k':
      return { ...state, cursor: step(state, -1), error: undefined }
    case 'down':
    case 'j':
    case 'tab':
      return { ...state, cursor: step(state, 1), error: undefined }
    case 'escape':
      return { ...state, outcome: 'back' }
    case 'space': {
      if (state.mode !== 'multi') return state
      const opt = state.options[state.cursor]
      if (!opt || opt.disabled) return state
      const next = new Set(state.selected)
      if (next.has(opt.value)) next.delete(opt.value)
      else next.add(opt.value)
      return { ...state, selected: next, error: undefined }
    }
    case 'a': {
      if (state.mode !== 'multi') return state
      const enabled = state.options.filter((o) => !o.disabled).map((o) => o.value)
      const all = enabled.every((v) => state.selected.has(v))
      return { ...state, selected: new Set(all ? [] : enabled), error: undefined }
    }
    case 'return':
    case 'enter': {
      if (state.mode === 'single') {
        const opt = state.options[state.cursor]
        if (!opt || opt.disabled) return state
        return { ...state, selected: new Set([opt.value]), outcome: 'submitted' }
      }
      if (state.selected.size === 0) {
        return { ...state, error: 'Selecciona al menos una opción (espacio).' }
      }
      return { ...state, outcome: 'submitted' }
    }
    default:
      return state
  }
}

export function selectedValues<T extends string>(state: MenuState<T>): T[] {
  return state.options.filter((o) => state.selected.has(o.value)).map((o) => o.value)
}

export interface RenderMenuOptions {
  title: string
  stepLabel?: string
  theme: Theme
  color: boolean
}

export function renderMenu<T extends string>(state: MenuState<T>, opts: RenderMenuOptions): string {
  const p = createPainter(opts.color)
  const lines: string[] = []
  const head = opts.stepLabel ? `${p.fg(opts.theme.muted, opts.stepLabel)}  ` : ''
  lines.push(`${head}${p.bold(opts.title)}`)
  lines.push('')
  state.options.forEach((opt, i) => {
    const active = i === state.cursor
    const pointer = active ? p.fg(opts.theme.accent, '❯') : ' '
    let mark = ''
    if (state.mode === 'multi') {
      mark = state.selected.has(opt.value) ? p.fg(opts.theme.ok, '◉ ') : p.fg(opts.theme.muted, '◯ ')
    }
    let label = opt.label
    if (opt.disabled) label = p.dim(`${label} (no disponible)`)
    else if (active) label = p.fg(opts.theme.accent, p.bold(label))
    const hint = opt.hint ? `  ${p.fg(opts.theme.muted, opt.hint)}` : ''
    lines.push(` ${pointer} ${mark}${label}${hint}`)
  })
  lines.push('')
  if (state.error) lines.push(p.fg(opts.theme.danger, `  ${state.error}`))
  const help =
    state.mode === 'multi'
      ? '↑↓ mover · espacio marcar · a todos · enter confirmar · esc atrás'
      : '↑↓ mover · enter elegir · esc atrás'
  lines.push(p.fg(opts.theme.muted, `  ${help}`))
  return `${lines.join('\n')}\n`
}

export interface MenuIO {
  input: NodeJS.ReadStream
  output: NodeJS.WriteStream
}

export type MenuResult<T extends string> =
  | { kind: 'submitted'; values: T[] }
  | { kind: 'back' }
  | { kind: 'aborted' }

/** Runs a menu interactively on a TTY, redrawing in place below `header`. */
export function runMenu<T extends string>(
  io: MenuIO,
  mode: MenuMode,
  options: readonly MenuOption<T>[],
  initial: readonly T[],
  render: RenderMenuOptions & { header?: string },
): Promise<MenuResult<T>> {
  return new Promise((resolve) => {
    let state = initMenu(mode, options, initial)
    const { input, output } = io
    emitKeypressEvents(input)
    const wasRaw = input.isRaw
    if (input.isTTY) input.setRawMode(true)
    input.resume()

    const draw = () => {
      output.write(`${ansi.clearScreen}${ansi.hideCursor}${render.header ?? ''}${renderMenu(state, render)}`)
    }

    const onKey = (_: string, key: Key | undefined) => {
      state = reduceMenu(state, key ?? {})
      if (state.outcome === 'pending') {
        draw()
        return
      }
      input.off('keypress', onKey)
      if (input.isTTY) input.setRawMode(Boolean(wasRaw))
      input.pause()
      output.write(ansi.showCursor)
      if (state.outcome === 'submitted') resolve({ kind: 'submitted', values: selectedValues(state) })
      else resolve({ kind: state.outcome === 'back' ? 'back' : 'aborted' })
    }

    input.on('keypress', onKey)
    draw()
  })
}
