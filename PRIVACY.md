# limit-lens privacy policy

limit-lens is a Claude Code plugin that runs entirely on your own computer. It collects no data about you, has no server of its own, and sends nothing anywhere.

## What it reads

- **Claude Code's own figures** for the current session: token usage, the model in use, and the usage-limit readings Claude Code reports with each response.
- **Your local Claude Code session logs** under `~/.claude/projects/` (or `$CLAUDE_CONFIG_DIR/projects/`). From them it takes each response's token counts and model, each session's title and the folder it ran in. It needs these to split your account's usage across your sessions and projects. Message text is not kept, shown or sent.
- **The `HOME` and `CLAUDE_CONFIG_DIR` environment variables**, only to find that folder.

## What it keeps

- What it reads from the logs stays in memory while the session runs and is gone when the session ends.
- The only thing it stores is the most recent model price table, kept in Claude Code's own plugin store on your computer so that new sessions start with prices.

## What it fetches

It fetches Anthropic's public pricing page, `https://platform.claude.com/docs/en/about-claude/pricing.md`, as a plain GET with no body, parameters, cookies or credentials. Nothing from your computer or your sessions is sent with it. This request goes to Anthropic, under [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy). limit-lens contacts no other host.

## What it shares

Nothing. There is no analytics, tracking, telemetry, or third party.

## Children

limit-lens is a developer tool. It is not meant for people under 18.

## Changes and contact

Changes to this policy are made in this file, and its history is in the [repository](https://github.com/cristi71000/limit-lens). To ask a question, open an issue at https://github.com/cristi71000/limit-lens/issues.
