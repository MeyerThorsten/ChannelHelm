import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProc } from '../_proc';
import type { LlmMessage, LlmOptions, LlmProvider, LlmResponse, ProviderConfig } from './types';

/**
 * Codex CLI provider — runs OpenAI's local `codex` binary in non-interactive
 * mode (`codex exec`), authenticating via the user's ChatGPT subscription
 * (OAuth in ~/.codex) instead of a per-token API key. Modeled on DojoClaw's
 * codex.provider. NOT an HTTP provider: spawns the CLI, pipes the prompt on
 * stdin, reads the final message from a temp file (`-o`).
 *
 * Requirements: `codex` on PATH (or CODEX_BIN) and `codex login` completed.
 * Runs read-only in an isolated temp dir so it can't touch the repo.
 */
const CODEX_TIMEOUT_MS = 300_000;
const codexBin = () => process.env.CODEX_BIN ?? 'codex';

export class CodexCliProvider implements LlmProvider {
  constructor(private config: ProviderConfig) {}

  getName(): string {
    return this.config.name;
  }
  getModel(): string {
    return this.config.model;
  }
  getType(): string {
    return 'codex-cli';
  }

  private buildPrompt(messages: LlmMessage[]): string {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content);
    const convo = messages.filter((m) => m.role !== 'system');
    const parts: string[] = [];
    if (system.length > 0) parts.push(`# Instructions\n${system.join('\n\n')}`);
    if (convo.length > 0) {
      parts.push(
        `# Conversation\n${convo
          .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`)
          .join('\n\n')}`,
      );
    }
    parts.push(
      '# Task\nRespond directly with the requested content only. Do not run commands, do not explain your process, do not ask questions. Output just the final answer.',
    );
    return parts.join('\n\n');
  }

  async chat(messages: LlmMessage[], options?: LlmOptions): Promise<LlmResponse> {
    const model = options?.model ?? this.config.model;
    const prompt = this.buildPrompt(messages);
    const workdir = await mkdtemp(join(tmpdir(), 'channelhelm-codex-'));
    const lastMsgFile = join(workdir, 'last-message.txt');

    const args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--ephemeral',
      '-s',
      'read-only',
      '--color',
      'never',
      '-C',
      workdir,
      '-o',
      lastMsgFile,
    ];
    // Empty/"default" model → defer to ~/.codex/config.toml.
    if (model && model.toLowerCase() !== 'default') args.push('-m', model);
    args.push('-'); // prompt on stdin

    try {
      const { stdout, code } = await runProc(codexBin(), args, {
        cwd: workdir,
        input: prompt,
        allowNonZeroExit: true,
        timeoutMs: CODEX_TIMEOUT_MS,
      });

      let inputTokens = 0;
      let outputTokens = 0;
      let messageFallback = '';
      let errorMessage = '';
      for (const line of stdout.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        try {
          const ev = JSON.parse(t) as {
            type?: string;
            message?: string;
            error?: { message?: string };
            usage?: { input_tokens?: number; output_tokens?: number };
            item?: { type?: string; text?: string };
          };
          if (ev.type === 'turn.completed' && ev.usage) {
            inputTokens = ev.usage.input_tokens ?? 0;
            outputTokens = ev.usage.output_tokens ?? 0;
          }
          if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && ev.item.text) {
            messageFallback = ev.item.text;
          }
          if (ev.type === 'error' || ev.type === 'turn.failed') {
            errorMessage = ev.error?.message ?? ev.message ?? errorMessage;
          }
        } catch {
          // skip non-JSON lines
        }
      }

      let content = await readFile(lastMsgFile, 'utf8')
        .then((s) => s.trim())
        .catch(() => '');
      if (!content) content = messageFallback;
      if (!content) {
        let detail = errorMessage;
        try {
          const inner = JSON.parse(errorMessage) as { error?: { message?: string } };
          if (inner?.error?.message) detail = inner.error.message;
        } catch {
          // not JSON
        }
        throw new Error(
          detail
            ? `codex exec error: ${detail}`
            : `codex exec produced no output (exit ${code}). Is codex logged in? Run \`codex login status\`.`,
        );
      }
      return { content, model, inputTokens, outputTokens, finishReason: 'stop' };
    } finally {
      await rm(workdir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async testConnection(): Promise<{ ok: boolean; error?: string; model?: string }> {
    try {
      const r = await this.chat([{ role: 'user', content: 'Reply with exactly: OK' }]);
      return { ok: true, model: r.model || this.config.model };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
