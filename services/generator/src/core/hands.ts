import { z } from 'zod';
import type { CallTool, Usage } from './bedrock';

/**
 * The image model draws hands with six fingers, even with "extra fingers" in its negative prompt. The cheap model looks
 * at each made photo and says whether a hand in it is drawn wrong; such a photo is refused like one with writing.
 * Resolves to true for a bad hand. The check is about looks, not safety: when it fails, the photo is kept.
 */
export function handsChecker(callTool: CallTool, modelId: string, usage: Usage[]): (bytes: Uint8Array) => Promise<boolean> {
  const schema = z.object({ handsVisible: z.boolean(), handDrawnWrong: z.boolean() });
  return async (bytes) => {
    try {
      const result = await callTool({
        modelId,
        system: 'You check photos made by an image model for a small business website, before they go on the page.',
        guarded: 'A photo made for a small business website.',
        user: 'Look at every hand in the photo, even small ones in the background, and count the fingers of each. A hand is drawn wrong when it has more or fewer than five fingers, fingers fused or bent in impossible ways, or when a person has an extra or missing hand or arm. Call check_hands.',
        images: [{ label: 'The photo:', format: 'jpeg', bytes }],
        maxTokens: 300,
        tool: { name: 'check_hands', description: 'Record whether hands show in the photo and whether any is drawn wrong.', schema },
      });
      usage.push(result.usage);
      return result.value.handDrawnWrong;
    } catch (error) {
      console.error('hands check failed; keeping the photo', error);
      return false;
    }
  };
}
