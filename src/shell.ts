import { createInterface } from 'node:readline'
import { SHELL_HOSTS, type ShellConfig, type ShellHost } from './config.ts'
import { type DispatchDeps, isValidAgentName, runTurn } from './dispatch.ts'
import { renderBanner } from './tui/banner.ts'
import { StatusBar, type StatusModel } from './tui/statusbar.ts'
import { createPainter, getTheme } from './tui/theme.ts'
import type { ContextSnapshot } from './usage.ts'

export interface ShellIO {
  input: NodeJS.ReadStream
  output: NodeJS.WriteStream
  color: boolean
}

export interface ShellServices {
  dispatch: DispatchDeps
  services(): Promise<{ id: string; healthy: boolean }[]>
  reconfigure(): Promise<ShellConfig | null>
  profiles: {
    active(host: ShellHost): Promise<string>
    names(host: ShellHost): Promise<string[]>
    env(host: ShellHost, name: string): Promise<NodeJS.ProcessEnv>
  }
}

export type ShellCommand =
  | { kind: 'prompt'; text: string }
  | { kind: 'host'; host: ShellHost | null; raw: string }
  | { kind: 'agent'; agent: string | null }
  | { kind: 'profile'; name: string | null }
  | { kind: 'new' }
  | { kind: 'config' }
  | { kind: 'help' }
  | { kind: 'exit' }
  | { kind: 'empty' }
  | { kind: 'unknown'; raw: string }

const HOST_ALIASES: Record<string, ShellHost> = {
  claude: 'claude',
  cc: 'claude',
  agy: 'antigravity',
  antigravity: 'antigravity',
  gemini: 'antigravity',
}

export function parseShellLine(line: string): ShellCommand {
  const t = line.trim()
  if (!t) return { kind: 'empty' }
  if (!t.startsWith(':')) return { kind: 'prompt', text: t }
  const [cmd = '', ...rest] = t.slice(1).split(/\s+/)
  const arg = rest.join(' ').trim()
  switch (cmd.toLowerCase()) {
    case 'host':
    case 'h':
      return { kind: 'host', host: HOST_ALIASES[arg.toLowerCase()] ?? null, raw: arg }
    case 'agent':
    case 'a':
      return { kind: 'agent', agent: arg && arg !== 'none' && arg !== '-' ? arg : null }
    case 'profile':
    case 'p':
      return { kind: 'profile', name: arg || null }
    case 'new':
    case 'reset':
      return { kind: 'new' }
    case 'config':
      return { kind: 'config' }
    case 'help':
    case '?':
      return { kind: 'help' }
    case 'exit':
    case 'quit':
    case 'q':
      return { kind: 'exit' }
    default:
      return { kind: 'unknown', raw: t }
  }
}

const HELP = [
  'Escribe un prompt y se envía al host activo. Comandos:',
  '  :host claude|agy     cambia el orquestador activo',
  '  :agent <rol>|none    usa un subagente de crewseb (developer, researcher, …)',
  '  :profile [nombre]    lista o cambia la cuenta del host activo (sebshell profile add …)',
  '  :new                 inicia una conversación nueva en el host activo',
  '  :config              reabre el asistente de configuración',
  '  :help  ·  :exit',
].join('\n')

