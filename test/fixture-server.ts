import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

serveStdio(() => {
  const server = new McpServer({ name: 'fixture', version: '1.0.0' });
  server.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
    content: [{ type: 'text', text }],
  }));
  server.registerTool('delete_all', {}, () => ({ content: [{ type: 'text', text: 'deleted' }] }));
  server.registerTool('env', {}, () => ({ content: [{ type: 'text', text: process.env.SECRET_FROM_HUB ?? 'unset' }] }));
  return server;
});
