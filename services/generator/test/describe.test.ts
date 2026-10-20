import { describe as group, expect, it } from 'vitest';
import { GuardrailBlocked, type CallTool } from '../src/core/bedrock';
import { DESCRIBE_PER_IP_PER_DAY, describe, inventedFacts, type DescribeDeps } from '../src/core/describe';

const usage = { step: 'describe', modelId: 'chat', inputTokens: 10, outputTokens: 5 };
const about = 'vendo tortas y pan de masa madre en cusco, abro de 7 a 19';

function deps(replies: { offers: boolean; about: string; missing?: string[] }[], overrides: Partial<DescribeDeps> = {}) {
  const seen: { guarded: string; user: string }[] = [];
  const callTool = (async ({ guarded, user }) => {
    seen.push({ guarded, user });
    const value = { missing: [], ...replies[Math.min(seen.length - 1, replies.length - 1)]! };
    return { value, usage };
  }) as CallTool;
  const counts = new Map<string, number>();
  const d: DescribeDeps = {
    stores: {
      hitRateLimit: async (key, max) => {
        counts.set(key, (counts.get(key) ?? 0) + 1);
        return counts.get(key)! <= max;
      },
    },
    callTool,
    modelId: 'chat',
    ipSalt: 'salt',
    outputAllowed: async () => true,
    now: () => Date.UTC(2026, 9, 18),
    ...overrides,
  };
  return { d, seen };
}

const better = 'Somos una panadería en Cusco: hacemos pan de masa madre y tortas. Abrimos de 7 a 19.';

group('describe', () => {
  it('returns the rewrite, with the owner text sent as data', async () => {
    const { d, seen } = deps([{ offers: true, about: better }]);
    const result = await describe({ businessName: 'Panadería Rosa', about, lang: 'es' }, '1.2.3.4', d);
    expect(result).toMatchObject({ status: 200, about: better });
    expect(seen[0]!.guarded).toContain('<answers>');
    expect(seen[0]!.guarded).toContain(about);
    expect(seen[0]!.guarded).toContain('Panadería Rosa');
  });

  it('returns the facts the owner could add, and the guardrail checks them with the text', async () => {
    const missing = ['Zonas de entrega', 'Precios de las tortas'];
    const checked: string[] = [];
    const { d } = deps([{ offers: true, about: better, missing: [' Zonas de entrega ', '', 'Precios de las tortas'] }], {
      outputAllowed: async (text) => (checked.push(text), true),
    });
    expect(await describe({ about }, 'ip', d)).toMatchObject({ status: 200, about: better, missing });
    expect(checked).toEqual([[better, ...missing].join('\n')]);
    const refused = deps([{ offers: true, about: better, missing }], { outputAllowed: async (text) => !text.includes('Precios') });
    expect((await describe({ about }, 'ip', refused.d)).status).toBe(422);
  });

  it('keeps the line breaks of the owner text on the way in and out', async () => {
    const lines = 'Panadería en Cusco.\n\nVendemos:\n- pan de masa madre\n- tortas';
    const rewrite = 'Somos una panadería en Cusco.\n\nVendemos:\n- pan de masa madre hecho a mano\n- tortas por encargo';
    const { d, seen } = deps([{ offers: true, about: rewrite }]);
    expect(await describe({ about: lines }, 'ip', d)).toMatchObject({ status: 200, about: rewrite });
    expect(seen[0]!.guarded).toContain(`What the business does:\n${lines}\n`);
  });

  it('turns away a too short text and our own example before any model call', async () => {
    const { d, seen } = deps([{ offers: true, about: better }]);
    expect((await describe({ about: 'pan' }, 'ip', d)).status).toBe(400);
    expect(await describe({ about: 'Panadería en Cusco: pan de masa madre y tortas por encargo' }, 'ip', d)).toMatchObject({ status: 422, unclear: true });
    expect(seen).toHaveLength(0);
  });

  it('says unclear when the text does not say what the business sells', async () => {
    const { d } = deps([{ offers: false, about: 'emprendimiento de Laura hola' }]);
    expect(await describe({ about: 'emprendimiento de Laura hola' }, 'ip', d)).toMatchObject({ status: 422, unclear: true });
  });

  it('asks again when the rewrite invents a number, then gives up', async () => {
    const invented = 'Panadería en Cusco con 20 años de historia: pan de masa madre y tortas, de 7 a 19.';
    const once = deps([{ offers: true, about: invented }, { offers: true, about: better }]);
    expect(await describe({ about }, 'ip', once.d)).toMatchObject({ status: 200, about: better });
    expect(once.seen[1]!.user).toContain('20');
    const always = deps([{ offers: true, about: invented }]);
    expect((await describe({ about }, 'ip', always.d)).status).toBe(502);
    expect(always.seen).toHaveLength(2);
  });

  it('refuses what the guardrail blocks, on the way in or out', async () => {
    const blocked = (async () => {
      throw new GuardrailBlocked(usage);
    }) as CallTool;
    expect((await describe({ about }, 'ip', deps([], { callTool: blocked }).d)).status).toBe(422);
    expect((await describe({ about }, 'ip', deps([{ offers: true, about: better }], { outputAllowed: async () => false }).d)).status).toBe(422);
  });

  it('checks the CAPTCHA, then counts tries per visitor per day', async () => {
    const { d } = deps([{ offers: true, about: better }], { verifyHuman: async (token) => (token === 'ok' ? 'ok' : 'bad') });
    expect((await describe({ about }, 'ip', d)).status).toBe(403);
    for (let i = 0; i < DESCRIBE_PER_IP_PER_DAY; i++) expect((await describe({ about, turnstileToken: 'ok' }, 'ip', d)).status).toBe(200);
    expect((await describe({ about, turnstileToken: 'ok' }, 'ip', d)).status).toBe(429);
    expect((await describe({ about, turnstileToken: 'ok' }, 'other ip', d)).status).toBe(200);
  });
});

group('inventedFacts', () => {
  it('finds numbers, emails and links the owner never wrote', () => {
    const own = 'pan en cusco, 7 a 19, pedidos a rosa@pan.pe';
    expect(inventedFacts(own, 'Abrimos de 7 a 19. Pedidos: rosa@pan.pe')).toEqual([]);
    expect(inventedFacts(own, 'Desde 1998, de 7 a 19. Escríbenos a info@pan.pe o visita www.pan.pe')).toEqual(['1998', 'info@pan.pe', 'www.pan.pe']);
    expect(inventedFacts('abrimos a las 17', 'Abrimos a las 7')).toEqual(['7']);
  });
});
