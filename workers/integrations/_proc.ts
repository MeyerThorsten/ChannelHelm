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
  /** Pipe this string to the child's stdin (e.g. a prompt for `codex exec`). */
  input?: string;
  /** Resolve (don't reject) on non-zero exit — caller inspects code/stdout. */
  allowNonZeroExit?: boolean;
  /** Kill the child after this many ms (SIGKILL) and reject. */
  timeoutMs?: number;
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
      stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`${cmd}: timed out after ${opts.timeoutMs}ms`));
      }, opts.timeoutMs);
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < maxBuf) {
        stdout += chunk.toString('utf8');
      } else {
        truncated = true;
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < maxBuf) {
        stderr += chunk.toString('utf8');
      } else {
        truncated = true;
      }
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`${cmd}: spawn failed: ${err.message}`));
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const exitCode = code ?? -1;
      if (truncated) {
        stderr += '\n[runProc] output truncated';
      }
      if (exitCode !== 0 && !opts.allowNonZeroExit) {
        const tailErr = stderr.slice(-2000);
        reject(
          new Error(`${cmd} exited with code ${exitCode}${tailErr ? `: ${tailErr.trim()}` : ''}`),
        );
        return;
      }
      resolve({ stdout, stderr, code: exitCode });
    });
    if (opts.input !== undefined) {
      child.stdin?.write(opts.input);
      child.stdin?.end();
    }
  });
}

function quoteArg(arg: string): string {
  return /[\s"'$`\\]/.test(arg) ? JSON.stringify(arg) : arg;
}
