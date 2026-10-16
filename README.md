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

Prices are read from Anthropic's [pricing page](https://platform.claude.com/docs/en/about-claude/pricing) and refreshed in the background, so new models are priced and compared as soon as they are listed. The panel refreshes every 10 seconds.

## Good to know

- Claude Code reports your account's limit usage only with each model response, in whole percentages. The account figures can trail the app's own usage panel by a point or two, and the panel says how old they are.
- The per-model comparison assumes your limits are drawn down in proportion to API prices. Anthropic does not publish how each model counts against them, so treat those figures as estimates.
- Nothing in the panel makes model calls or uses your limits. It reads Claude Code's own figures, the logs of your local sessions, and the public pricing page.

## Development

```bash
claude plugin validate .
claude plugin test .
```
