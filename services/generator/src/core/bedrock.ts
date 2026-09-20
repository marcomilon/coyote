import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
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

export type CallTool = <S extends z.ZodType>(request: ToolRequest<S>) => Promise<ToolResult<z.infer<S>>>;

let client: BedrockRuntimeClient | undefined;

/** One forced tool call through Bedrock Converse. Output is validated against the zod schema. */
export const callTool: CallTool = async ({ modelId, system, user, maxTokens, tool }) => {
  client ??= new BedrockRuntimeClient({ region: 'us-east-1', retryMode: 'adaptive' });

  const { $schema: _, ...inputSchema } = z.toJSONSchema(tool.schema) as Record<string, unknown>;
  const response = await client.send(
    new ConverseCommand({
      modelId,
      system: [{ text: system }],
      messages: [{ role: 'user', content: [{ text: user }] }],
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

  const toolUse = response.output?.message?.content?.find((block) => block.toolUse)?.toolUse;
  if (!toolUse) throw new ModelOutputError(`no tool call (stopReason: ${response.stopReason})`, usage);

  const parsed = tool.schema.safeParse(toolUse.input);
  if (!parsed.success) throw new ModelOutputError(z.prettifyError(parsed.error), usage);
  return { value: parsed.data, usage };
};
