import { describe, expect, it } from 'vitest';
import { normalizeAnswers } from '../src/core/answers';
import { answersBlock, briefSystemPrompt, briefUserPrompt, contentSystemPrompt, contentUserPrompt } from '../src/core/prompt';
import { editorial as plain } from '../themes/editorial';
import { brief } from './fixtures';

const answers = normalizeAnswers({
  businessName: 'Panadería Luna',
  about: 'Panadería de masa madre en Chapinero, Bogotá. Abrimos de lunes a sábado de 7 a 19.',
  whatsapp: '+57 300 123 4567',
  address: 'Calle 60 # 9-12',
});

describe('prompts', () => {
  it('match the snapshots (review any change with the contact sheet)', () => {
    expect(briefSystemPrompt()).toMatchSnapshot('brief system');
    expect(answersBlock(answers)).toMatchSnapshot('answers');
    expect(briefUserPrompt([{ theme: plain, fontPairings: ['fraunces-worksans', 'dmserif-dmsans'] }])).toMatchSnapshot('brief user');
    expect(contentSystemPrompt('es')).toMatchSnapshot('content system es');
    expect(contentSystemPrompt('pt')).toMatchSnapshot('content system pt');
    expect(contentUserPrompt(brief)).toMatchSnapshot('content user');
  });

  it('never sends the phone number to the model', () => {
    expect(answersBlock(answers)).not.toContain('573001234567');
    expect(answersBlock(answers)).toContain('Calle 60 # 9-12');
  });
});
