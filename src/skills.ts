import { SkillsExtension, type Skill, type SkillCatalog, type SkillCatalogChanges, type SkillFiles, type SkillReadResult } from '@modelcontextprotocol/server/ext/skills';
import { nodeSkillFiles } from '@modelcontextprotocol/server/ext/skills/node';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { readOnlyReason } from './config.ts';
import { note } from './logs.ts';

const SCHEME = 'skill://';

/** The skills one upstream server serves, under its own URIs, and how to read their files. */
export type Relay = { server: string; skills: readonly Skill[]; read: (uri: string) => Promise<SkillReadResult> };

/** A skill as clients see it; `own` when it was added in the hub rather than served by its server. */
export type Served = { server: string; skill: Skill; own: boolean; read: (uri: string) => Promise<SkillReadResult | undefined> };

/** The Agent Skills rule for names, which are also folder names. */
export const SKILL_NAME = /^(?=.{1,64}$)[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_DESCRIPTION = 1024;

const warned = new Set<string>();

/** Skills declared in the hub, kept as `<root>/<server>/<skill>/SKILL.md` and served as `skill://<server>/<skill>/…`. */
export class Skills {
  private readonly catalog: SkillCatalog;
  private readonly files: SkillFiles;
  private readonly root: string;

  private constructor(catalog: SkillCatalog, files: SkillFiles, root: string) {
    this.catalog = catalog;
    this.files = files;
    this.root = root;
  }

  /** A missing `root` is an empty catalog until something creates it. */
  static async load(root: string): Promise<Skills> {
    const disk = nodeSkillFiles(root);
    const files: SkillFiles = { list: async (dir) => (existsSync(root) ? disk.list(dir) : []), read: (path) => disk.read(path) };
    const catalog = await SkillsExtension.load(files, {
      // An empty folder is the normal state, not a problem.
      onWarning: (w) => !w.message.startsWith('no skills found') && note(`skill ${w.path}: ${w.message}`, { error: true }),
    });
    return new Skills(catalog, files, root);
  }

  /** Every skill on disk, whatever its server; a skill outside a server folder is never served. */
  get entries(): readonly Skill[] {
    return this.catalog.entries.filter((skill) => serverOf(skill) !== undefined);
  }

  reload(): Promise<SkillCatalogChanges> {
    return this.catalog.reload();
  }

  /** Why the web UI cannot write skills, or undefined when it can. */
  readOnlyReason(): string | undefined {
    return readOnlyReason(this.root, 'the skills folder');
  }

  /** The instructions of a hub skill: its `SKILL.md` without the frontmatter. */
  body(server: string, name: string): string | undefined {
    try {
      return readFileSync(join(this.root, server, name, 'SKILL.md'), 'utf8').replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
    } catch {
      return undefined;
    }
  }

  /** Writes a hub skill's `SKILL.md`, keeping its other frontmatter fields and files. Takes effect on the next reload. */
  write(server: string, name: string, description: string, body: string): void {
    if (!SKILL_NAME.test(name)) throw new Error('Name: lowercase letters, digits and single hyphens, up to 64 characters.');
    const current = this.entries.find((skill) => skill.uri === `${SCHEME}${server}/${name}/SKILL.md`);
    const dir = join(this.root, server, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\n${stringify({ ...current?.frontmatter, name, description })}---\n\n${body.trim()}\n`);
  }

  /** Deletes a hub skill's folder with every file in it. Takes effect on the next reload. */
  remove(server: string, name: string): void {
    if (!SKILL_NAME.test(name)) throw new Error(`no skill named ${name}`);
    rmSync(join(this.root, server, name), { recursive: true, force: true });
  }

  /**
   * The extension for one connection: the hub's skills, then those relayed from upstream servers under
   * `skill://<server>/`, keeping only the servers `sees` accepts.
   */
  extension(sees: (server: string) => boolean, relays: () => Iterable<Relay>): SkillsExtension {
    const visible = () => this.served(relays()).filter((s) => sees(s.server));
    const holding = (uri: string) => visible().find(({ skill }) => (Array.isArray(skill.resources) ? skill.resources.some((file) => file.uri === uri) : uri.startsWith(rootOf(skill))));
    return new SkillsExtension({
      source: {
        list: async () => ({ skills: visible().map((s) => s.skill) }),
        get: async (uri) => visible().find((s) => s.skill.uri === uri)?.skill,
        read: async (uri) => holding(uri)?.read(uri),
      },
    });
  }

  /** Every skill served, the hub's own first, whoever asks. */
  served(relays: Iterable<Relay>): Served[] {
    const served: Served[] = this.entries.map((skill) => ({ server: serverOf(skill)!, skill, own: true, read: (uri) => this.readFile(uri) }));
    const taken = new Set(served.map((s) => s.skill.uri));
    for (const relay of relays) {
      const prefix = `${SCHEME}${relay.server}/`;
      for (const original of relay.skills) {
        const skill = moved(original, prefix);
        if (!skill || taken.has(skill.uri)) {
          warnOnce(`${relay.server} ${original.uri}`, skill ? `skill ${skill.uri} from ${relay.server} is hidden by the hub's own` : `skill ${original.uri} from ${relay.server} is not a skill:// URI, ignored`);
          continue;
        }
        taken.add(skill.uri);
        served.push({ server: relay.server, skill, own: false, read: (uri) => relay.read(SCHEME + uri.slice(prefix.length)) });
      }
    }
    return served;
  }

  private async readFile(uri: string): Promise<SkillReadResult> {
    const bytes = await this.files.read(uri.slice(SCHEME.length).split('/').map(decodeURIComponent).join('/'));
    const mimeType = /\.(md|markdown)$/i.test(uri) ? 'text/markdown' : undefined;
    try {
      return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), mimeType };
    } catch {
      return { bytes, mimeType };
    }
  }
}

/** `skill` with every URI moved under `prefix`, or undefined when one is not a `skill://` URI. */
function moved(skill: Skill, prefix: string): Skill | undefined {
  const uris = [skill.uri, ...(Array.isArray(skill.resources) ? skill.resources.map((file) => file.uri) : [])];
  if (!uris.every((uri) => uri.startsWith(SCHEME))) return undefined;
  const move = (uri: string) => prefix + uri.slice(SCHEME.length);
  return { ...skill, uri: move(skill.uri), resources: Array.isArray(skill.resources) ? skill.resources.map((file) => ({ ...file, uri: move(file.uri) })) : skill.resources };
}

/** The folder URI of a skill, with its trailing slash. */
function rootOf(skill: Skill): string {
  return skill.uri.slice(0, skill.uri.lastIndexOf('/') + 1);
}

function warnOnce(id: string, message: string): void {
  if (warned.has(id)) return;
  warned.add(id);
  note(message, { error: true });
}

/** The server a skill belongs to: the first folder, for a skill exactly one level below it. */
export function serverOf(skill: Skill): string | undefined {
  const path = skill.uri.slice(SCHEME.length).split('/');
  return skill.uri.startsWith(SCHEME) && path.length === 3 ? decodeURIComponent(path[0]!) : undefined;
}
