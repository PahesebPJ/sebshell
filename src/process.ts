import { spawn } from 'node:child_process'
import type { ProcessOutcome } from 'hubseb'
import { mergeEnv } from './profiles.ts'

export interface ExecOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  input?: string
  signal?: AbortSignal
  /** Kills the child when stdout+stderr exceed this many characters (default 20M). */
  maxOutput?: number
}

/** Like hubseb's execProcess, plus AbortSignal support so Ctrl+C can stop an in-flight host turn. */
export function execCancellable(bin: string, args: readonly string[], opts: ExecOptions = {}): Promise<ProcessOutcome> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      resolve({ exitCode: 130, stdout: '', stderr: 'cancelado' })
      return
    }
    const child = spawn(bin, [...args], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let aborted = false
    const onAbort = () => {
      aborted = true
      child.kill('SIGTERM')
      setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 2000).unref()
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const cap = opts.maxOutput ?? 20_000_000
    let overflow = false
    const collect = (append: (c: string) => void) => (c: string) => {
      if (overflow) return
      append(c)
      if (stdout.length + stderr.length > cap) {
        overflow = true
        child.kill('SIGTERM')
      }
    }
    child.stdout.setEncoding('utf8').on('data', collect((c) => (stdout += c)))
    child.stderr.setEncoding('utf8').on('data', collect((c) => (stderr += c)))
    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      if (aborted) resolve({ exitCode: 130, stdout, stderr: 'cancelado' })
      else if (overflow) resolve({ exitCode: 1, stdout: '', stderr: `salida demasiado grande (> ${cap} caracteres)` })
      else resolve({ exitCode: code ?? 1, stdout, stderr })
    })
    child.stdin.on('error', () => undefined)
    if (opts.input !== undefined) child.stdin.write(opts.input)
    child.stdin.end()
  })
}

/** Runs a host attached to the user's terminal (e.g. `claude auth login`) and resolves with its exit code. */
export function execInteractive(bin: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], { stdio: 'inherit', env: env ? mergeEnv(process.env, env) : process.env })
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
}
