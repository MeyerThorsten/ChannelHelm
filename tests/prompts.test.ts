import { describe, expect, it } from 'vitest';
import { parsePrompt, render } from '@workers/integrations/prompts';

describe('parsePrompt', () => {
  it('parses scalar / list / block-scalar frontmatter', () => {
    const raw = `---
name: example
version: 2
inputs: [foo, bar]
model: qwen3-32b
system: |
  Multi-line
  system prompt.
---
Body line one.
Body line two with {{ var }}.
`;
    const p = parsePrompt('example', 2, raw);
    expect(p.name).toBe('example');
    expect(p.version).toBe(2);
    expect(p.inputs).toEqual(['foo', 'bar']);
    expect(p.model).toBe('qwen3-32b');
    expect(p.system).toBe('Multi-line\nsystem prompt.');
    expect(p.body).toContain('{{ var }}');
  });

  it('throws on missing frontmatter', () => {
    expect(() => parsePrompt('x', 1, 'just a body')).toThrow(/missing YAML frontmatter/);
  });
});

describe('render', () => {
  const p = parsePrompt(
    'x',
    1,
    `---
name: x
version: 1
---
Hello {{ user.name }}, your score is {{ score }}. Json: {{ obj }}.
`,
  );

  it('substitutes scalar strings', () => {
    const out = render(p, { user: { name: 'Thorsten' }, score: '42', obj: 'X' });
    expect(out).toContain('Hello Thorsten,');
    expect(out).toContain('your score is 42');
  });

  it('JSON-stringifies non-string values', () => {
    const out = render(p, { user: { name: 'T' }, score: 42, obj: { k: 1 } });
    expect(out).toContain('your score is 42');
    expect(out).toContain('"k": 1');
  });

  it('leaves unresolved placeholders intact', () => {
    const out = render(p, {});
    expect(out).toContain('{{user.name}}');
    expect(out).toContain('{{score}}');
  });
});
