#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DriverHub, serializeWire, SystemRuntime, TopologyStore, wireFailure, wireSuccess } from 'hubseb'
import {
  type ComponentId,
  configFile,
  defaultConfig,
  loadConfig,
  saveConfig,
  SHELL_HOSTS,
  type ShellConfig,
  type ShellHost,
} from '../config.ts'
import { type DispatchDeps, runTurn } from '../dispatch.ts'
import { type ExecOptions, execCancellable } from '../process.ts'
import { type InstallerDeps, runInstall, type StepReport } from '../installer.ts'
import { PROFILE_USAGE, parseHost, resolveProfile, runProfileCli } from '../profile-cli.ts'
import { activeProfileName, listProfiles, loadProfiles, type Profile, profileEnv, syncProfiles } from '../profiles.ts'
import { runShell } from '../shell.ts'
import { installTerminalRestore, supportsTruecolor } from '../tui/ansi.ts'
import { renderBanner } from '../tui/banner.ts'
import { runMenu } from '../tui/menu.ts'
import { createPainter, getTheme } from '../tui/theme.ts'
import { runWizard } from '../wizard.ts'

export const VERSION = '0.1.0'

const NODE_ID = 'sebshell'
const PROVIDES = ['seb.shell', 'seb.installer', 'seb.dispatch']

type HubHostId = 'claude' | 'antigravity'

function detectHosts(runtime: SystemRuntime): ShellHost[] {
  const hub = new DriverHub(runtime)
  const detected = new Set<string>(hub.detectedHostIds())
  return SHELL_HOSTS.filter((h) => detected.has(h satisfies HubHostId))
}

function colorEnabled(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && supportsTruecolor(process.env)
}

function makeDeps(runtime: SystemRuntime): InstallerDeps & DispatchDeps {
  return {
    locate: (bin) => runtime.locateBinary(bin),
    exec: (bin: string, args: readonly string[], opts: ExecOptions = {}) => execCancellable(bin, args, opts),
  }
}

async function registerNode(runtime: SystemRuntime): Promise<string> {
  const store = new TopologyStore(runtime)
  const entry = realpathSync(fileURLToPath(import.meta.url))
  const { file } = await store.attachNode({
    id: NODE_ID,
    version: VERSION,
    summary: 'Unified *seb installer and mixed-host agent shell',
    command: [process.execPath, entry],
    provides: PROVIDES,
    consumes: ['memory.vault', 'crew.specialists'],
    signals: ['seb.installed', 'seb.configured'],
  })
  return file
}

function printStep(report: StepReport, index: number, total: number, color: boolean, config: ShellConfig): void {
  const theme = getTheme(config.theme)
  const p = createPainter(color)
  const icon =
    report.status === 'done'
      ? p.fg(theme.ok, '✔')
      : report.status === 'skipped'
        ? p.fg(theme.muted, '○')
        : p.fg(theme.danger, '✖')
  const counter = p.fg(theme.muted, `[${String(index).padStart(2)}/${total}]`)
  process.stdout.write(`${counter} ${icon} ${report.component.padEnd(19)} ${report.phase.padEnd(7)} ${p.fg(theme.muted, report.detail)}\n`)
}

async function install(runtime: SystemRuntime, config: ShellConfig, dryRun: boolean, quiet = false): Promise<StepReport[]> {
  const color = colorEnabled()
  const reports = await runInstall(makeDeps(runtime), {
    components: config.components,
    hosts: config.hosts,
    dryRun,
    onStep: quiet ? undefined : (r, i, t) => printStep(r, i, t, color, config),
  })
  if (!dryRun) {
    if (reports.every((r) => r.status !== 'failed')) await registerNode(runtime)
    // Profiles share ~/.claude assets via symlinks; sync picks up MCP servers that setup just added.
    try {
      for (const r of await syncProfiles(runtime)) for (const w of r.report.warnings) process.stderr.write(`⚠ ${r.profile.name}: ${w}\n`)
    } catch (e) {
      process.stderr.write(`⚠ No se pudieron sincronizar los perfiles: ${e instanceof Error ? e.message : String(e)}\n`)
    }
  }
  return reports
}

