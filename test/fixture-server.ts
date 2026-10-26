import { McpServer } from '@modelcontextprotocol/server';
import { SkillsExtension, memorySkillFiles } from '@modelcontextprotocol/server/ext/skills';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const skillMd = (name: string) => `---\nname: ${name}\ndescription: The fixture's ${name}.\n---\n\nRead notes.md.\n`;
const skills = await SkillsExtension.load(
  memorySkillFiles({ 'guide/SKILL.md': skillMd('guide'), 'guide/notes.md': 'From upstream.\n', 'echo-well/SKILL.md': skillMd('echo-well') }),
);

serveStdio(() => {
  const server = new McpServer({ name: 'fixture', version: '1.0.0' });
  server.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
    content: [{ type: 'text', text }],
  }));
  server.registerTool('delete_all', {}, () => ({ content: [{ type: 'text', text: 'deleted' }] }));
  server.registerTool('env', {}, () => ({ content: [{ type: 'text', text: process.env.SECRET_FROM_HUB ?? 'unset' }] }));
  server.registerTool('version', {}, () => ({ content: [{ type: 'text', text: process.env.FIXTURE_VERSION ?? 'none' }] }));
  skills.attach(server);
  return server;
});
