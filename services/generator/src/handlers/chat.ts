import { snsAnnounce } from '../aws/notices';
import { pageTier } from '../aws/page-tier';
import { createStores, storeConfigFromEnv } from '../aws/stores';
import { callTool, outputAllowed } from '../core/bedrock';
import { runChatTurn } from '../core/chat';
import { emitMetrics } from '../core/metrics';
import { modelId, prescreenModelId } from '../core/models';
import { createUrls, urlConfigFromEnv } from '../core/urls';

const stores = createStores(storeConfigFromEnv());
const urls = createUrls(urlConfigFromEnv(process.env));
const announce = snsAnnounce(process.env.SITE_NOTICES_TOPIC_ARN);

// Invoked asynchronously with { slug, at } by POST /me/chat: writes one Coyote reply.
export const handler = async (event: { slug: string; at: number }): Promise<void> => {
  const result = await runChatTurn(event.slug, event.at, { stores, urls, callTool, modelId: modelId(), prescreenModelId: prescreenModelId(), outputAllowed, now: Date.now, announce, pageTier: () => pageTier() });
  if (result.outcome === 'SKIPPED') return;
  const tokensIn = result.usage.reduce((n, u) => n + u.inputTokens, 0);
  const tokensOut = result.usage.reduce((n, u) => n + u.outputTokens, 0);
  emitMetrics({ ChatReplied: 1, ...(result.outcome === 'EDITED' ? { ChatEdited: 1 } : {}), ...(result.outcome === 'FAILED' ? { ChatFailed: 1 } : {}), TokensIn: tokensIn, TokensOut: tokensOut });
};
