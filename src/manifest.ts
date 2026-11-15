import type { ComponentId, ShellHost } from './config.ts'

export interface CommandSpec {
  bin: string
  args: string[]
}

export interface ComponentSpec {
  id: ComponentId
  label: string
  summary: string
  /** Binary that proves the component is present; install is skipped when found. */
  probeBin: string | null
  install: CommandSpec
  setup: ((hosts: readonly ShellHost[]) => CommandSpec) | null
  uninstall: CommandSpec | null
  requiresBins?: string[]
}

const agentsFlag = (hosts: readonly ShellHost[]) => ['--agents', hosts.join(',')]

/** Installation order matters: memoseb provides `memory.vault`, which crewseb consumes. */
export const COMPONENTS: readonly ComponentSpec[] = [
  {
    id: 'memoseb',
    label: 'memoseb',
    summary: 'Memoria híbrida vectorial + FTS5 con MCP',
    probeBin: 'memoseb',
    install: { bin: 'npm', args: ['install', '-g', 'memoseb'] },
    setup: (hosts) => ({ bin: 'memoseb', args: ['setup', ...agentsFlag(hosts)] }),
    uninstall: { bin: 'memoseb', args: ['uninstall'] },
  },
  {
    id: 'crewseb',
    label: 'crewseb',
    summary: 'Tripulación de 10 subagentes especialistas',
    probeBin: 'crewseb',
    install: { bin: 'npm', args: ['install', '-g', 'crewseb'] },
    setup: (hosts) => ({ bin: 'crewseb', args: ['setup', ...agentsFlag(hosts)] }),
    uninstall: { bin: 'crewseb', args: ['uninstall'] },
  },
  {
    id: 'deckseb',
    label: 'deckseb',
    summary: 'Visor de planes Markdown + Mermaid en vivo',
    probeBin: 'deckseb',
    install: { bin: 'npm', args: ['install', '-g', 'deckseb'] },
    setup: () => ({ bin: 'deckseb', args: ['setup'] }),
    uninstall: null,
  },
  {
    id: 'memosebui',
    label: 'memosebui',
    summary: 'Grafo neuronal de escritorio para memoseb',
    probeBin: 'memosebui',
    install: { bin: 'npm', args: ['install', '-g', 'memosebui'] },
    setup: () => ({ bin: 'memosebui', args: ['setup'] }),
    uninstall: null,
  },
  {
    id: 'herdr-auto-title',
    label: 'herdr-auto-title',
    summary: 'Títulos automáticos de tabs/panes en herdr',
    probeBin: 'herdr-auto-title',
    install: { bin: 'npm', args: ['install', '-g', 'herdr-auto-title'] },
    setup: () => ({ bin: 'herdr-auto-title', args: ['install'] }),
    uninstall: null,
    requiresBins: ['herdr'],
  },
  {
    id: 'herdr-nvim-watcher',
    label: 'herdr-nvim-watcher',
    summary: 'Espejo de ediciones en un split de Neovim',
    probeBin: null,
    install: { bin: 'herdr', args: ['plugin', 'install', 'PahesebPJ/herdr-nvim-watcher'] },
    setup: null,
    uninstall: null,
    requiresBins: ['herdr', 'nvim'],
  },
]

export function getComponent(id: ComponentId): ComponentSpec {
  const spec = COMPONENTS.find((c) => c.id === id)
  if (!spec) throw new Error(`Unknown component "${id}"`)
  return spec
}

/** Returns the selected components in canonical install order. */
export function orderComponents(selected: readonly ComponentId[]): ComponentSpec[] {
  return COMPONENTS.filter((c) => selected.includes(c.id))
}
