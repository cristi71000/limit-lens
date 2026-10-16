# limit-lens

A Claude Code mod that puts a small panel above the prompt box showing how much of your usage limits **this session** is using, and what the same work would have cost on each Claude model.

```
◆ Limits       5h            week             If all on     5h      week
This session   3%            0.6%             ○ Fable 5.1   11.1%   2.2%
Account        ██░░░░░░ 23%  ████░░░░ 40.6%   ● Opus 5.5    4.4%    0.9%
Resets in      2h 10m        3d 4h            ○ Sonnet 5.5  2.2%    0.4%
                                              ○ Haiku 5.5   0.1%    <0.1%

Models  ████████████   ● Opus 5.5 2 req   ○ Haiku 5.5 1 req
```

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install limit-lens --marketplace cristi71000/limit-lens
```

Answer `y` to add the marketplace, then press Enter to install for your user. From a shell instead:

```bash
claude plugin install limit-lens --marketplace cristi71000/limit-lens
```

In the Claude desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `cristi71000/limit-lens`, then **Add plugin**.

## What it shows

- **Limits** (on a Pro or Max subscription): your account's 5-hour and weekly usage with time to reset, and this session's share of each. A `┃` on each meter marks how much of the window has gone by: usage more than 5 points under it shows green, within 5 either way yellow, more than 5 over red. This session's share is the window's usage times this session's part of all the work your Claude Code sessions on this machine did in that window, so the sessions' figures add up to the account's. Usage from elsewhere (claude.ai, another device) cannot be placed, so it is shared out in the same proportions.
- **If all on**: the same work priced on the newest Opus, Sonnet, Haiku and Fable models, as a share of each limit window. On API billing, the panel shows dollar cost instead.
- **Models**: which models answered this session's requests, and how many each.

- **One line by default**: the panel shows each window's meter, this session's part and the forecast on a single line. The **⌄** in its top-right corner expands it to the tables above, and **⌃** collapses it again; **Details** (`d`) opens the side pane.
- **Forecast**: where each window is heading at its pace so far, either `limit in ~1h 20m` or `≈70% at reset`.
- **Details pane** (`/limits`, or **Details**): every local session's part of the 5-hour window, each project's part of the week, this session's prompt-cache hit rate and full re-reads (with what they cost over cache hits), and how full its context window is.

## Settings

In the plugin's settings (`/config` in a terminal session):

- **Start collapsed** (on): show the panel as one line until you expand it.
- **Show forecast** (on).
- **On-pace band** (5): how many points either side of the time marker still count as on pace (yellow).

Prices are read from Anthropic's [pricing page](https://platform.claude.com/docs/en/about-claude/pricing) and refreshed in the background, so new models are priced and compared as soon as they are listed. The panel refreshes every 10 seconds.

## Good to know

- Claude Code reports your account's limit usage only with each model response, in whole percentages. The account figures can trail the app's own usage panel by a point or two, and the panel says how old they are.
- The per-model comparison assumes your limits are drawn down in proportion to API prices. Anthropic does not publish how each model counts against them, so treat those figures as estimates.
- Nothing in the panel makes model calls or uses your limits.

## What it reads, runs and fetches

Everything stays on your machine. limit-lens sends no data anywhere: its one network request carries nothing from your machine or your sessions.

- **Claude Code's own figures**: this session's token usage, model and the limit readings Claude Code reports with each response.
- **Your local session logs**: the files under `~/.claude/projects/` (or `$CLAUDE_CONFIG_DIR/projects/`), read for each response's token counts and model, each session's title and the folder it ran in. This is how it splits the account's usage across your sessions and projects. Only those fields are kept, in memory; message text is never stored, shown or sent.
- **Two environment variables**: `HOME` and `CLAUDE_CONFIG_DIR`, read only to find the folder above. They are paths, not credentials, and are never sent anywhere.
- **One program, `tail`**: the only command it runs, always as `tail -c +N <log>`, where `<log>` is one of the session logs above and `N` the byte it stopped at last time. This reads only what each log gained since the last check (every 10 seconds) instead of the whole file. It runs nothing else and takes no commands from anywhere.
- **One web page, fetched**: a plain GET, with no body, parameters or credentials, of Anthropic's public pricing page `https://platform.claude.com/docs/en/about-claude/pricing.md`. It is fetched once every 12 hours, or every 30 minutes while a model you use is not yet priced, and only its "Model pricing" table is read. platform.claude.com is the only host the plugin contacts.
- **Stored on your machine**: the last prices it read, in the plugin's own store, so new sessions start priced.
- **The `/limits` command**: limit-lens adds `/limits` and answers it itself by opening its Details pane. It does not see or change any other command.

## Licence

MIT, see [LICENSE](LICENSE).

## Development

```bash
claude plugin validate .
claude plugin test .
```
