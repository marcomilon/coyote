import { describe, expect, it } from 'vitest';
import { normalizeAnswers } from '../src/core/answers';
import { answersBlock, briefSystemPrompt, briefUserPrompt, contentSystemPrompt, contentUserPrompt, editSystemPrompt, editUserPrompt, planSystemPrompt, planUserPrompt } from '../src/core/prompt';
import { editorial as plain } from '../themes/editorial';
import { brief, modelContent } from './fixtures';

const answers = normalizeAnswers({
  businessName: 'Panadería Luna',
  about: 'Panadería de masa madre en Chapinero, Bogotá. Abrimos de lunes a sábado de 7 a 19.',
  whatsapp: '+57 300 123 4567',
  address: 'Calle 60 # 9-12',
});
const context = { lang: 'es' as const, contact: { ...answers.contact, email: 'hola@luna.test' }, photos: 1 };

describe('prompts', () => {
  it('match the snapshots (review any change with the sites sheet)', () => {
    expect(briefSystemPrompt()).toMatchSnapshot('brief system');
    expect(briefUserPrompt([{ theme: plain, fontPairings: ['fraunces-worksans', 'dmserif-dmsans'] }])).toMatchSnapshot('brief user');
    expect(contentSystemPrompt('es')).toMatchSnapshot('content system es');
    expect(contentSystemPrompt('pt')).toMatchSnapshot('content system pt');
    expect(contentUserPrompt(brief)).toMatchSnapshot('content user');
    expect(planSystemPrompt()).toMatchSnapshot('plan system');
    expect(planUserPrompt(context)).toMatchSnapshot('plan user');
    expect(planUserPrompt({ ...context, edit: true })).toMatchSnapshot('plan user, edit');
    expect(editSystemPrompt('es')).toMatchSnapshot('edit system');
    expect(editUserPrompt(modelContent)).toMatchSnapshot('edit user');
    expect(answersBlock(answers, [{ question: '¿Qué vendes?', answer: 'Pan' }], 'cambia el horario')).toMatchSnapshot('answers');
  });

  it('never send a contact detail to the model', () => {
    for (const text of [answersBlock(answers), planUserPrompt(context)]) {
      expect(text).not.toContain('573001234567');
      expect(text).not.toContain('hola@luna.test');
    }
    expect(answersBlock(answers)).toContain('Calle 60 # 9-12'); // the address helps the copy; it is also checked by the guardrail
  });
});
