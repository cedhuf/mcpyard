---
title: Skills
---

A skill is a set of instructions for an agent: how to use a server well, which traps to avoid,
which workflow to follow. MCP Yard serves skills through the official
[Skills extension](https://modelcontextprotocol.io/extensions/skills/overview) of MCP, so a client
that supports it discovers them by name and description and loads the full text only when it needs
it.

## Adding a skill

Every skill belongs to a server. Open the server in the web UI, then its **Skills** tab, and click
**Add skill**: a name, a description and the instructions in Markdown. Clients see it at once and
nothing restarts. The same tab edits and deletes the skills added there.

The web UI writes to the data directory, where you can also put a skill by hand, in a folder
named after the server and then after the skill:

```text
$MCPYARD_DATA_DIR/skills/
  mail/
    triage/
      SKILL.md
      references/
        folders.md
```

`SKILL.md` follows the [Agent Skills](https://agentskills.io/specification) format: YAML
frontmatter with `name` and `description`, then the instructions in Markdown. The `name` must match
the skill's folder.

```markdown
---
name: triage
description: Sort the inbox. Use for inbox-zero passes, cleaning up spam, or moving mail between folders.
---

Archive newsletters older than a week. Read `references/folders.md` for the folder layout.
```

The description is what the agent reads to decide whether to load the skill: say what it covers
and when to use it. Files next to `SKILL.md` are served too, and the agent reads them on demand.

A skill put there by hand is read at startup and on every [reload](configuration.html#reloading). A skill
with a problem (no frontmatter, a name that does not match its folder) is left out and the reason
goes to the logs.

## Skills from servers

A server that serves skills itself keeps them behind the hub: they are listed with the hub's own,
under `skill://<server>/…`, and every read goes to that server. Its digests pass through
unchanged, so the client still checks each file against what the server published. The list is
read when the server connects and again when it announces a change.

When a skill added in the hub has the same address as one the server serves, the hub's wins and
the logs say so. A server skill whose address is not a `skill://` URI is left out.

## Who sees a skill

A key that sees a server sees its skills, as `skill://<server>/<skill>/SKILL.md`. A server that is
switched off or missing from the server file takes its skills along. The key's tool filter does
not apply to skills.
