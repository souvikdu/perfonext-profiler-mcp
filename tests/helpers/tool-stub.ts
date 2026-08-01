// Minimal McpServer stub that captures registered tool handlers for direct invocation in tests.
type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;

export function createToolHandlerStub() {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _schema: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  };

  return {
    server: server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer,
    call: (name: string, args: Record<string, unknown>) => {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`Tool "${name}" was not registered`);
      return handler(args);
    },
  };
}
