export const ESC = '\x1b['

export const ansi = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  clearScreen: `${ESC}2J${ESC}H`,
  clearLine: `${ESC}2K`,
  hideCursor: `${ESC}?25l`,
  showCursor: `${ESC}?25h`,
  saveCursor: '\x1b7',
  restoreCursor: '\x1b8',
  moveTo: (row: number, col = 1) => `${ESC}${row};${col}H`,
  scrollRegion: (top: number, bottom: number) => `${ESC}${top};${bottom}r`,
  resetScrollRegion: `${ESC}r`,
  fg: (r: number, g: number, b: number) => `${ESC}38;2;${r};${g};${b}m`,
  bg: (r: number, g: number, b: number) => `${ESC}48;2;${r};${g};${b}m`,
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]|\x1b[78]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

export function visibleWidth(text: string): number {
  return [...stripAnsi(text)].length
}

/** Truncates to `width` visible columns while preserving escape sequences. */
export function truncateVisible(text: string, width: number): string {
  if (width <= 0) return ''
  if (visibleWidth(text) <= width) return text
  let out = ''
  let seen = 0
  let i = 0
  const target = width - 1
  while (i < text.length && seen < target) {
    ANSI_PATTERN.lastIndex = i
    const m = ANSI_PATTERN.exec(text)
    if (m && m.index === i) {
      out += m[0]
      i += m[0].length
      continue
    }
    const cp = text.codePointAt(i) ?? 0
    const ch = String.fromCodePoint(cp)
    out += ch
    i += ch.length
    seen++
  }
  return text.includes('\x1b') ? `${out}…${ansi.reset}` : `${out}…`
}

export function supportsTruecolor(env: NodeJS.ProcessEnv): boolean {
  if (env.NO_COLOR) return false
  const ct = (env.COLORTERM ?? '').toLowerCase()
  return ct === 'truecolor' || ct === '24bit' || (env.TERM ?? '').includes('direct')
}

/** Escape sequence that undoes everything sebshell may change on the terminal. */
export const RESTORE_TERMINAL = `${ansi.resetScrollRegion}${ansi.showCursor}${ansi.reset}`

let restoreInstalled = false

/** Restores cursor, scroll region and cooked mode on exit, SIGTERM and SIGHUP. Idempotent. */
export function installTerminalRestore(input: NodeJS.ReadStream, output: NodeJS.WriteStream): void {
  if (restoreInstalled) return
  restoreInstalled = true
  const restore = () => {
    try {
      if (input.isTTY && input.isRaw) input.setRawMode(false)
      if (output.isTTY) output.write(RESTORE_TERMINAL)
    } catch {
      // terminal already gone
    }
  }
  process.once('exit', restore)
  for (const [sig, code] of [['SIGTERM', 143], ['SIGHUP', 129]] as const) {
    process.once(sig, () => {
      restore()
      process.exit(code)
    })
  }
}
