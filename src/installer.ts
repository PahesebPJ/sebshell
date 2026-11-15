import type { ProcessOutcome } from 'hubseb'
import type { ComponentId, ShellHost } from './config.ts'
import { type CommandSpec, orderComponents } from './manifest.ts'

export type StepStatus = 'done' | 'skipped' | 'failed'

export interface StepReport {
  component: ComponentId
  phase: 'install' | 'setup'
  status: StepStatus
  detail: string
}

export interface InstallerDeps {
  locate(bin: string): string | null
  exec(bin: string, args: readonly string[]): Promise<ProcessOutcome>
}

export interface InstallPlanInput {
  components: readonly ComponentId[]
  hosts: readonly ShellHost[]
  dryRun?: boolean
  onStep?: (report: StepReport, index: number, total: number) => void
}

function tail(text: string, lines = 3): string {
  return text.trim().split('\n').slice(-lines).join(' ⏎ ')
}

async function runCommand(deps: InstallerDeps, cmd: CommandSpec): Promise<{ ok: boolean; detail: string }> {
  const exe = deps.locate(cmd.bin)
  if (!exe) return { ok: false, detail: `binario "${cmd.bin}" no encontrado en PATH` }
  try {
    const res = await deps.exec(exe, cmd.args)
    if (res.exitCode === 0) return { ok: true, detail: `${cmd.bin} ${cmd.args.join(' ')}` }
    return { ok: false, detail: `exit ${res.exitCode}: ${tail(res.stderr || res.stdout)}` }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Installs and sets up components in dependency order. A failed install skips
 * that component's setup but never aborts the rest of the run.
 */
export async function runInstall(deps: InstallerDeps, input: InstallPlanInput): Promise<StepReport[]> {
  const specs = orderComponents(input.components)
  const total = specs.reduce((acc, s) => acc + (s.setup ? 2 : 1), 0)
  const reports: StepReport[] = []
  const emit = (r: StepReport) => {
    reports.push(r)
    input.onStep?.(r, reports.length, total)
  }

  for (const spec of specs) {
    const missing = (spec.requiresBins ?? []).filter((b) => !deps.locate(b))
    if (missing.length > 0) {
      const detail = `requiere ${missing.join(', ')}`
      emit({ component: spec.id, phase: 'install', status: 'skipped', detail })
      if (spec.setup) emit({ component: spec.id, phase: 'setup', status: 'skipped', detail })
      continue
    }

    let installed = true
    if (spec.probeBin && deps.locate(spec.probeBin)) {
      emit({ component: spec.id, phase: 'install', status: 'skipped', detail: 'ya instalado' })
    } else if (input.dryRun) {
      emit({ component: spec.id, phase: 'install', status: 'skipped', detail: `dry-run: ${spec.install.bin} ${spec.install.args.join(' ')}` })
    } else {
      const res = await runCommand(deps, spec.install)
      installed = res.ok
      emit({ component: spec.id, phase: 'install', status: res.ok ? 'done' : 'failed', detail: res.detail })
    }

    if (!spec.setup) continue
    const setupCmd = spec.setup(input.hosts)
    if (!installed) {
      emit({ component: spec.id, phase: 'setup', status: 'skipped', detail: 'instalación fallida' })
    } else if (input.dryRun) {
      emit({ component: spec.id, phase: 'setup', status: 'skipped', detail: `dry-run: ${setupCmd.bin} ${setupCmd.args.join(' ')}` })
    } else {
      const res = await runCommand(deps, setupCmd)
      emit({ component: spec.id, phase: 'setup', status: res.ok ? 'done' : 'failed', detail: res.detail })
    }
  }
  return reports
}
