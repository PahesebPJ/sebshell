import type { ThemeName } from '../config.ts'
import { ansi } from './ansi.ts'

export type Rgb = readonly [number, number, number]

export interface Theme {
  name: ThemeName
  gradient: readonly Rgb[]
  accent: Rgb
  muted: Rgb
  ok: Rgb
  warn: Rgb
  danger: Rgb
  barBg: Rgb
}

const THEMES: Record<ThemeName, Theme> = {
  aurora: {
    name: 'aurora',
    gradient: [
      [94, 234, 212],
      [56, 189, 248],
      [129, 140, 248],
      [192, 132, 252],
    ],
    accent: [56, 189, 248],
    muted: [148, 163, 184],
    ok: [74, 222, 128],
    warn: [250, 204, 21],
    danger: [248, 113, 113],
    barBg: [30, 41, 59],
  },
  ember: {
    name: 'ember',
    gradient: [
      [253, 224, 71],
      [251, 146, 60],
      [239, 68, 68],
      [190, 24, 93],
    ],
    accent: [251, 146, 60],
    muted: [168, 162, 158],
    ok: [132, 204, 22],
    warn: [250, 204, 21],
    danger: [239, 68, 68],
    barBg: [41, 37, 36],
  },
  mono: {
    name: 'mono',
    gradient: [
      [250, 250, 250],
      [163, 163, 163],
    ],
    accent: [229, 229, 229],
    muted: [140, 140, 140],
    ok: [229, 229, 229],
    warn: [200, 200, 200],
    danger: [255, 255, 255],
    barBg: [38, 38, 38],
  },
}

export function getTheme(name: ThemeName): Theme {
  return THEMES[name]
}

export function lerpGradient(stops: readonly Rgb[], t: number): Rgb {
  if (stops.length === 0) return [255, 255, 255]
  if (stops.length === 1) return stops[0] as Rgb
  const clamped = Math.min(1, Math.max(0, t))
  const scaled = clamped * (stops.length - 1)
  const idx = Math.min(stops.length - 2, Math.floor(scaled))
  const local = scaled - idx
  const a = stops[idx] as Rgb
  const b = stops[idx + 1] as Rgb
  return [
    Math.round(a[0] + (b[0] - a[0]) * local),
    Math.round(a[1] + (b[1] - a[1]) * local),
    Math.round(a[2] + (b[2] - a[2]) * local),
  ]
}

export interface Painter {
  color: boolean
  fg(rgb: Rgb, text: string): string
  bold(text: string): string
  dim(text: string): string
}

export function createPainter(color: boolean): Painter {
  return {
    color,
    fg: (rgb, text) => (color ? `${ansi.fg(...rgb)}${text}${ansi.reset}` : text),
    bold: (text) => (color ? `${ansi.bold}${text}${ansi.reset}` : text),
    dim: (text) => (color ? `${ansi.dim}${text}${ansi.reset}` : text),
  }
}
