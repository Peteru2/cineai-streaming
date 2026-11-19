import { spawn } from 'node:child_process';

export class CommandError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = 'CommandError';
  }
}

export interface RunOptions {
  signal: AbortSignal; // aborted when the worker loses its lease
  timeoutMs: number;
}

export function runCommand(
  command: string,
  args: string[],
  options: RunOptions,
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      reject(new Error('Processing was stopped'));
      return;
    }

    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
      action();
    };

    const timer = setTimeout(() => {
      child.kill();
      settle(() =>
        reject(new Error(`${command} timed out after ${Math.round(options.timeoutMs / 1000)} seconds`)),
      );
    }, options.timeoutMs);

    const onAbort = () => {
      child.kill();
      settle(() => reject(new Error('Processing was stopped')));
    };
    options.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < 1_000_000) stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000); // keep only the tail
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      settle(() =>
        reject(
          err.code === 'ENOENT' ? new Error(`${command} is not installed or not on PATH`) : err,
        ),
      );
    });

    child.on('close', (code) => {
      settle(() =>
        code === 0
          ? resolve({ stdout })
          : reject(new CommandError(`${command} exited with code ${code}`, code, stderr)),
      );
    });
  });
}