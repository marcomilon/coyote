import { describe, expect, it } from 'vitest';
import { tagsJs } from '../lib/tags';

describe('tagsJs', () => {
  it('is empty without a container', () => {
    expect(tagsJs(undefined)).not.toContain('googletagmanager');
  });

  it('denies consent by default, before GTM loads, and grants it only from a saved choice', () => {
    const js = tagsJs('GTM-58VB3VC3');
    expect(js).toContain('gtm.js?id=GTM-58VB3VC3');
    expect(js.indexOf("'default'")).toBeLessThan(js.indexOf("'update'"));
    expect(js.indexOf("'update'")).toBeLessThan(js.indexOf('gtm.js?id='));
    expect(js).toMatch(/'default', \{"ad_storage":"denied","ad_user_data":"denied","ad_personalization":"denied","analytics_storage":"denied"\}/);
    expect(js).toContain('localStorage.getItem("ventas314.consent") === \'granted\'');
  });

  it('loads no tags while a secret is in the address', () => {
    const pattern = /(^#|&)(token|login|job)=/;
    expect(tagsJs('GTM-58VB3VC3')).toContain(String(pattern));
    for (const hash of ['#token=abc', '#login=x', '#job=123', '#site=a&login=x']) expect(pattern.test(hash)).toBe(true);
    for (const hash of ['', '#sitio=panaderia', '#site=a']) expect(pattern.test(hash)).toBe(false);
  });

  it('rejects anything but a container id', () => {
    expect(() => tagsJs("GTM-1'+alert(1)+'")).toThrow();
  });

  it('runs: consent defaults first, then GTM after the page loads', () => {
    const dataLayer: unknown[] = [];
    const listeners: Record<string, () => void> = {};
    const appended: { src?: string }[] = [];
    const window = { dataLayer } as { dataLayer: unknown[]; COYOTE_TAGS?: boolean };
    const run = new Function('window', 'localStorage', 'addEventListener', 'location', 'document', tagsJs('GTM-58VB3VC3'));
    run(
      window,
      { getItem: () => 'granted' },
      (name: string, fn: () => void) => (listeners[name] = fn),
      { hash: '' },
      { createElement: () => ({}), head: { appendChild: (el: { src?: string }) => appended.push(el) } },
    );
    expect(window.COYOTE_TAGS).toBe(true);
    expect(dataLayer.map((e) => Array.from(e as ArrayLike<unknown>)[1])).toEqual(['default', 'update']);
    expect(appended).toHaveLength(0);
    listeners.load!();
    expect(appended[0]!.src).toBe('https://www.googletagmanager.com/gtm.js?id=GTM-58VB3VC3');
  });
});
