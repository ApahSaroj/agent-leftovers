# agent-leftovers: Product Hunt launch kit

## Listing
- **Name:** agent-leftovers
- **Tagline (60 max):** Find the cloud bills your AI coding agent left running
- **Description (260 max):** Claude Code and Codex create VMs, databases and deploys mid-task, then forget them. agent-leftovers reads the logs they already keep on your machine and lists every leftover with the exact command to turn it off. Read-only, local, free.
- **Topics:** Developer Tools, Artificial Intelligence, Open Source, Command Line Tools
- **Pricing:** Free (open source, MIT)
- **Link:** the GitHub repo (README shows `npx agent-leftovers` first)

## Gallery (1270 x 760)
1. Terminal screenshot (docs-screenshot.png): "6 things your agent created and never turned off"
2. Before/after: a scary billing line ("$453 in one day") next to `npx agent-leftovers`
3. The supported list: GCP, AWS, Azure, Cloudflare, Vercel, Fly, Supabase, Heroku, Terraform, plus paid AI APIs
4. "Read-only. No network. No telemetry." trust card
5. 20-second GIF: run, scroll the list, copy a teardown command

## Maker's first comment
Hi Product Hunt!

I kept reading the same story: someone lets Claude Code or Codex finish a task, and a week later finds a GPU VM, a 250 GB disk or a batch script hammering a paid API with their key. The agent made it; nobody remembered it.

Your agent already writes down every command it runs in local session logs. agent-leftovers reads them and answers one question: what did my agent create that is still out there, and how do I turn it off?

- 59 rules across GCP, AWS, Azure, Cloudflare, Vercel, Fly, Supabase, Heroku, Terraform and more
- Skips what the agent already deleted and creates that failed
- Flags scripts the agent wrote that call OpenAI, Anthropic or Gemini with your key, including ones left running in the background
- Read-only and fully local: it runs nothing and sends nothing

Honest limit: it only sees the agent's shell. Things made through MCP tools or a web console won't show.

What should I add next: live "is it still running?" checks, or support for Cursor and Gemini CLI?

## Launch plan
- **Day:** Saturday 7 Nov 2026 (Saturdays average about 10.7 launches against 30.4 on Tuesdays). Product Hunt days start 12:01 am Pacific, which is 1:31 pm IST on Saturday.
- **Before launch day:** repo public, npm package live, run `npx agent-leftovers` on a clean machine, schedule the launch, prepare gallery images.
- **Same day:** post in r/ClaudeAI, r/codex, r/aws, r/googlecloud, r/devops, Hacker News (Show HN) and X. Reply to every comment within the hour.
- **Traffic:** send people to the README's install line, not a landing page.

## Money (honest)
- v0.1 is free. That's what wins votes and trust for a dev CLI.
- Paid tier to test with a waitlist link in the README: **Pro, $29 lifetime**. Live "still running?" checks through each provider's read-only list APIs, an estimated monthly cost per leftover, and a weekly scan with an email alert.
- Build Pro only if 50+ people join the waitlist in the first two weeks.
