import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { AppError } from './model';
import type { Env } from './env';
import { descriptions, execute, inputs, type ToolName } from './service';
export async function handleMcp(request: Request, env: Env) {
  const server = new McpServer({ name: 'canvas-note', version: '0.1.0' });
  for (const name of Object.keys(inputs) as ToolName[]) {
    server.registerTool(
      name,
      { description: descriptions[name], inputSchema: inputs[name] },
      async (args: unknown) => {
        try {
          const result = await execute(name, args, env, new URL(request.url).origin);
          if (name === 'render_frame')
            return {
              content: [
                { type: 'image' as const, ...(result as { data: string; mimeType: string }) },
              ],
            };
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        } catch (error) {
          const message =
            error instanceof z.ZodError
              ? error.message
              : error instanceof AppError
                ? error.message
                : 'Internal server error';
          return { isError: true, content: [{ type: 'text' as const, text: message }] };
        }
      },
    );
  }
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: 3_000_000,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
