import { describe, expect, it } from 'vitest';
import { emitMetrics } from '../src/core/metrics';
import { republish } from '../src/core/owner';
import { QUARANTINE_AFTER, reportSite } from '../src/core/report';
import { memoryStores } from './memory-stores';

function setup() {
  const memory = memoryStores();
  const sent: string[] = [];
  memory.sites.set('sitio-malo', { slug: 'sitio-malo', status: 'published', jobId: 'j1', createdAt: 1 });
  memory.objects.set('sitio-malo/index.html', '<html>');
  const deps = { stores: memory.stores, ipSalt: 's', notify: async (subject: string) => void sent.push(subject), now: () => 1_800_000_000_000 };
  return { ...memory, sent, deps };
}

describe('reportSite', () => {
  it('counts one report per visitor, so one person cannot take a site down', async () => {
    const t = setup();
    for (let i = 0; i < 5; i++) expect(await reportSite('sitio-malo', 'spam', '1.1.1.1', t.deps)).toMatchObject({ status: 202, quarantined: false });
    expect(t.sent).toHaveLength(1);
    expect(t.objects.has('sitio-malo/index.html')).toBe(true);
  });

  it(`quarantines after ${QUARANTINE_AFTER} distinct visitors and notifies the admin each time`, async () => {
    const t = setup();
    await reportSite('sitio-malo', 'estafa', '1.1.1.1', t.deps);
    await reportSite('sitio-malo', 'estafa', '2.2.2.2', t.deps);
    expect(await reportSite('sitio-malo', 'estafa', '3.3.3.3', t.deps)).toEqual({ status: 202, counted: true, quarantined: true });
    expect(t.objects.has('sitio-malo/index.html')).toBe(false);
    expect(t.objects.has('_quarantine/sitio-malo/index.html')).toBe(true);
    expect(t.sites.get('sitio-malo')!.status).toBe('quarantined');
    expect(t.invalidated).toContain('sitio-malo');
    expect(t.sent).toHaveLength(3);
    expect(t.sent[2]).toContain('quarantined');
    // The owner cannot put a quarantined site back online.
    expect(await republish({ ...t.sites.get('sitio-malo')!, content: {} as never, brief: {} as never }, { stores: t.stores } as never)).toEqual({ status: 409 });
  });

  it('ignores unknown and unpublished sites, and caps reports per visitor per day', async () => {
    const t = setup();
    expect(await reportSite('no-existe', '', '1.1.1.1', t.deps)).toEqual({ status: 404 });
    for (let i = 0; i < 10; i++) await reportSite('sitio-malo', '', '9.9.9.9', t.deps);
    expect(await reportSite('sitio-malo', '', '9.9.9.9', t.deps)).toEqual({ status: 429 });
  });
});

describe('emitMetrics', () => {
  it('writes one CloudWatch EMF line', () => {
    const lines: string[] = [];
    emitMetrics({ Generated: 1, TokensIn: 5600 }, (line) => lines.push(line));
    const parsed = JSON.parse(lines[0]!);
    expect(parsed._aws.CloudWatchMetrics[0]).toMatchObject({ Namespace: 'Coyote', Metrics: [{ Name: 'Generated', Unit: 'Count' }, { Name: 'TokensIn', Unit: 'Count' }] });
    expect(parsed.TokensIn).toBe(5600);
    emitMetrics({}, (line) => lines.push(line));
    expect(lines).toHaveLength(1);
  });
});