async function interactiveWizard(runtime: SystemRuntime, current: ShellConfig | null): Promise<ShellConfig | null> {
  const color = colorEnabled()
  const detected = detectHosts(runtime)
  const base = current ?? { ...defaultConfig(), hosts: detected.length > 0 ? detected : defaultConfig().hosts }
  const outcome = await runWizard(async (q, stepLabel) => {
    const theme = getTheme(base.theme)
    const header = renderBanner({
      theme,
      color,
      columns: process.stdout.columns ?? 80,
      subtitle: 'Configuración inicial del ecosistema *seb\n',
    })
    return runMenu({ input: process.stdin, output: process.stdout }, q.mode, q.options, q.initial, {
      title: q.title,
      stepLabel,
      theme,
      color,
      header,
    })
  }, detected, base)

  process.stdout.write('\x1b[2J\x1b[H')
  if (outcome.kind === 'aborted') return current
  const file = await saveConfig(runtime, outcome.config)
  process.stdout.write(`Configuración guardada en ${file}\n`)
  if (outcome.install) {
    const reports = await install(runtime, outcome.config, false)
    const failed = reports.filter((r) => r.status === 'failed')
    process.stdout.write(failed.length === 0 ? 'Ecosistema listo.\n' : `${failed.length} paso(s) fallaron; revisa arriba.\n`)
  }
  return outcome.config
}

function readFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  if (i === -1) return undefined
  const value = args[i + 1]
  const hasValue = value !== undefined && !value.startsWith('--')
  args.splice(i, hasValue ? 2 : 1)
  return hasValue ? value : undefined
}

const USAGE = `sebshell v${VERSION} — shell unificada del ecosistema *seb

Uso:
  sebshell                         Abre la shell (asistente en el primer arranque)
  sebshell config                  Reabre el asistente de configuración
  sebshell install [--dry-run]     Instala/configura las herramientas elegidas
  sebshell run --host claude|agy [--agent <rol>] [--profile <nombre>] "<prompt>"
  sebshell profile <list|add|login|use|rm|sync>   Cuentas por host (ver: sebshell profile help)
  sebshell doctor [--json]         Estado de hosts, nodos hubseb y configuración
  sebshell capabilities [--json]
`

