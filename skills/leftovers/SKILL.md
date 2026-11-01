---
name: leftovers
description: Lists cloud resources, Kubernetes load balancers, Docker containers, tunnels and background processes that AI coding agents (Claude Code, Codex, Gemini CLI, Copilot CLI) created in past sessions and never turned off, with a teardown command for each and a rough cost so far. Use when the user asks what is still running, worries about a surprise cloud bill, or wants to clean up after deploying or testing.
---

# agent-leftovers

Run the read-only scan. It reads local agent session logs only; nothing is sent anywhere.

```bash
npx -y github:ApahSaroj/agent-leftovers
```

Once the npm package is published, `npx -y agent-leftovers` works too.

Useful options:
- `--verify` asks the user's installed cloud CLIs (gcloud, aws, az, kubectl, helm, docker, ...) whether each item still exists, using read-only describe/list calls. Ask the user before adding it, since it uses their signed-in accounts.
- `--project TEXT` limits the scan to sessions in folders containing TEXT.
- `--days N` looks further back (default 30).
- `--expired` shows only items past their own `expires` / `ttl` tag; `--tag session=ID` shows one session's items.
- `--sweep` asks gcloud, aws and az (read-only list calls) for anything past its expiry tag, even if no log mentions it. Ask the user first; those resources may not be the agent's, so never suggest deleting them without the user checking who owns them.
- `--json` for structured output.

How to report back:
1. Lead with what still bills by the hour (GPU VMs first), then usage-billed items, then local ones.
2. Quote the cost estimate as an estimate.
3. For items marked as a deploy ("may pre-exist"), say clearly that the thing may have existed before the agent and must be checked before deleting.
4. Never run a teardown command yourself unless the user asks for that specific item. Show the command and let the user decide.
5. If the user says an item is meant to stay, suggest `npx -y github:ApahSaroj/agent-leftovers --baseline` or adding a line to `~/.agent-leftovers-ignore`.
