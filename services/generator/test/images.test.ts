import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { imageMaker, IMAGE_NEGATIVE, MAX_IMAGES, type ImageDeps } from '../src/core/images';
import { anthropicWritePage, MAKE_IMAGE_TOOL, pageParams, pagePrompt, type MakeImage } from '../src/core/page-writer';
import { loadDraft } from '../src/core/drafts';
import { runGenerateJob } from '../src/core/generate-job';
import { editSite } from '../src/core/owner';
import { DEFAULT_MODEL_ID, usageCost } from '../src/core/models';
import { submit } from '../src/core/submit';
import { body, harness } from './harness';

const contact = { whatsapp: '573001234567' };
const answers = { businessName: 'Luna', about: 'Pan', lang: 'es' as const, contact };

function deps(overrides: Partial<ImageDeps> = {}) {
  const saved = new Map<string, Uint8Array>();
  const deleted: string[] = [];
  const prompts: [string, string, string][] = [];
  const d: ImageDeps = {
    stores: { putAsset: async (key, bytes) => void saved.set(key, bytes), deletePrefix: async (key) => void deleted.push(key) },
    generateImage: async (prompt, negative, aspect) => (prompts.push([prompt, negative, aspect]), new Uint8Array([1, 2, 3])),
    moderate: async () => [],
    outputAllowed: async () => true,
    ...overrides,
  };
  return { d, saved, deleted, prompts };
}

