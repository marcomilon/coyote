import {
  ApplyGuardrailCommand,
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  InvokeModelCommand,
  type ContentBlock,
  type SystemContentBlock,
  type TokenUsage,
} from '@aws-sdk/client-bedrock-runtime';
import type { DocumentType } from '@smithy/types';
import { z } from 'zod';
import type { GenerateImage } from './images';
import { IMAGE_MODEL_REGION, isClaude, supportsEffort } from './models';

export interface Usage {
  step: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type Effort = 'low' | 'medium' | 'high';

export interface ImageInput {
  /** Shown to the model right before the image, e.g. "Photo 1 ({{photo:1}})". */
  label: string;
  format: 'png' | 'jpeg';
  bytes: Uint8Array;
}

export interface ToolRequest<S extends z.ZodType> {
  modelId: string;
  /** Stable text first: Claude models cache the system prompt. */
  system: string;
  /** Text written by the requester. The only part of the prompt the guardrail evaluates. */
  guarded: string;
  /** Our own instructions and context. Not evaluated by the guardrail. */
  user: string;
  maxTokens: number;
  tool: { name: string; description: string; schema: S };
  /** Claude only. Opus 5.5 always thinks; effort sets how much (its default is medium). */
  effort?: Effort;
  /** Stream the response: for long outputs (a whole page) that would otherwise hit request timeouts. */
  stream?: boolean;
  /** Uploaded images, sent next to the guarded text. Already moderated by Rekognition. */
  images?: ImageInput[];
}

export interface ToolResult<T> {
  value: T;
  usage: Usage;
}

/** The model answered, but not with valid tool input. `issues` is safe to feed back to the model. */
export class ModelOutputError extends Error {
  constructor(
    readonly issues: string,
    readonly usage: Usage,
  ) {
    super(`Invalid model output: ${issues}`);
  }
}

/** The Bedrock Guardrail blocked the request or the generated text. */
export class GuardrailBlocked extends Error {
  constructor(readonly usage?: Usage) {
    super('Blocked by the guardrail');
  }
}

export interface GuardrailRef {
  id: string;
  version: string;
}

/** Set by the CDK stack on the Lambdas. Local scripts run without a guardrail unless these are set. */
export function guardrailFromEnv(env: Record<string, string | undefined> = process.env): GuardrailRef | undefined {
  return env.GUARDRAIL_ID && env.GUARDRAIL_VERSION ? { id: env.GUARDRAIL_ID, version: env.GUARDRAIL_VERSION } : undefined;
}

export type CallTool = <S extends z.ZodType>(request: ToolRequest<S>) => Promise<ToolResult<z.infer<S>>>;

/** A Converse request, with the step name used in the usage records. */
type TextRequest = Omit<ToolRequest<z.ZodType>, 'tool'> & { step: string };

let client: BedrockRuntimeClient | undefined;
const bedrock = () => (client ??= new BedrockRuntimeClient({ region: 'us-east-1', retryMode: 'adaptive' }));

const toUsage = (step: string, modelId: string, usage: TokenUsage | undefined): Usage => ({
  step,
  modelId,
  inputTokens: usage?.inputTokens ?? 0,
  outputTokens: usage?.outputTokens ?? 0,
  ...(usage?.cacheReadInputTokens ? { cacheReadTokens: usage.cacheReadInputTokens } : {}),
  ...(usage?.cacheWriteInputTokens ? { cacheWriteTokens: usage.cacheWriteInputTokens } : {}),
});

interface Converse {
  stopReason?: string;
  text: string;
  toolInput?: unknown;
  usage: Usage;
}

/** One Converse (or ConverseStream) request with a tool the model may call. */
async function converse(request: TextRequest, tool?: ToolRequest<z.ZodType>['tool']): Promise<Converse> {
  const { modelId, system, guarded, user, maxTokens, effort, stream, images } = request;
  const step = tool?.name ?? request.step;
  const guardrail = guardrailFromEnv();
  const claude = isClaude(modelId);

  const systemBlocks: SystemContentBlock[] = claude ? [{ text: system }, { cachePoint: { type: 'default' } }] : [{ text: system }];
  // With a guardContent block present, the guardrail evaluates only that block. Our own prompt text
  // names the banned categories and would otherwise trip the topic filters.
  const content: ContentBlock[] = [
    guardrail ? { guardContent: { text: { text: guarded } } } : { text: guarded },
    ...(images ?? []).flatMap((image): ContentBlock[] => [{ text: image.label }, { image: { format: image.format, source: { bytes: image.bytes } } }]),
    { text: user },
  ];
  let toolConfig;
  if (tool) {
    const { $schema: _, ...inputSchema } = z.toJSONSchema(tool.schema) as Record<string, unknown>;
    toolConfig = {
      tools: [{ toolSpec: { name: tool.name, description: tool.description, inputSchema: { json: inputSchema as DocumentType } } }],
      toolChoice: claude ? { auto: {} } : { tool: { name: tool.name } },
    };
  }
  const input = {
    modelId,
    system: systemBlocks,
    messages: [{ role: 'user' as const, content }],
    inferenceConfig: { maxTokens },
    toolConfig,
    // Anthropic request fields pass through to the model. Effort lives in output_config.
    additionalModelRequestFields: effort && supportsEffort(modelId) ? ({ output_config: { effort } } as DocumentType) : undefined,
  };

  if (stream) {
    const response = await bedrock().send(
      new ConverseStreamCommand({
        ...input,
        guardrailConfig: guardrail
          ? { guardrailIdentifier: guardrail.id, guardrailVersion: guardrail.version, trace: 'disabled', streamProcessingMode: 'sync' }
          : undefined,
      }),
    );
    let toolBlock: number | undefined;
    let json = '';
    let text = '';
    let stopReason: string | undefined;
    let tokens: TokenUsage | undefined;
    for await (const event of response.stream ?? []) {
      if (tool && event.contentBlockStart?.start?.toolUse?.name === tool.name && toolBlock === undefined) toolBlock = event.contentBlockStart.contentBlockIndex;
      const delta = event.contentBlockDelta;
      if (delta?.delta?.toolUse && delta.contentBlockIndex === toolBlock) json += delta.delta.toolUse.input ?? '';
      if (delta?.delta?.text) text += delta.delta.text;
      if (event.messageStop) stopReason = event.messageStop.stopReason;
      if (event.metadata) tokens = event.metadata.usage;
    }
    const usage = toUsage(step, modelId, tokens);
    let toolInput: unknown;
    if (toolBlock !== undefined) {
      try {
        toolInput = JSON.parse(json || '{}');
      } catch {
        throw new ModelOutputError(`the tool input was not valid JSON (stopReason: ${stopReason})`, usage);
      }
    }
    return { stopReason, text, toolInput, usage };
  }

  const response = await bedrock().send(
    new ConverseCommand({
      ...input,
      guardrailConfig: guardrail ? { guardrailIdentifier: guardrail.id, guardrailVersion: guardrail.version, trace: 'disabled' } : undefined,
    }),
  );
  const blocks = response.output?.message?.content ?? [];
  return {
    stopReason: response.stopReason,
    text: blocks.map((block) => block.text ?? '').join(''),
    toolInput: tool ? blocks.find((block) => block.toolUse?.name === tool.name)?.toolUse?.input : undefined,
    usage: toUsage(step, modelId, response.usage),
  };
}

/**
 * One tool call. Output is validated against the zod schema. Claude models get `toolChoice: auto`
 * (Opus 5.5 rejects a forced tool with a 400) and the prompt names the tool; a reply without the tool call
 * is a ModelOutputError, which callWithRetry retries once.
 */
export const callTool: CallTool = async (request) => {
  const { tool } = request;
  const { stopReason, toolInput, usage } = await converse({ ...request, step: tool.name }, tool);
  if (stopReason === 'guardrail_intervened') throw new GuardrailBlocked(usage);
  if (toolInput === undefined) throw new ModelOutputError(`no ${tool.name} tool call (stopReason: ${stopReason}). Reply by calling ${tool.name}.`, usage);
  if (stopReason === 'max_tokens') throw new ModelOutputError('the output was cut off at the token limit. Make it shorter.', usage);

  const parsed = tool.schema.safeParse(toolInput);
  if (!parsed.success) throw new ModelOutputError(z.prettifyError(parsed.error), usage);
  return { value: parsed.data, usage };
};

/** One retry, with the validation errors as feedback. */
export async function callWithRetry<S extends z.ZodType>(callTool: CallTool, usage: Usage[], request: ToolRequest<S>): Promise<z.infer<S>> {
  try {
    const result = await callTool(request);
    usage.push(result.usage);
    return result.value;
  } catch (error) {
    if (!(error instanceof ModelOutputError)) throw error;
    usage.push(error.usage);
    const retry = await callTool({
      ...request,
      user: `${request.user}\n\nYour previous tool call was rejected. Fix these problems and call the tool again:\n${error.issues}`,
    });
    usage.push(retry.usage);
    return retry.value;
  }
}

/**
 * Output check. The generated text sits in a toolUse block, which Converse guardrails may not evaluate,
 * so the visible text is checked explicitly. Resolves to true when the text may be shown.
 */
export async function outputAllowed(text: string, guardrail = guardrailFromEnv()): Promise<boolean> {
  if (!guardrail) return true;
  const response = await bedrock().send(
    new ApplyGuardrailCommand({
      guardrailIdentifier: guardrail.id,
      guardrailVersion: guardrail.version,
      source: 'OUTPUT',
      content: [{ text: { text } }],
    }),
  );
  return response.action !== 'GUARDRAIL_INTERVENED';
}

let imageClient: BedrockRuntimeClient | undefined;

/** Stability text-to-image through Bedrock (us-west-2). Resolves to undefined when the model filtered the request. */
export function stabilityImage(modelId: string): GenerateImage {
  return async (prompt, negativePrompt) => {
    imageClient ??= new BedrockRuntimeClient({ region: IMAGE_MODEL_REGION, retryMode: 'adaptive' });
    const response = await imageClient.send(
      new InvokeModelCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({ prompt, negative_prompt: negativePrompt, aspect_ratio: '16:9', output_format: 'jpeg' }),
      }),
    );
    const { images, finish_reasons } = JSON.parse(new TextDecoder().decode(response.body)) as { images?: string[]; finish_reasons?: (string | null)[] };
    if (!images?.[0] || finish_reasons?.[0]) return undefined;
    return Buffer.from(images[0], 'base64');
  };
}
