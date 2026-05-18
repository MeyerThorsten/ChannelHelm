import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const PROMPTS_DIR = join(process.cwd(), 'prompts');

export type Prompt = {
  name: string;
  version: number;
  inputs: string[];
  model: string | null;
  system: string | null;
  body: string;
};

/**
 * Load `prompts/{name}.v{N}.md`. The file is a small YAML-frontmatter +
 * markdown body. The markdown body itself is the user-prompt template.
 *
 *   ---
 *   name: linkedin_post
 *   version: 3
 *   inputs: [intelligence, brand]
 *   model: qwen3-32b
 *   system: You are a senior content strategist…
 *   ---
 *   Given the following intelligence summary…
 */
export async function loadPrompt(name: string, version: number): Promise<Prompt> {
  const path = join(PROMPTS_DIR, `${name}.v${version}.md`);
  const raw = await readFile(path, 'utf8');
  return parsePrompt(name, version, raw);
}

export function parsePrompt(name: string, version: number, raw: string): Prompt {
  const trimmed = raw.replace(/^﻿/, '');
  const match = trimmed.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    throw new Error(`prompt ${name}.v${version}: missing YAML frontmatter`);
  }
  const frontmatter = parseSimpleYaml(match[1] ?? '');
  const body = (match[2] ?? '').trim();
  return {
    name: String(frontmatter.name ?? name),
    version: Number(frontmatter.version ?? version),
    inputs: Array.isArray(frontmatter.inputs) ? frontmatter.inputs.map(String) : [],
    model: typeof frontmatter.model === 'string' ? frontmatter.model : null,
    system: typeof frontmatter.system === 'string' ? frontmatter.system : null,
    body,
  };
}

/**
 * Hand-rolled YAML subset: supports `key: scalar`, `key: [a, b, c]` lists,
 * multi-line block scalars (`key: |` then indented lines). That covers our
 * needs without pulling in a yaml dependency for ~10 prompt files.
 */
function parseSimpleYaml(src: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = src.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    i++;
    if (!line.trim() || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();
    if (rest === '|') {
      const buf: string[] = [];
      while (i < lines.length) {
        const next = lines[i] ?? '';
        if (/^\S/.test(next) && next.trim()) break;
        buf.push(next.replace(/^\s{2}/, ''));
        i++;
      }
      out[key] = buf.join('\n').trim();
      continue;
    }
    if (rest.startsWith('[') && rest.endsWith(']')) {
      out[key] = rest
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
      continue;
    }
    out[key] = rest.replace(/^['"]|['"]$/g, '');
  }
  return out;
}

export function render(prompt: Prompt, vars: Record<string, unknown>): string {
  // Tiny `{{ var }}` substitution. Values are JSON-stringified when they're
  // not strings so the LLM sees structured inputs verbatim.
  return prompt.body.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, k: string) => {
    const value = lookup(vars, k);
    if (value === undefined) return `{{${k}}}`;
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  });
}

function lookup(vars: Record<string, unknown>, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, vars);
}
