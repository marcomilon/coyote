import { z } from 'zod';

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'hex color like #a1b2c3');

/** Builds the `design_brief` schema for this request's candidate themes and font pairings. */
export function briefSchema(themes: [string, ...string[]], fontPairings: [string, ...string[]]) {
  return z.object({
    theme: z.enum(themes),
    palette: z
      .object({
        ink: hex.describe('Text color'),
        paper: hex.describe('Background color'),
        accent: hex.describe('One sharp accent'),
      })
      .describe('Derived from this business, not from the industry cliché'),
    fontPairing: z.enum(fontPairings),
    tone: z.string().trim().min(1).max(80).describe('Voice of the copy, a few words'),
    signatureElement: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .describe('The one memorable visual idea for this page'),
    headline: z.string().trim().min(1).max(80).describe('Max 6 words, never "Bienvenidos"'),
  });
}

export type Brief = z.infer<ReturnType<typeof briefSchema>>;
