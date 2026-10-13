---
title: Configuration
description: Environment variables, the server file, runtime settings and live reloads.
sidebar:
  order: 2
---

Two sources with a hard split:

- **Environment variables** for the runtime: paths, port, sign-in, check periods, theme.
- **One YAML file** for the servers. It holds `${VAR}` references, never secret values, so it can
  be committed.

Some runtime settings can also be changed from the Settings page. `Settings.get` resolves each one
in a fixed order: the environment wins and locks the setting in the UI, then the value saved in
`settings.json`, then the default. A saved choice that no longer exists falls back to the default,
so an upgrade that drops an option cannot stop the hub.

The server file is validated as a whole before anything is applied. `Hub.reload()` diffs the new
configuration against the running one: new servers start, removed ones stop, changed ones restart,
untouched ones keep running. A field that only affects display, such as `title`, does not count as
a change. A file that does not parse changes nothing.

When the UI or `yard-set_title` edits the file, `ConfigFile` goes through the YAML document model,
so comments, key order and `${VAR}` references survive, and the whole file must still parse before
it is written. The write happens in place because the file is often a single-file bind mount,
which cannot be replaced by a rename.
