import { spawn } from 'node:child_process';

/**
 * Run a child process to completion and return its stdout/stderr.
 *
 * Used by the `ffmpeg`, `ytdlp`, and (later) `ml_subprocess` integrations.
 * Direct `child_process.spawn` calls elsewhere in the codebase are forbidden
 * — go through one of those wrappers instead.
 */
export type RunProcOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Cap stderr/stdout buffering to avoid blowing memory on chatty tools. */
  maxBufferBytes?: number;
  /** Log the resolved argv before spawning. */
  logCommand?: boolean;
};

export type RunProcResult = {
  stdout: string;
  stderr: string;
  code: number;
};

export async function runProc(
  cmd: string,
  args: string[],
  opts: RunProcOptions = {},
): Promise<RunProcResult> {
  const maxBuf = opts.maxBufferBytes ?? 50 * 1024 * 1024; // 50 MB cap
  if (opts.logCommand) {
    console.log(`[proc] ${cmd} ${args.map(quoteArg).join(' ')}`);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < maxBuf) {
        stdout += chunk.toString('utf8');
      } else {
        truncated = true;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < maxBuf) {
        stderr += chunk.toString('utf8');
      } else {
        truncated = true;
      }
    });
    child.on('error', (err) => {
      reject(new Error(`${cmd}: spawn failed: ${err.message}`));
    });
    child.on('close', (code) => {
      const exitCode = code ?? -1;
      if (truncated) {
        stderr += '\n[runProc] output truncated';
      }
      if (exitCode !== 0) {
        const tailErr = stderr.slice(-2000);
        reject(
          new Error(`${cmd} exited with code ${exitCode}${tailErr ? `: ${tailErr.trim()}` : ''}`),
        );
        return;
      }
      resolve({ stdout, stderr, code: exitCode });
    });
  });
}

function quoteArg(arg: string): string {
  return /[\s"'$`\\]/.test(arg) ? JSON.stringify(arg) : arg;
}
