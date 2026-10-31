# agent-leftovers

**See every cloud resource your AI coding agent spun up, and the one command to turn each off.**

```
npx github:ApahSaroj/agent-leftovers
```

Needs Node 18+. Nothing to install; it runs and exits.

Claude Code and Codex happily run `gcloud compute instances create`, `wrangler d1 create`,
`fly launch` or `aws rds create-db-instance` while finishing your task. Then the session ends,
and the GPU box keeps billing. People have found 250 GB disks nobody asked for, and
batch scripts the agent wrote that called a paid API directly with their key, running up
hundreds of dollars in a day.

`agent-leftovers` reads the session logs your agents already keep on your machine and tells you:

- **what the agent created and never deleted** (VMs, disks, databases, clusters, buckets, deploys, enabled APIs)
- **what it already cleaned up**, and which creates failed, so you are not chasing ghosts
- **scripts it wrote and ran that call a paid AI API with your key**, including ones left running in the background
- **the exact teardown command** for each, with zone, region and resource group filled in

It is **read-only**. It runs nothing, calls no cloud API and sends nothing anywhere.

## What it reads

| Agent | Where |
|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` (or `$CLAUDE_CONFIG_DIR`) |
| Codex CLI | `~/.codex/sessions/**` and `archived_sessions` (or `$CODEX_HOME`), including compressed `.jsonl.zst` on Node 22.15+ |

## What it knows how to spot (59 rules)

- **Google Cloud:** VMs (GPU flagged), disks, static IPs, Cloud SQL, GKE, Memorystore, Vertex AI deployments, Cloud Run, Cloud Functions, buckets, App Engine, enabled APIs
- **AWS:** EC2, EBS, Elastic IPs, NAT gateways, RDS, S3, Lambda, EKS/eksctl, ElastiCache, SageMaker endpoints, ECS, DynamoDB, CDK, SAM
- **Azure:** resource groups, VMs, AKS, App Service, Container Apps, Postgres/MySQL
- **Cloudflare:** Workers, D1, R2, KV, Queues, Pages
- **Others:** Terraform/OpenTofu, Pulumi, Serverless, Vercel, Netlify, Railway, Heroku (+ add-ons), Supabase, Fly.io (apps, Postgres, volumes, machines), Firebase, Modal, RunPod
- **Paid AI APIs in agent-written scripts:** OpenAI, Anthropic, Gemini/Vertex, Mistral, OpenRouter, Replicate, ElevenLabs

## Options

```
--days N        how far back to look (default 30)
--project TEXT  only sessions whose folder contains TEXT
--logs PATH     read this log file or folder instead (repeatable)
--all           also show cleaned-up items and failed creates
--script        print a teardown script, every line commented out
--json          machine-readable output
--no-color      plain text
```

Exit code is `1` when something is left running, so you can put it in a pre-commit hook or a daily cron.

## Honest limits

- It only sees what went through the agent's **shell**. Resources made through MCP tools, a web console, or by a script the agent ran are not in the log (the paid-API script check covers the most common case).
- It does not check whether a resource is **still** running today. Something you deleted by hand will still show. Run the provider's list command if unsure.
- Names built at runtime (`test-vm-$RANDOM`) are flagged with `<NAME>` for you to fill in.
- Always read a teardown command before running it. Bucket and resource-group deletes remove everything inside.

## Privacy

Everything happens on your machine. No network calls, no telemetry, no dependencies.

## License

MIT
