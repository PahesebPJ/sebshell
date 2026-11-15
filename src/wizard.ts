import {
  COMPONENT_IDS,
  type ComponentId,
  defaultConfig,
  MODEL_PRESETS,
  type ModelPreset,
  SHELL_HOSTS,
  type ShellConfig,
  type ShellHost,
  THEMES,
  type ThemeName,
} from './config.ts'
import { COMPONENTS } from './manifest.ts'
import type { MenuMode, MenuOption, MenuResult } from './tui/menu.ts'

export interface WizardQuestion {
  id: string
  title: string
  mode: MenuMode
  options: MenuOption[]
  initial: string[]
}

export type Ask = (q: WizardQuestion, stepLabel: string) => Promise<MenuResult<string>>

export type WizardOutcome =
  | { kind: 'apply'; config: ShellConfig; install: boolean }
  | { kind: 'aborted' }

const HOST_LABEL: Record<ShellHost, string> = {
  claude: 'Claude Code',
  antigravity: 'Antigravity CLI (agy)',
}

const PRESET_HINT: Record<ModelPreset, string> = {
  default: 'tiers estándar por rol',
  lite: 'modelos rápidos y baratos',
  hard: 'máximo razonamiento',
  hybrid: 'mezcla Claude + Gemini por tier',
  'cloud-tiered': 'nube escalonada por complejidad',
}

const THEME_HINT: Record<ThemeName, string> = {
  aurora: 'turquesa → violeta',
  ember: 'ámbar → carmesí',
  mono: 'escala de grises',
}

/** Runs the first-run wizard as a step machine; Esc on a step goes back to the previous one. */
export async function runWizard(
  ask: Ask,
  detectedHosts: readonly ShellHost[],
  current: ShellConfig = defaultConfig(),
): Promise<WizardOutcome> {
  const draft: ShellConfig = { ...current, contextWindow: { ...current.contextWindow } }

  const steps: Array<() => WizardQuestion> = [
    () => ({
      id: 'hosts',
      title: '¿Qué agentes vas a usar?',
      mode: 'multi',
      options: SHELL_HOSTS.map((h) => ({
        value: h,
        label: HOST_LABEL[h],
        hint: detectedHosts.includes(h) ? 'detectado' : 'no detectado',
      })),
      initial: draft.hosts,
    }),
    () => ({
      id: 'components',
      title: '¿Qué herramientas *seb instalo?',
      mode: 'multi',
      options: COMPONENTS.map((c) => ({ value: c.id, label: c.label, hint: c.summary })),
      initial: draft.components,
    }),
    () => ({
      id: 'orchestrator',
      title: '¿Quién orquesta por defecto?',
      mode: 'single',
      options: draft.hosts.map((h) => ({ value: h, label: HOST_LABEL[h] })),
      initial: [draft.orchestrator],
    }),
    () => ({
      id: 'modelPreset',
      title: 'Perfil de modelos de la tripulación (crewseb)',
      mode: 'single',
      options: MODEL_PRESETS.map((m) => ({ value: m, label: m, hint: PRESET_HINT[m] })),
      initial: [draft.modelPreset],
    }),
    () => ({
      id: 'theme',
      title: 'Tema de color',
      mode: 'single',
      options: THEMES.map((t) => ({ value: t, label: t, hint: THEME_HINT[t] })),
      initial: [draft.theme],
    }),
    () => ({
      id: 'confirm',
      title: `Resumen: ${draft.hosts.join(' + ')} · orq ${draft.orchestrator} · ${draft.components.length} herramientas · ${draft.modelPreset} · ${draft.theme}`,
      mode: 'single',
      options: [
        { value: 'install', label: 'Guardar e instalar ahora' },
        { value: 'save', label: 'Solo guardar configuración' },
      ],
      initial: ['install'],
    }),
  ]

  let i = 0
  while (i < steps.length) {
    const q = (steps[i] as () => WizardQuestion)()
    const res = await ask(q, `paso ${i + 1}/${steps.length}`)
    if (res.kind === 'aborted') return { kind: 'aborted' }
    if (res.kind === 'back') {
      if (i === 0) return { kind: 'aborted' }
      i--
      continue
    }
    const values = res.values
    switch (q.id) {
      case 'hosts':
        draft.hosts = values.filter((v): v is ShellHost => SHELL_HOSTS.includes(v as ShellHost))
        if (!draft.hosts.includes(draft.orchestrator)) draft.orchestrator = draft.hosts[0] ?? 'claude'
        break
      case 'components':
        draft.components = values.filter((v): v is ComponentId => COMPONENT_IDS.includes(v as ComponentId))
        break
      case 'orchestrator':
        draft.orchestrator = values[0] as ShellHost
        break
      case 'modelPreset':
        draft.modelPreset = values[0] as ModelPreset
        break
      case 'theme':
        draft.theme = values[0] as ThemeName
        break
      case 'confirm':
        draft.configuredAt = new Date().toISOString()
        return { kind: 'apply', config: draft, install: values[0] === 'install' }
    }
    i++
  }
  return { kind: 'aborted' }
}
