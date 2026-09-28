import { describe, expect, it } from 'vitest';
import { normalizeAnswers } from '../src/core/answers';
import { ModelOutputError, type CallTool } from '../src/core/bedrock';
import { PolicyRejection } from '../src/core/policy';
import { generateSite } from '../src/core/pipeline';
import { brief, content } from './fixtures';

const answers = normalizeAnswers({
  businessName: 'Panadería Luna',
  about: 'Panadería de masa madre en Chapinero, Bogotá.',
  whatsapp: '+57 300 123 4567',
});

const { businessName: _n, lang: _l, contact: _c, media: _m, ...modelContent } = content;
const usage = (step: string) => ({ step, modelId: 'test', inputTokens: 1, outputTokens: 1 });

describe('generateSite', () => {
  it('takes contact details from the answers, not from the model', async () => {
    const callTool = (async ({ tool }) => ({
      value: tool.name === 'design_brief' ? brief : { ...modelContent, contact: { whatsapp: '5700000000' } },
      usage: usage(tool.name),
    })) as CallTool;

    const site = await generateSite(answers, { callTool, modelId: 'test', slug: 'panaderia-luna' });
    expect(site.content.contact.whatsapp).toBe('573001234567');
    expect(site.content.businessName).toBe('Panadería Luna');
    expect(site.usage.map((u) => u.step)).toEqual(['design_brief', 'publish_content']);
  });

  it('strips URLs the model wrote and rejects content that breaks the policy', async () => {
    const respond = (about: string) =>
      (async ({ tool }) => ({
        value: tool.name === 'design_brief' ? brief : { ...modelContent, about },
        usage: usage(tool.name),
      })) as CallTool;

    const clean = await generateSite(answers, { callTool: respond('Pide en https://evil.test/pan hoy'), modelId: 'test', slug: 'panaderia-luna' });
    expect(clean.content.about).toBe('Pide en hoy');

    await expect(
      generateSite(answers, { callTool: respond('Verifica tu cuenta para seguir comprando.'), modelId: 'test', slug: 'panaderia-luna' }),
    ).rejects.toBeInstanceOf(PolicyRejection);
  });

  it('retries once with the validation errors as feedback', async () => {
    const prompts: string[] = [];
    let contentCalls = 0;
    const callTool = (async ({ tool, user, guarded }) => {
      if (tool.name === 'design_brief') return { value: brief, usage: usage(tool.name) };
      expect(guarded).toContain('<answers>');
      prompts.push(user);
      if (++contentCalls === 1) throw new ModelOutputError('headline: too long', usage(tool.name));
      return { value: modelContent, usage: usage(tool.name) };
    }) as CallTool;

    const site = await generateSite(answers, { callTool, modelId: 'test', slug: 'panaderia-luna' });
    expect(contentCalls).toBe(2);
    expect(prompts[1]).toContain('headline: too long');
    expect(site.usage).toHaveLength(3);
  });
});
