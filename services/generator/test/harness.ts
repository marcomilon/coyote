import type { AnswersDeps } from '../src/core/clarify';
import type { GenerateJobDeps } from '../src/core/generate-job';
import type { OwnerDeps } from '../src/core/owner';
import type { SubmitDeps } from '../src/core/submit';
import { createUrls } from '../src/core/urls';
import { fakeModel } from './fixtures';
import { memoryStores } from './memory-stores';

export const NOW = 1_800_000_000_000;
export const urls = createUrls({ mode: 'domainless', appBaseUrl: 'https://app.test', apiBaseUrl: 'https://api.test', sitesBaseUrl: 'https://sites.test' });
export const body = { businessName: 'Panadería Luna', about: 'Panadería de masa madre en Chapinero, Bogotá.', whatsapp: '+57 300 123 4567', address: 'Calle 60 # 9-12' };

/** In-memory stores, a scripted model, and the deps of every flow, wired together. */
export function harness(model: Parameters<typeof fakeModel>[0] = {}) {
  const memory = memoryStores();
  const fake = fakeModel(model);
  const started: string[] = [];
  let id = 0;
  let draft = 0;
  const base = {
    stores: memory.stores,
    now: () => NOW,
    newId: () => `job-${++id}`,
    newDraftId: () => `draft${++draft}`,
    startGenerate: async (jobId: string) => void started.push(jobId),
  };
  const submitDeps: SubmitDeps = { ...base, callTool: fake.callTool, modelId: 'prescreen', rateLimitPerDay: 3, ipSalt: 'salt' };
  const generateDeps: GenerateJobDeps = {
    ...base,
    callTool: fake.callTool,
    callText: fake.callText,
    modelId: 'writer',
    prescreenModelId: 'prescreen',
    urls,
    outputAllowed: async () => true,
    moderate: async () => [],
  };
  const answersDeps: AnswersDeps = { ...base, callTool: fake.callTool, prescreenModelId: 'prescreen' };
  const ownerDeps: OwnerDeps = { ...base, urls, outputAllowed: async () => true };
  return { ...memory, ...fake, started, submitDeps, generateDeps, answersDeps, ownerDeps };
}
