import { describe, expect, it } from 'vitest';
import { normalizeAnswers } from '../src/core/answers';
import type { CallTool } from '../src/core/bedrock';
import { isRejected, prescreen } from '../src/core/prescreen';
import { PRESCREEN_CASES } from './fixtures/prescreen-cases';

const answers = normalizeAnswers({
  businessName: 'Panadería Luna',
  about: 'Panadería de masa madre en Chapinero, Bogotá.',
  whatsapp: '+57 300 123 4567',
  address: 'Calle 60 # 9-12',
});

describe('prescreen', () => {
  it('sends the answers as data, without the phone number, and returns the classification', async () => {
    let seen = '';
    const callTool = (async ({ guarded, tool }) => {
      seen = guarded;
      expect(tool.name).toBe('classify');
      return {
        value: { reason: 'Bakery.', decision: 'allow', category: 'ok', confidence: 0.98 },
        usage: { step: 'classify', modelId: 'test', inputTokens: 1, outputTokens: 1 },
      };
    }) as CallTool;

    const result = await prescreen(answers, { callTool, modelId: 'test' });
    expect(result.decision).toBe('allow');
    expect(seen).toContain('<answers>');
    expect(seen).toContain('Calle 60 # 9-12');
    expect(seen).not.toContain('573001234567');
  });
});

describe('isRejected', () => {
  it('trusts a confident reject only', () => {
    const base = { reason: '', category: 'adult' as const };
    expect(isRejected({ ...base, decision: 'reject', confidence: 0.9 })).toBe(true);
    expect(isRejected({ ...base, decision: 'reject', confidence: 0.3 })).toBe(false);
    expect(isRejected({ ...base, decision: 'allow', confidence: 0.9 })).toBe(false);
  });
});

describe('fixture set', () => {
  it('has good, borderline, and bad cases with unique names', () => {
    const names = PRESCREEN_CASES.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(PRESCREEN_CASES.filter((c) => c.expect === 'allow').length).toBeGreaterThanOrEqual(20);
    expect(PRESCREEN_CASES.filter((c) => c.expect === 'reject').length).toBeGreaterThanOrEqual(20);
  });
});
