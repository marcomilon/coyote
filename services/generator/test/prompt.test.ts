import { describe, expect, it } from 'vitest';
import { normalizeAnswers } from '../src/core/answers';
import { answersBlock, designGuide, editUserPrompt, planSystemPrompt, planUserPrompt, siteSystemPrompt, writeUserPrompt } from '../src/core/prompt';

const answers = normalizeAnswers({
  businessName: 'Panadería Luna',
  about: 'Panadería de masa madre en Chapinero, Bogotá. Abrimos de lunes a sábado de 7 a 19.',
  whatsapp: '+57 300 123 4567',
  address: 'Calle 60 # 9-12',
});
const context = { lang: 'es' as const, contact: { ...answers.contact, email: 'hola@luna.test' }, media: { photos: ['assets/photo-1.jpg'] } };

describe('prompts', () => {
  it('match the snapshots (judge any change on the sites sheet)', () => {
    expect(planSystemPrompt()).toMatchSnapshot('plan system');
    expect(planUserPrompt(context)).toMatchSnapshot('plan user');
    expect(planUserPrompt({ ...context, edit: true })).toMatchSnapshot('plan user, edit');
    expect(siteSystemPrompt('es')).toMatchSnapshot('site system es');
    expect(siteSystemPrompt('pt')).toMatchSnapshot('site system pt');
    expect(writeUserPrompt({ ...context, media: { photos: [] } })).toMatchSnapshot('write user, no photos');
    expect(editUserPrompt('<!doctype html><p>x</p>', context)).toMatchSnapshot('edit user');
    expect(answersBlock(answers, [{ question: '¿Qué vendes?', answer: 'Pan' }], 'cambia el horario')).toMatchSnapshot('answers');
  });

  it('put the design guide first, so the cached prefix is the same for every site', () => {
    expect(siteSystemPrompt('es').startsWith(designGuide())).toBe(true);
    expect(designGuide()).toContain('The four jobs');
  });

  it('never send a contact detail to the model', () => {
    for (const text of [answersBlock(answers), planUserPrompt(context), writeUserPrompt(context)]) {
      expect(text).not.toContain('573001234567');
      expect(text).not.toContain('hola@luna.test');
    }
    expect(answersBlock(answers)).toContain('Calle 60 # 9-12'); // the address helps the copy; it is also checked by the guardrail
  });
});
