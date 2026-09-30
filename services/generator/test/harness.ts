import type { AccountDeps } from '../src/core/account';
import type { ChatDeps } from '../src/core/chat';
import type { Email } from '../src/core/mail';
import type { AnswersDeps } from '../src/core/clarify';
import type { GenerateJobDeps } from '../src/core/generate-job';
import type { OwnerDeps } from '../src/core/owner';
import type { SubmitDeps } from '../src/core/submit';
import { createUrls } from '../src/core/urls';
import { fakeModel, fakeWriter } from './fixtures';
import { memoryStores } from './memory-stores';

export const NOW = 1_800_000_000_000;
export const urls = createUrls({ mode: 'domainless', appBaseUrl: 'https://app.test', apiBaseUrl: 'https://api.test', sitesBaseUrl: 'https://sites.test' });
export const body = { businessName: 'Panadería Luna', about: 'Panadería de masa madre en Chapinero, Bogotá.', whatsapp: '+57 300 123 4567', address: 'Calle 60 # 9-12', ownerEmail: 'Luna@Example.com' };

/** In-memory stores, a scripted model, and the deps of every flow, wired together. */
export function harness(model: Parameters<typeof fakeModel>[0] = {}) {
  const memory = memoryStores();
  const fake = fakeModel(model);
  const writer = fakeWriter();
  const started: string[] = [];
  const chats: { slug: string; at: number }[] = [];
  const emails: Email[] = [];
  const sendEmail = async (email: Email) => void emails.push(email);
  let id = 0;
  let draft = 0;
  const base = {
    stores: memory.stores,
    now: () => NOW,
    newId: () => `job-${++id}`,
    newDraftId: () => `draft${++draft}`,
    startGenerate: async (jobId: string) => void started.push(jobId),
    startChat: async (slug: string, at: number) => void chats.push({ slug, at }),
  };
  const submitDeps: SubmitDeps = { ...base, callTool: fake.callTool, modelId: 'prescreen', rateLimitPerDay: 3, ipSalt: 'salt' };
  const generateDeps: GenerateJobDeps = {
    ...base,
    callTool: fake.callTool,
    modelId: 'writer',
    prescreenModelId: 'prescreen',
    urls,
    outputAllowed: async () => true,
    moderate: async () => [],
    writePage: writer.writePage,
    sendEmail,
  };
  const answersDeps: AnswersDeps = { ...base, callTool: fake.callTool, prescreenModelId: 'prescreen' };
  const ownerDeps: OwnerDeps = { ...base, urls, outputAllowed: async () => true };
  const chatDeps: ChatDeps = { ...base, urls, callTool: fake.callTool, modelId: 'chat', prescreenModelId: 'prescreen', outputAllowed: async () => true };
  const accountDeps: AccountDeps = { stores: memory.stores, urls, sendEmail, now: () => NOW, ipSalt: 'salt' };
  return { ...memory, ...fake, writer, started, chats, chatDeps, accountDeps, emails, submitDeps, generateDeps, answersDeps, ownerDeps };
}
