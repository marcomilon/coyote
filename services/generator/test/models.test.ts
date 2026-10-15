import { describe, expect, it } from 'vitest';
import { DEFAULT_IMAGE_MODEL_ID, DEFAULT_MODEL_ID, DEFAULT_PAGE_MODEL, DEFAULT_PRESCREEN_MODEL_ID, hasTier, modelTier, PAGE_MODELS, writerModel } from '../src/core/models';

describe('model tiers', () => {
  it('gives every model Coyote uses a tier', () => {
    for (const id of [...Object.values(PAGE_MODELS), DEFAULT_MODEL_ID, DEFAULT_PRESCREEN_MODEL_ID, DEFAULT_IMAGE_MODEL_ID]) expect(hasTier(id), id).toBe(true);
  });

  it('makes Opus and the photos paid, Haiku and Nova free', () => {
    expect(modelTier(PAGE_MODELS.opus)).toBe('paid');
    expect(modelTier(DEFAULT_IMAGE_MODEL_ID)).toBe('paid');
    expect(modelTier(PAGE_MODELS.haiku)).toBe('free');
    expect(modelTier(DEFAULT_MODEL_ID)).toBe('free');
    expect(modelTier(DEFAULT_PRESCREEN_MODEL_ID)).toBe('free');
  });

  it('counts an unknown model as paid', () => {
    expect(hasTier('claude-new-model')).toBe(false);
    expect(modelTier('claude-new-model')).toBe('paid');
    expect(modelTier('toString')).toBe('paid');
  });

  it('names the writer: the template model in template mode, otherwise the page writer', () => {
    expect(writerModel('template', PAGE_MODELS.opus, DEFAULT_MODEL_ID)).toBe(DEFAULT_MODEL_ID);
    expect(writerModel('design', PAGE_MODELS.haiku, DEFAULT_MODEL_ID)).toBe(PAGE_MODELS.haiku);
    expect(writerModel(undefined, undefined, DEFAULT_MODEL_ID)).toBe(DEFAULT_PAGE_MODEL);
  });
});
