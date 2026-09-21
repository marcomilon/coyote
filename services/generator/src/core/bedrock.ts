import { ApplyGuardrailCommand, BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { DocumentType } from '@smithy/types';
import { z } from 'zod';

export interface Usage {
  step: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ToolRequest<S extends z.ZodType> {
  modelId: string;
  system: string;
  /** Text written by the requester. The only part of the prompt the guardrail evaluates. */
  guarded: string;
  /** Our own instructions and context (theme lists, the brief). Not evaluated by the guardrail. */
  user: string;
  maxTokens: number;
  tool: { name: string; description: string; schema: S };
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

let client: BedrockRuntimeClient | undefined;
const bedrock = () => (client ??= new BedrockRuntimeClient({ region: 'us-east-1', retryMode: 'adaptive' }));

/** One forced tool call through Bedrock Converse. Output is validated against the zod schema. */
export const callTool: CallTool = async ({ modelId, system, guarded, user, maxTokens, tool }) => {
  const guardrail = guardrailFromEnv();

  const { $schema: _, ...inputSchema } = z.toJSONSchema(tool.schema) as Record<string, unknown>;
  const response = await bedrock().send(
    new ConverseCommand({
      modelId,
      system: [{ text: system }],
      // With a guardContent block present, the guardrail evaluates only that block. Our own prompt text
      // names the banned categories and would otherwise trip the topic filters.
      messages: [
        {
          role: 'user',
          content: [guardrail ? { guardContent: { text: { text: guarded } } } : { text: guarded }, { text: user }],
        },
      ],
      guardrailConfig: guardrail
        ? { guardrailIdentifier: guardrail.id, guardrailVersion: guardrail.version, trace: 'disabled' }
        : undefined,
      inferenceConfig: { maxTokens },
      toolConfig: {
        tools: [{ toolSpec: { name: tool.name, description: tool.description, inputSchema: { json: inputSchema as DocumentType } } }],
        toolChoice: { tool: { name: tool.name } },
      },
    }),
  );

  const usage: Usage = {
    step: tool.name,
    modelId,
    inputTokens: response.usage?.inputTokens ?? 0,
    outputTokens: response.usage?.outputTokens ?? 0,
  };

  if (response.stopReason === 'guardrail_intervened') throw new GuardrailBlocked(usage);

  const toolUse = response.output?.message?.content?.find((block) => block.toolUse)?.toolUse;
  if (!toolUse) throw new ModelOutputError(`no tool call (stopReason: ${response.stopReason})`, usage);

  const parsed = tool.schema.safeParse(toolUse.input);
  if (!parsed.success) throw new ModelOutputError(z.prettifyError(parsed.error), usage);
  return { value: parsed.data, usage };
};

/**
 * Output check. The generated text sits in a toolUse block, which Converse guardrails may not evaluate,
 * so the visible text is checked explicitly. Resolves to true when the text may be published.
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