export async function main(argv: string[]): Promise<number> {
  const runtime = new SystemRuntime()
  const jsonMode = argv.includes('--json')
  const args = argv.filter((a) => a !== '--json')
  const action = args[0]

  if (action === '--version' || action === '-v' || action === 'version') {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }
  if (action === 'help' || action === '--help' || action === '-h') {
    process.stdout.write(USAGE)
    return 0
  }
  if (action === 'capabilities' || action === 'ping') {
    const info = { id: NODE_ID, version: VERSION, provides: PROVIDES }
    process.stdout.write(jsonMode ? serializeWire(wireSuccess(action, info)) : `sebshell v${VERSION} [provides: ${PROVIDES.join(', ')}]\n`)
    return 0
  }

  const config = await loadConfig(runtime)

  if (action === 'doctor') {
    const hosts = detectHosts(runtime)
    const nodes = (await new TopologyStore(runtime).listNodes()).map((n) => `${n.id}@${n.version}`)
    const payload = { configFile: configFile(runtime), configured: Boolean(config), hosts, nodes, herdr: runtime.locateBinary('herdr') }
    if (jsonMode) process.stdout.write(serializeWire(wireSuccess('doctor', payload)))
    else {
      process.stdout.write(
        [
          `config : ${payload.configured ? payload.configFile : 'sin configurar (ejecuta sebshell)'}`,
          `hosts  : ${hosts.join(', ') || 'ninguno detectado'}`,
          `nodos  : ${nodes.join(', ') || 'ninguno'}`,
          `herdr  : ${payload.herdr ?? 'no encontrado'}`,
        ].join('\n') + '\n',
      )
    }
    return 0
  }

  if (action === 'install') {
    const effective = config ?? defaultConfig()
    const dryRun = args.includes('--dry-run')
    const reports = await install(runtime, effective, dryRun, jsonMode)
    const failed = reports.some((r) => r.status === 'failed')
    if (jsonMode) process.stdout.write(serializeWire(wireSuccess('install', { reports })))
    return failed ? 1 : 0
  }

  if (action === 'profile' || action === 'profiles') {
    const sub = args.slice(1)
    if (sub[0] === 'help' || sub[0] === '--help') {
      process.stdout.write(PROFILE_USAGE)
      return 0
    }
    return runProfileCli(runtime, sub, jsonMode)
  }

  if (action === 'run') {
    const rest = args.slice(1)
    const hostArg = readFlag(rest, '--host') ?? config?.orchestrator ?? 'claude'
    const agent = readFlag(rest, '--agent') ?? null
    const profileName = readFlag(rest, '--profile') ?? null
    const host = parseHost(hostArg)
    const prompt = rest.join(' ').trim()
    if (!host || !prompt) {
      const msg = !host ? `Host inválido "${hostArg}"` : 'Falta el prompt'
      process.stderr.write(jsonMode ? serializeWire(wireFailure('run', 'bad_args', msg)) : `${msg}\n${USAGE}`)
      return 2
    }
    let profile: Profile
    try {
      profile = await resolveProfile(runtime, host, profileName)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      process.stderr.write(jsonMode ? serializeWire(wireFailure('run', 'profile_error', msg)) : `${msg}\n`)
      return 2
    }
    const res = await runTurn(makeDeps(runtime), {
      host,
      agent,
      prompt,
      env: profileEnv(profile),
      contextWindow: config?.contextWindow[host],
    })
    if (jsonMode) {
      process.stdout.write(
        serializeWire(res.ok ? wireSuccess('run', { ...res, host, profile: profile.name }) : wireFailure('run', 'host_error', res.error ?? 'error')),
      )
    } else {
      process.stdout.write(res.ok ? `${res.text.trimEnd()}\n` : '')
      if (!res.ok) process.stderr.write(`${res.error}\n`)
    }
    return res.ok ? 0 : 1
  }

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)

  if (action === 'config') {
    if (!interactive) {
      process.stderr.write('sebshell config requiere una terminal interactiva\n')
      return 2
    }
    installTerminalRestore(process.stdin, process.stdout)
    await interactiveWizard(runtime, config)
    return 0
  }

  if (action !== undefined) {
    process.stderr.write(`Comando desconocido "${action}"\n${USAGE}`)
    return 2
  }

  if (!interactive) {
    process.stderr.write(`sebshell necesita una terminal interactiva; usa "sebshell run".\n`)
    return 2
  }

  installTerminalRestore(process.stdin, process.stdout)
  const effective = config ?? (await interactiveWizard(runtime, null))
  if (!effective) return 0

  const deps = makeDeps(runtime)
  const store = new TopologyStore(runtime)
  await runShell(
    { input: process.stdin, output: process.stdout, color: colorEnabled() },
    effective,
    {
      dispatch: deps,
      services: async () => {
        const ids = new Set((await store.listNodes()).map((n) => n.id))
        const wanted: ComponentId[] = ['memoseb', 'crewseb']
        return [
          ...wanted.filter((id) => effective.components.includes(id)).map((id) => ({ id, healthy: ids.has(id) })),
          { id: 'herdr', healthy: Boolean(process.env.HERDR_ENV || process.env.HERDR_PANE_ID || runtime.locateBinary('herdr')) },
        ]
      },
      reconfigure: () => interactiveWizard(runtime, effective),
      profiles: {
        active: async (host) => activeProfileName(await loadProfiles(runtime), host),
        names: async (host) => listProfiles(await loadProfiles(runtime), host).map((p) => p.name),
        env: async (host, name) => profileEnv(await resolveProfile(runtime, host, name)),
      },
    },
    VERSION,
  )
  return 0
}

const isEntry = (() => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isEntry) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
      process.exit(1)
    },
  )
}