export async function runShell(io: ShellIO, initial: ShellConfig, deps: ShellServices, version: string): Promise<void> {
  let config = initial
  let theme = getTheme(config.theme)
  let p = createPainter(io.color)
  // Keyed by host/profile: a conversation belongs to the account that started it.
  const sessions: Record<string, string> = {}
  const contexts: Record<string, ContextSnapshot> = {}
  let host: ShellHost = config.orchestrator
  let agent: string | null = null
  const profiles: Partial<Record<ShellHost, string>> = {}
  for (const h of config.hosts) {
    try {
      profiles[h] = await deps.profiles.active(h)
    } catch {
      profiles[h] = 'default'
    }
  }
  const sessionKey = () => `${host}/${profiles[host] ?? 'default'}`

  const profileLabel = () => {
    const name = profiles[host]
    return name && name !== 'default' ? name : null
  }

  const model = (): StatusModel => ({
    orchestrator: host,
    profile: profileLabel(),
    agent,
    context: contexts[sessionKey()] ?? null,
    activeSubagents: [],
    services: [],
    busy: false,
  })

  const out = io.output
  const columns = () => out.columns ?? 80
  const printBanner = () =>
    out.write(
      renderBanner({
        theme,
        color: io.color,
        columns: columns(),
        subtitle: `v${version} · hosts: ${config.hosts.join(', ')} · :help para ayuda`,
      }),
    )

  const safeServices = async () => {
    try {
      return await deps.services()
    } catch {
      return []
    }
  }

  printBanner()
  let bar = new StatusBar(out, theme, io.color, model())
  let inflight: AbortController | null = null

  const promptText = () =>
    `${p.fg(theme.accent, '❯')} ${p.fg(theme.muted, host === 'antigravity' ? 'agy' : host)}${agent ? p.fg(theme.muted, `:${agent}`) : ''} `

  // Readline is recreated after :config because the wizard needs exclusive raw keypress access.
  let running = true
  try {
    bar.attach()
    bar.update({ services: await safeServices() })
    while (running) {
      const rl = createInterface({ input: io.input, output: out, terminal: Boolean(io.input.isTTY) })
      let closed = false
      rl.on('close', () => {
        closed = true
        inflight?.abort()
      })
      // Ctrl+C cancels the running turn; on an idle prompt it exits the shell.
      rl.on('SIGINT', () => {
        if (inflight) {
          inflight.abort()
          return
        }
        running = false
        rl.close()
      })
      let reconfigure = false
      rl.setPrompt(promptText())
      rl.prompt()
      for await (const line of rl) {
        const cmd = parseShellLine(line)
        if (cmd.kind === 'exit') {
          running = false
          break
        }
        if (cmd.kind === 'config') {
          reconfigure = true
          break
        }
        await handle(cmd)
        if (closed) break
        rl.setPrompt(promptText())
        rl.prompt()
      }
      rl.close()
      if (!reconfigure) running = false
      else {
        bar.detach()
        const next = await deps.reconfigure()
        if (next) {
          config = next
          theme = getTheme(config.theme)
          p = createPainter(io.color)
          if (!config.hosts.includes(host)) host = config.orchestrator
        }
        out.write('\x1b[2J\x1b[H')
        printBanner()
        bar = new StatusBar(out, theme, io.color, { ...model(), services: await safeServices() })
        bar.attach()
      }
    }
  } finally {
    bar.detach()
  }

  async function handle(cmd: ShellCommand): Promise<void> {
    switch (cmd.kind) {
      case 'empty':
      case 'exit':
      case 'config':
        return
      case 'help':
        out.write(`${HELP}\n`)
        return
      case 'unknown':
        out.write(p.fg(theme.warn, `Comando desconocido: ${cmd.raw} (usa :help)\n`))
        return
      case 'host':
        if (!cmd.host) {
          out.write(p.fg(theme.warn, `Host inválido "${cmd.raw}". Opciones: ${SHELL_HOSTS.join(', ')} (alias agy)\n`))
          return
        }
        if (!config.hosts.includes(cmd.host)) {
          out.write(p.fg(theme.warn, `${cmd.host} no está habilitado; actívalo con :config\n`))
          return
        }
        host = cmd.host
        bar.update({ orchestrator: host, context: contexts[sessionKey()] ?? null })
        return
      case 'agent':
        if (cmd.agent && !isValidAgentName(cmd.agent)) {
          out.write(p.fg(theme.warn, `Nombre de agente inválido "${cmd.agent}"\n`))
          return
        }
        agent = cmd.agent
        bar.update({ agent })
        return
      case 'profile': {
        const names = await deps.profiles.names(host)
        if (!cmd.name) {
          out.write(`Perfiles de ${host}: ${names.map((n) => (n === (profiles[host] ?? 'default') ? `[${n}]` : n)).join(' ')}\n`)
          return
        }
        if (!names.includes(cmd.name)) {
          out.write(p.fg(theme.warn, `No existe el perfil ${host}/${cmd.name}. Créalo con: sebshell profile add ${host} ${cmd.name}\n`))
          return
        }
        profiles[host] = cmd.name
        bar.update({ profile: profileLabel(), context: contexts[sessionKey()] ?? null })
        out.write(p.fg(theme.muted, `${host} ahora usa el perfil ${cmd.name} (solo en esta sesión; para fijarlo: sebshell profile use).\n`))
        return
      }
      case 'new':
        delete sessions[sessionKey()]
        delete contexts[sessionKey()]
        bar.update({ context: null })
        out.write(p.fg(theme.muted, `Nueva conversación en ${host}.\n`))
        return
      case 'prompt': {
        const label = `${host === 'antigravity' ? 'agy' : host}:${agent ?? 'main'}`
        bar.update({ busy: true, activeSubagents: [label] })
        inflight = new AbortController()
        const res = await runTurn(
          deps.dispatch,
          {
            host,
            prompt: cmd.text,
            agent,
            sessionId: sessions[sessionKey()] ?? null,
            env: await deps.profiles.env(host, profiles[host] ?? 'default').catch(() => ({})),
            contextWindow: config.contextWindow[host],
          },
          inflight.signal,
        ).finally(() => {
          inflight = null
        })
        if (res.context) {
          contexts[sessionKey()] = res.context
          if (res.context.sessionId) sessions[sessionKey()] = res.context.sessionId
        }
        out.write(res.ok ? `${res.text.trimEnd()}\n` : p.fg(theme.danger, `✖ ${res.error}\n`))
        bar.update({ busy: false, activeSubagents: [], context: contexts[sessionKey()] ?? null })
        return
      }
    }
  }
}
