# Changelog

## 0.4.0 (2026-10-31)

- Every teardown carries the account it was created in: gcloud --project, --account and --configuration (from flags, env, `gcloud config set`, `configurations activate`), aws --profile/--region, az --subscription. When the log never shows the account, the report says so and gives the check command (`gcloud config list`, `aws sts get-caller-identity`, `az account show`). Thanks @MankyRivet and @h2oilx.

Built from an outside code review of 0.3 and the first week of feedback. Every reproduced issue now has a test.
It also takes in the 0.3.1 work (orphans, expiry/session tags, `--sweep`), which was built on 0.3 and
never published on its own; it was reviewed and fixed before this merge.

**From 0.3.1: orphans, tags and --sweep** (idea from @AyCodeAI on X: "tag every resource they create
with a session ID and expiry, so cleanup becomes a filter instead of a hunt")
- **Orphans after a delete.** Google Cloud disks kept by `--keep-disks` or auto-delete off (a
  `--create-disk ...auto-delete=no` is reported as a data disk under its own name), the static IP a
  deleted VM used, AWS Elastic IPs after `terminate-instances`, volumes launched with
  `DeleteOnTermination=false` or attached later with `attach-volume`, and the OS disk, data disks,
  NIC and public IP that `az vm delete` leaves (the public IP always stays). Each gets a note.
  A delete clears one only on an exact name or ID match; an AWS terminate is matched by instance ID
  when the log holds `run-instances` output, and never counts against an instance launched after it.
- **Session and expiry tags.** Reads `gcloud --labels`, `aws --tag-specifications` / `--tags`,
  `az --tags`. Expired items go to the top. New `--expired` and `--tag KEY[=VALUE]` filters.
  Impossible dates (`2026-13-45`, `2026-02-30`, a bare year) are unreadable, never "expired".
- **`--sweep`.** Read-only list calls to gcloud, aws and az for anything past its expiry tag, even
  resources no agent log mentions. Output warns they may not be your agent's. Uses the same safe
  execution as `--verify` (CLI found on PATH, never the current folder; runs from the temp folder).
  Teardowns keep every prompt and a final RDS snapshot, never force-delete a bucket, quote odd
  names and IDs, and delete a Lambda function rather than its alias. A CLI that times out is
  skipped for the rest of the sweep; output over 64 MB is reported instead of shown as garbage.
  Scope limits (one AWS region, tagged only; active gcloud project; current az subscription) are
  printed and documented.
- `--verify` also checks kept boot disks and attached EBS volumes.
- **Output safety.** `--script` can never contain a live line, even if a name holds a newline;
  control characters (ANSI/OSC escapes) are stripped from every name in text, `--json`, `--script`
  and `--baseline`. Tag values that look like secrets are masked.

**Security and correctness of --verify**
- Names taken from logs can no longer become flags. A manifest named `--kubeconfig=...` or
  `kubectl expose --name=--x` is reported but never checked. Kubernetes names, namespaces and
  contexts must match Kubernetes' own naming rules.
- "Gone" now means a real not-found answer from that CLI. Offline, signed out, wrong context and
  permission errors are "couldn't check" and stay listed (0.3 could hide them and exit 0).
- Checks carry `--profile`, `--region` and `--project`. RDS clusters use `describe-db-clusters`.
- The CLI is found on PATH by agent-leftovers itself, never in the current folder (Windows `.cmd`
  in a cloned repo can't run), and checks run from the temp folder.
- New checks: Docker containers, Fly deploys.

**Safer teardowns**
- Deploys and applies are no longer treated as new things: Terraform/OpenTofu, Pulumi, CDK, SAM,
  Serverless, Netlify, Vercel, Wrangler, Fly, Cloud Run, Cloud Functions, Supabase functions, App Service
  and Container Apps get a look-first command and a note. Terraform: `state list`, then `destroy -target=`.
- No teardown skips a prompt (`--quiet`, `--yes`, `--force`, `--confirm` removed). RDS keeps a final
  snapshot. `az group create` says check first. Buckets use `buckets delete`, which refuses non-empty ones.
- Background scripts: `pgrep -af` to find the right process instead of `pkill -f`.

**Fewer false positives and misses**
- Global flags before the subcommand are understood (`aws --profile p lambda ...`,
  `gcloud --project p compute ...`, `terraform -chdir=infra apply`).
- `gcloud ... create vm1 vm2` and `delete vm1 vm2` handle every name. Value flags no longer
  become names (`--boot-disk-size 20GB myvm`, `gsutil mb -b on gs://x`).
- Heredoc bodies, `--help`, `--version`, `--dry-run`, `terraform plan` and `apply -destroy` are not leftovers.
- A failed command line blames its last command, not the deploy before it.
- MCP deletes must match the resource type (deleting a Neon branch no longer clears its project).
  `stop_` / `pause_` show as "maybe" with a note that disks and IPs still bill.
- Atlassian is no longer read as MongoDB Atlas; Bigtable, Memorystore and ECS `run_task` are detected.

**New**
- **Gemini CLI and GitHub Copilot CLI** logs, and WSL home folders on Windows.
- **Local leftovers:** `docker run -d`, `docker compose up -d`, `nohup`/`&` background processes,
  ngrok and cloudflared tunnels.
- **Scripts the agent wrote and ran** (`bash setup.sh`): their commands are read too.
- **Cost so far** for hourly items with a known size (VM and GPU types, RDS/SQL tiers, disks,
  NAT, IPs, LBs, control planes), always labelled as a list-price estimate.
- **Account scope:** `gcloud config set project`, `export AWS_PROFILE/AWS_REGION`, `--profile`,
  `--region` flow into each teardown.
- **Claude Code plugin** (`/plugin marketplace add ApahSaroj/agent-leftovers`): a short heads-up at
  session start, plus `/agent-leftovers:leftovers`.
- `--brief` (for hooks and cron), `.agent-leftovers-ignore` and `--baseline`, `--no-ignore`.
- Secrets in commands and MCP arguments are masked in all output.

**Robustness**
- Logs are streamed in 1 MB chunks, so very large logs are read instead of silently skipped;
  unreadable files are reported. Deletes are indexed (15k creates + 15k deletes: about a second).
- `--days=abc` exits 2 with a message; `--logs` reads old files unless `--days` is given;
  unexpected errors exit 2 with a report link. `--help` documents exit codes and env vars.
- CI on Linux and macOS (Node 18, 20, 22) plus a Windows smoke test.
- Tests: 235 (was 113).

## 0.3.0 (2026-10-31)

Built from @markfenner's reply on X: "kubectl apply would be a sneaky one to cover. A LoadBalancer
Service spins up a real cloud load balancer and it's easy to forget it's there."

- **Kubernetes.** Reads the manifests the agent wrote (or piped in with a heredoc / `-f -`) behind
  `kubectl apply|create|replace -f FILE|DIR|-`, and flags what makes the cloud bill you:
  `Service` with `type: LoadBalancer`, `Ingress`, `Gateway` and `PersistentVolumeClaim` (disks).
  Also `kubectl expose --type=LoadBalancer`, `kubectl create service loadbalancer`,
  `kubectl create ingress`, `kubectl patch ... LoadBalancer`, and `helm install` /
  `helm upgrade --install` (ingress-nginx, Traefik, Kong, Istio and similar charts are marked hourly).
- Matches cleanups: `kubectl delete svc/ing/pvc NAME`, `kubectl delete -f` the same file or folder,
  `kubectl delete namespace`, `helm uninstall`.
- Teardown keeps the namespace and context (`kubectl delete service web-lb -n shop`).
- Work on local clusters (kind, minikube, k3d, Docker Desktop, Rancher Desktop, OrbStack) is
  skipped because it costs nothing; the footer says how many were skipped.
- `--verify` checks them with `kubectl get ... -o name` and `helm status` only.
- Tests: 113 (was 93).

## 0.2.0 (2026-10-31)

Built from launch-day feedback on X and Product Hunt.

- **MCP tool calls.** Reads `mcp__server__tool` calls from Claude Code logs and MCP calls from Codex
  (`mcp_tool_call_begin/end` events and `server__tool` function calls). Flags create/deploy calls on
  24 cloud MCP servers (Supabase, Neon, Vercel, Cloudflare, AWS, Google Cloud, DigitalOcean, E2B and more),
  pulls the new resource's id from the tool result, and matches later delete calls so cleaned-up
  items drop out. Failed calls (`is_error`, `Err`, "Error:" results) are marked failed.
  GitHub/Linear/Notion calls, migrations and SQL queries are ignored.
- **`--verify` (opt-in).** Asks your installed cloud CLIs whether each leftover still exists, using
  read-only describe/list calls only. Allow-listed verbs, no shell, unusual names never executed,
  20-second timeout per check. Items that are gone drop out of the list and the exit code.
- Header now counts MCP calls; footer says what `--verify` found.
- Tests: 93 (was 31), plus a 60,000-call stress test with broken log lines.

## 0.1.0 (2026-10-31)

First release: 59 shell rules for Google Cloud, AWS, Azure, Cloudflare, Vercel, Netlify, Railway,
Heroku, Supabase, Fly.io, Firebase, Modal, RunPod, Terraform, Pulumi and Serverless; paid-AI-API
script detection; `--script` teardown output.
