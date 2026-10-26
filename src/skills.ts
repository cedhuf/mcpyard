import { SkillsExtension, type Skill, type SkillCatalog, type SkillCatalogChanges, type SkillFiles } from '@modelcontextprotocol/server/ext/skills';
import { nodeSkillFiles } from '@modelcontextprotocol/server/ext/skills/node';
import { mkdirSync } from 'node:fs';
import { note } from './logs.ts';

const SCHEME = 'skill://';

/** Skills added in the hub, kept as `<root>/<server>/<skill>/SKILL.md` and served as `skill://<server>/<skill>/…`. */
export class Skills {
  private readonly catalog: SkillCatalog;
  private readonly files: SkillFiles;

  private constructor(catalog: SkillCatalog, files: SkillFiles) {
    this.catalog = catalog;
    this.files = files;
  }

  static async load(root: string): Promise<Skills> {
    mkdirSync(root, { recursive: true });
    const files = nodeSkillFiles(root);
    const catalog = await SkillsExtension.load(files, { onWarning: (w) => note(`skill ${w.path}: ${w.message}`, { error: true }) });
    return new Skills(catalog, files);
  }

  /** Every skill on disk, whatever its server; a skill outside a server folder is never served. */
  get entries(): readonly Skill[] {
    return this.catalog.entries.filter((skill) => serverOf(skill) !== undefined);
  }

  reload(): Promise<SkillCatalogChanges> {
    return this.catalog.reload();
  }

  /** The extension for one connection: only the skills of the servers `sees` accepts. */
  extension(sees: (server: string) => boolean): SkillsExtension {
    const visible = () => this.entries.filter((skill) => sees(serverOf(skill)!));
    return new SkillsExtension({
      source: {
        list: async () => ({ skills: visible() }),
        get: async (uri) => visible().find((skill) => skill.uri === uri),
        read: async (uri) => {
          if (!visible().some((skill) => Array.isArray(skill.resources) && skill.resources.some((file) => file.uri === uri))) return undefined;
          const bytes = await this.files.read(uri.slice(SCHEME.length).split('/').map(decodeURIComponent).join('/'));
          const mimeType = /\.(md|markdown)$/i.test(uri) ? 'text/markdown' : undefined;
          try {
            return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), mimeType };
          } catch {
            return { bytes, mimeType };
          }
        },
      },
    });
  }
}

/** The server a skill belongs to: the first folder, for a skill exactly one level below it. */
export function serverOf(skill: Skill): string | undefined {
  const path = skill.uri.slice(SCHEME.length).split('/');
  return skill.uri.startsWith(SCHEME) && path.length === 3 ? decodeURIComponent(path[0]!) : undefined;
}
