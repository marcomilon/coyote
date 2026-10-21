import { describe, expect, it } from 'vitest';
import { COUNTRIES } from '../src/core/phones';
import { BASE, LOCAL_PRICES, formatPrice as format } from '../src/core/prices';

/** Paddle's minimum charge per currency (GET /currencies `minimum_payment_amount`), in the lowest unit. */
const MINIMUM: Record<string, number> = { USD: 70, MXN: 1370, BRL: 400, ARS: 78_000, CLP: 800, COP: 298_000, PEN: 250 };

describe('local prices', () => {
  it('are for listed countries, above Paddle minimum charge', () => {
    for (const [country, prices] of Object.entries(LOCAL_PRICES)) {
      expect(COUNTRIES.some((c) => c.iso === country), country).toBe(true);
      expect(prices.plan, country).toBeGreaterThanOrEqual(MINIMUM[prices.currency]!);
      expect(prices.designs, country).toBeGreaterThanOrEqual(MINIMUM[prices.currency]!);
    }
    expect(BASE.designs).toBeGreaterThanOrEqual(MINIMUM.USD!);
  });

  it('are written the way each country writes them', () => {
    // Intl puts a no-break space between the symbol and the amount.
    const formatPrice = (...args: Parameters<typeof format>) => format(...args).replace(/\u00a0/g, ' ');
    expect(formatPrice('plan', 'MX', 'es')).toBe('$179');
    expect(formatPrice('plan', 'BR', 'pt')).toBe('R$ 49,90');
    expect(formatPrice('designs', 'AR', 'es')).toBe('$ 7.499');
    expect(formatPrice('plan', 'CL', 'es')).toBe('$9.990');
    expect(formatPrice('plan', 'CO', 'es')).toBe('$ 31.900');
    expect(formatPrice('designs', 'PE', 'es')).toBe('S/ 16.90');
    expect(formatPrice('plan', 'UY', 'es')).toBe('US$ 9,99');
    expect(formatPrice('designs', '', 'es')).toBe('USD 4.99');
    expect(formatPrice('designs', '', 'pt')).toBe('US$ 4,99');
  });
});
