# agent-leftovers

**See every cloud resource your AI coding agent spun up, and the one command to turn each off.**

```
npx github:ApahSaroj/agent-leftovers
```

Needs Node 18+. Nothing to install; it runs and exits.

Claude Code and Codex happily run `gcloud compute instances create`, `wrangler d1 create`,
`fly launch` or `aws rds create-db-instance` while finishing your task, or call an MCP server's
`create_project` or `deploy` tool. Then the session ends,
and the GPU box keeps billing. People have found 250 GB disks nobody asked for, and
batch scripts the agent wrote that called a paid API directly with their key, running up
hundreds of dollars in a day.

`agent-leftovers` reads the session logs your agents already keep on your machine and tells you:

- **what the agent created and never deleted** (VMs, disks, databases, clusters, buckets, deploys, enabled APIs), through the shell **or through MCP servers**
- **what it already cleaned up**, and which creates failed, so you are not chasing ghosts
- **scripts it wrote and ran that call a paid AI API with your key**, including ones left running in the background
- **the exact teardown command** for each, with zone, region and resource group filled in

It is **read-only**. By default it runs nothing, calls no cloud API and sends nothing anywhere.
Add `--verify` and it asks your own cloud CLIs which leftovers still exist (read-only describe/list calls only).

## What it reads

| Agent | Where |
|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` (or `$CLAUDE_CONFIG_DIR`) |
| Codex CLI | `~/.codex/sessions/**` and `archived_sessions` (or `$CODEX_HOME`), including compressed `.jsonl.zst` on Node 22.15+ |

## What it knows how to spot (59 shell rules + MCP)

- **Google Cloud:** VMs (GPU flagged), disks, static IPs, Cloud SQL, GKE, Memorystore, Vertex AI deployments, Cloud Run, Cloud Functions, buckets, App Engine, enabled APIs
- **AWS:** EC2, EBS, Elastic IPs, NAT gateways, RDS, S3, Lambda, EKS/eksctl, ElastiCache, SageMaker endpoints, ECS, DynamoDB, CDK, SAM
- **Azure:** resource groups, VMs, AKS, App Service, Container Apps, Postgres/MySQL
- **Cloudflare:** Workers, D1, R2, KV, Queues, Pages
- **Others:** Terraform/OpenTofu, Pulumi, Serverless, Vercel, Netlify, Railway, Heroku (+ add-ons), Supabase, Fly.io (apps, Postgres, volumes, machines), Firebase, Modal, RunPod
- **MCP servers (new in 0.2):** create/deploy calls to Supabase, Neon, Vercel, Cloudflare, AWS, Google Cloud, Azure, Railway, Render, Netlify, Fly.io, DigitalOcean, Heroku, PlanetScale, Upstash, Pinecone, MongoDB Atlas, Turso, Firebase, Modal, RunPod, E2B, Koyeb and Convex MCP servers, matched to their delete calls. GitHub branches, Linear projects, issues, migrations and SQL queries are ignored because they don't bill.
- **Paid AI APIs in agent-written scripts:** OpenAI, Anthropic, Gemini/Vertex, Mistral, OpenRouter, Replicate, ElevenLabs

## Options

```
--days N        how far back to look (default 30)
--project TEXT  only sessions whose folder contains TEXT
--logs PATH     read this log file or folder instead (repeatable)
--all           also show cleaned-up items and failed creates
--verify        ask your cloud CLIs whether each leftover still exists (opt-in)
--script        print a teardown script, every line commented out
--json          machine-readable output
--no-color      plain text
```

Exit code is `1` when something is left running, so you can put it in a pre-commit hook or a daily cron.

## --verify

Logs say what the agent created. They can't say whether it is still there today. With `--verify`,
agent-leftovers runs a read-only check with the CLI you already have signed in
(`gcloud ... describe`, `aws ... describe-*`, `az group exists`, `wrangler d1 info`, `fly status`,
`heroku apps:info`, `supabase projects list`, `neonctl projects get`, `vercel inspect`, `doctl ... get`):

- **still exists**: shown with `[checked: still exists]`
- **gone**: moved out of the list (see it with `--all`)
- **couldn't confirm** (CLI not installed, not signed in, no permission): stays in the list with the reason

Safety: every check is matched against an allow-list of read verbs before it runs, it is run
without a shell, and a resource name with unusual characters is never passed to a command.
Each check times out after 20 seconds. Nothing is created, changed or deleted.

## Honest limits

- It sees the agent's **shell commands and MCP tool calls**. Resources made in a web console, or by a script the agent wrote and ran, are not in the log (the paid-API script check covers the most common case).
- MCP support is pattern-based: it recognises the servers above by name and create/delete verbs in the tool name. A custom MCP server with unusual tool names may be missed; open an issue with the tool name.
- Without `--verify` it does not know whether a resource is **still** running today. Something you deleted by hand will still show.
- `--verify` covers the common types (VMs, disks, SQL, GKE, Cloud Run, functions, buckets, APIs, EC2 by Name tag, S3, RDS, Lambda, DynamoDB, Azure resource groups, Fly, Heroku, D1, R2, and Supabase, Neon, Vercel and DigitalOcean via MCP). Others show "no check yet".
- Names built at runtime (`test-vm-$RANDOM`) are flagged with `<NAME>` for you to fill in.
- Always read a teardown command before running it. Bucket and resource-group deletes remove everything inside.

## Privacy

Everything happens on your machine. No telemetry, no dependencies. The only network traffic is
what your own cloud CLIs do when you pass `--verify`.

## License

MIT