describe('what a model call costs', () => {
  it('prices tokens, cached tokens, and photos; an unknown model has no price', () => {
    expect(usageCost({ step: 'write_page', modelId: 'claude-opus-5-5', inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(24);
    expect(usageCost({ step: 'plan_site', modelId: DEFAULT_MODEL_ID, inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 })).toBeCloseTo(0.11 + 1.375);
    expect(usageCost({ step: 'make_image', modelId: 'anything', inputTokens: 0, outputTokens: 0 })).toBe(0.04);
    expect(usageCost({ step: 'x', modelId: 'unknown', inputTokens: 1, outputTokens: 1 })).toBeUndefined();
  });
});

describe('make_image', () => {
  it('saves a screened photo next to the page and reports its file', async () => {
    const { d, saved, prompts } = deps();
    const made: string[] = [];
    const result = await imageMaker('_media/luna/', d, made)({ description: 'Warm bread on a wooden table', aspect: '4:3' });
    expect(result).toMatchObject({ file: expect.stringMatching(/^assets\/gen-[0-9a-f]{8}\.jpg$/) });
    expect(made).toEqual(['file' in result && result.file]);
    expect([...saved.keys()]).toEqual([`_media/luna/${made[0]}`]);
    expect(prompts).toEqual([['Warm bread on a wooden table', IMAGE_NEGATIVE, '4:3']]);
  });

  it('refuses a scene the guardrail blocks, one the model filters, and a photo that fails moderation', async () => {
    const blocked = deps({ outputAllowed: async () => false });
    expect(await imageMaker('p/', blocked.d)({ description: 'x', aspect: '1:1' })).toEqual({ error: 'the scene was refused' });
    expect(blocked.prompts).toEqual([]);
    const filtered = deps({ generateImage: async () => undefined });
    expect(await imageMaker('p/', filtered.d)({ description: 'x', aspect: '1:1' })).toHaveProperty('error');
    const flagged = deps({ moderate: async () => ['Violence'] });
    const made: string[] = [];
    expect(await imageMaker('p/', flagged.d, made)({ description: 'x', aspect: '1:1' })).toEqual({ error: 'the photo did not pass moderation' });
    expect(flagged.deleted).toHaveLength(1);
    expect(made).toEqual([]);
  });

  it(`makes at most ${MAX_IMAGES} photos per page`, async () => {
    const { d, prompts } = deps();
    const make = imageMaker('p/', d);
    const results = await Promise.all(Array.from({ length: MAX_IMAGES + 2 }, () => make({ description: 'x', aspect: '16:9' })));
    expect(results.filter((r) => 'file' in r)).toHaveLength(MAX_IMAGES);
    expect(prompts).toHaveLength(MAX_IMAGES);
  });
});

describe('the page writer with make_image', () => {
  const request = { answers, notes: [], photos: [] };

  it('offers the tool and says so only when it may make photos', () => {
    expect(pageParams(request, 'claude-opus-5-5', 'high', null, true)).toMatchObject({ tools: [MAKE_IMAGE_TOOL] });
    expect(pageParams(request, 'claude-opus-5-5', 'high', null)).not.toHaveProperty('tools');
    expect(pagePrompt(request, null, true)).toContain('make photos with the make_image tool (describe each scene in English), or draw them as SVG');
    expect(pagePrompt(request, null)).not.toContain('make_image');
    const photos = [{ file: 'assets/photo-1.jpg', label: '', bytes: new Uint8Array(), mediaType: 'image/jpeg' as const }];
    expect(pagePrompt({ ...request, photos }, null, true)).toContain('Where the page needs more images, you can make photos with the make_image tool');
  });

  it('runs the tool calls, sends back the photos, and returns the page with the usage of every round', async () => {
    const page = '```html\n<!doctype html><html><body><img src="assets/gen-1.jpg"></body></html>\n```';
    const replies: Partial<Anthropic.Message>[] = [
      {
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5 } as Anthropic.Usage,
        content: [
          { type: 'tool_use', id: 't1', name: 'make_image', input: { description: 'Bread', aspect: '4:3' } },
          { type: 'tool_use', id: 't2', name: 'make_image', input: { description: 'A sign with the name', aspect: 'square' } },
        ] as Anthropic.ContentBlock[],
      },
      { stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 7 } as Anthropic.Usage, content: [{ type: 'text', text: page }] as Anthropic.ContentBlock[] },
    ];
    const sent: Anthropic.MessageStreamParams[] = [];
    const api = { messages: { stream: (params: Anthropic.MessageStreamParams) => (sent.push(structuredClone(params)), { finalMessage: async () => replies.shift() }) } } as unknown as Pick<Anthropic, 'messages'>;
    const asked: Parameters<MakeImage>[0][] = [];
    const makeImage: MakeImage = async (input) => (asked.push(input), input.description === 'Bread' ? { file: 'assets/gen-1.jpg', bytes: new Uint8Array([9]) } : { error: 'refused' });

    const reply = await anthropicWritePage({ ANTHROPIC_API_KEY: 'k' }, api)(request, { effort: 'high', model: 'claude-opus-5-5', makeImage });
    expect(reply.text).toContain('gen-1.jpg');
    expect(reply.usage).toMatchObject({ inputTokens: 30, outputTokens: 12 });
    expect(asked).toEqual([{ description: 'Bread', aspect: '4:3' }, { description: 'A sign with the name', aspect: '16:9' }]);
    const results = sent[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
    expect(results[0]).toMatchObject({ tool_use_id: 't1', content: [{ type: 'image' }, { type: 'text', text: 'Saved as assets/gen-1.jpg' }] });
    expect(results[1]).toMatchObject({ tool_use_id: 't2', is_error: true, content: expect.stringContaining('Draw this image as SVG instead') });
  });
});

describe('runGenerateJob with made photos', () => {
  const generateImage = async () => new Uint8Array([1]);

  it('offers make_image only when the owner left the toggle on and the page-images switch is on', async () => {
    for (const [aiImages, pageImages, offered] of [[true, undefined, true], [true, false, false], [false, true, false], [undefined, true, false]] as const) {
      const t = harness();
      await submit({ ...body, ...(aiImages !== undefined && { aiImages }) }, '1.2.3.4', t.submitDeps);
      await runGenerateJob('job-1', { ...t.generateDeps, generateImage, pageImages });
      expect(!!t.writer.settings[0]!.makeImage).toBe(offered);
    }
  });

  it('keeps the made photos the page uses, in the draft and in later edits', async () => {
    const t = harness();
    Object.assign(t.writer.options, { images: ['Bread', 'Coffee', 'Oven'], useImages: 2 });
    await submit({ ...body, aiImages: true }, '1.2.3.4', t.submitDeps);
    const deps = { ...t.generateDeps, generateImage, imageModelId: 'stability' };
    expect(await runGenerateJob('job-1', deps)).toMatchObject({ outcome: 'DONE' });
    const site = t.sites.get(t.jobs.get('job-1')!.slug!)!;
    const doc = await loadDraft(site.slug, site.currentDraftId!, t.generateDeps.stores);
    expect(doc.media.generated).toHaveLength(2);
    for (const file of doc.media.generated!) expect(t.objects.has(`_draft/${site.currentDraftId}/${file}`)).toBe(true);
    expect(t.jobs.get('job-1')!.usage.filter((u) => u.step === 'make_image')).toEqual(Array(3).fill({ step: 'make_image', modelId: 'stability', inputTokens: 0, outputTokens: 0 }));

    // An edit that makes no photos keeps the ones its page still shows.
    Object.assign(t.writer.options, { images: [] });
    expect(await editSite(site, { instruction: 'agrega que abrimos los domingos' }, t.ownerDeps)).toMatchObject({ status: 202 });
    expect(await runGenerateJob('job-2', deps)).toMatchObject({ outcome: 'DONE' });
    expect(t.writer.settings[1]!.makeImage).toBeDefined();
    const edited = t.sites.get(site.slug)!;
    expect((await loadDraft(site.slug, edited.currentDraftId!, t.generateDeps.stores)).media.generated).toEqual(doc.media.generated);
  });
});
