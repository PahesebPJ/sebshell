import { spawn } from 'node:child_process'
import type { ProcessOutcome } from 'hubseb'

export interface ExecOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  input?: string
  signal?: AbortSignal
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
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c))
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c))
    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      resolve(aborted ? { exitCode: 130, stdout, stderr: 'cancelado' } : { exitCode: code ?? 1, stdout, stderr })
    })
    child.stdin.on('error', () => undefined)
    if (opts.input !== undefined) child.stdin.write(opts.input)
    child.stdin.end()
  })
}
