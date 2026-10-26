---
title: Skills
---

A skill is a set of instructions for an agent: how to use a server well, which traps to avoid,
which workflow to follow. MCP Yard serves skills through the official
[Skills extension](https://modelcontextprotocol.io/extensions/skills/overview) of MCP, so a client
that supports it discovers them by name and description and loads the full text only when it needs
it.

## Adding a skill

Every skill belongs to a server. Put it in the data directory, in a folder named after the server
and then after the skill:

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

The hub reads the folder at startup and on every [reload](configuration.html#reloading). A skill
with a problem (no frontmatter, a name that does not match its folder) is left out and the reason
goes to the logs.

## Who sees a skill

A key that sees a server sees its skills, as `skill://<server>/<skill>/SKILL.md`. A server that is
switched off or missing from the server file takes its skills along. The key's tool filter does
not apply to skills.
