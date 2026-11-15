import { ansi } from './ansi.ts'
import { lerpGradient, type Theme } from './theme.ts'

const GLYPHS: Record<string, readonly string[]> = {
  S: ['██████╗', '██╔═══╝', '██████╗', '╚═══██║', '██████║', '╚═════╝'],
  E: ['██████╗', '██╔═══╝', '█████╗ ', '██╔══╝ ', '██████╗', '╚═════╝'],
  B: ['█████╗ ', '██╔═██╗', '█████╔╝', '██╔═██╗', '█████╔╝', '╚════╝ '],
  H: ['██╗ ██╗', '██║ ██║', '██████║', '██╔═██║', '██║ ██║', '╚═╝ ╚═╝'],
  L: ['██╗    ', '██║    ', '██║    ', '██║    ', '██████╗', '╚═════╝'],
}

const COMPACT = '◆ S E B S H E L L ◆'

export function bannerLines(word = 'SEBSHELL'): string[] {
  const rows = GLYPHS.S?.length ?? 0
  const lines: string[] = []
  for (let r = 0; r < rows; r++) {
    lines.push(
      [...word]
        .map((ch) => GLYPHS[ch]?.[r] ?? '')
        .join(' ')
        .trimEnd(),
    )
  }
  return lines
}

export interface BannerOptions {
  theme: Theme
  color: boolean
  columns: number
  subtitle?: string
}

/** Renders the big SEBSHELL banner with a horizontal gradient, or a compact one on narrow screens. */
export function renderBanner(opts: BannerOptions): string {
  const lines = bannerLines()
  const width = Math.max(...lines.map((l) => [...l].length))
  const out: string[] = []

  if (opts.columns < width + 2) {
    out.push(paint(COMPACT, opts))
  } else {
    for (const line of lines) out.push(paint(line, opts))
  }
  if (opts.subtitle) {
    out.push(opts.color ? `${ansi.dim}${opts.subtitle}${ansi.reset}` : opts.subtitle)
  }
  return `${out.join('\n')}\n`
}

function paint(line: string, opts: BannerOptions): string {
  if (!opts.color) return line
  const chars = [...line]
  const span = Math.max(1, chars.length - 1)
  let out = ansi.bold
  chars.forEach((ch, i) => {
    if (ch === ' ') {
      out += ch
      return
    }
    const [r, g, b] = lerpGradient(opts.theme.gradient, i / span)
    out += `${ansi.fg(r, g, b)}${ch}`
  })
  return `${out}${ansi.reset}`
}
