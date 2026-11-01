# Changelog

## 0.4.2 (2026-11-01)

From three outside reviews of 0.4.1 (matching, log readers, teardown commands) and a fresh-eyes
review of 0.4.2 itself. Every reproduced issue is now a regression test: 340 new tests, 585 in total
(338 after round 1, 403 after round 2, 585 after the fresh review), and every teardown the tests
produce (363) is checked with `bash -n`.

**Note:** `--brief` and `--script` now exit 1 when leftovers are found, as the help always said
(they exited 0). Hooks that only read output on exit 0 should add the new `--exit-zero`; the
Claude Code plugin's SessionStart hook does.

**Note:** teardowns now come as up to three parts: the command to run (`teardown`, with no `#`
comment and no `&&`), a hint (`teardownHint`: what to check, what to run next) and, for tools with
no folder flag, the folder to run it in (`runIn`). The text report prints them on separate lines
(`run in:`, `turn off:`, `hint:`), `--script` prints hints as `## hint:` lines that stay comments,
and `--json` has the three fields. Before, everything was one line with a trailing `# note`.

**Note:** the same name in two zones, regions, resource groups, subscriptions or gcloud
accounts/configurations now shows as two rows. Before, they were merged into one.

**Fixes for things hidden while they still billed**
- A delete now clears only the resource in the same zone or region, Azure resource group (names
  compared case-insensitively), ECS cluster, Heroku app, Kubernetes context and namespace, and the
  same MCP parent (a Neon branch in project p1 is not cleared by a delete in p2).
- `gcloud config set core/project`, `gcloud beta` with an inline `CLOUDSDK_CORE_PROJECT=`, and a failed
  `az account set` are handled correctly.
- `cd infra && terraform destroy` (and compose, serverless and so on) is matched to the right folder.
- Counted only as "maybe" now: a delete on a failed command line, inside a failed script, from
  another MCP server of the same provider, or on a `$VAR` name from another session.
- An EC2 terminate with a known, different instance ID no longer touches other instances.
- `kubectl delete -f` matches kind and namespace, not just the name.
- Kept GCP disks and Azure VM leftovers are matched in their own project, zone and subscription.
- `az group delete` also clears the VMs and databases made in that group.
- `bash -c "..."` and scripts that fail partway are now read.
- `gcloud storage buckets describe/update/...` and `fly apps list` no longer count as deletes.
- A timed-out or interrupted create is listed (marked "uncertain") instead of hidden as failed.

**Safety fixes in teardown commands**
- Names from the logs can no longer run as shell code: a name with shell characters becomes
  `<NAME>` (with a note); folders in `cd` and odd flag values are single-quoted.
- MCP deployments: the Vercel teardown removes only a deployment id or URL, with `--safe`, never the
  project; Netlify never offers `sites:delete` for a deploy. Both are marked as deploys.
- `serverless remove` keeps `--stage`, `--region` and `--aws-profile`.
- `sam`, `cdk` and `eksctl` teardowns carry the profile and region.
- kubectl/helm teardowns carry `--context` after GKE or AKS `get-credentials` (or an EKS `--alias`),
  and `--verify` asks that context. When it can't be named, the teardown asks you to check
  `kubectl config current-context` first and `--verify` skips the item.
- Docker Compose keeps `-p` and every `-f`; `docker-compose -f FILE up -d` is now found.
- Terraform with `TF_WORKSPACE` gives valid shell and keeps the workspace.
- Smaller: GKE `--location`, `fly machine destroy --force -a APP`, `supabase functions delete --project-ref`,
  `--verify` reads quoted flag values, no `(new app)` placeholders, R2 `--jurisdiction`, `pulumi -C`,
  Railway no longer suggests `railway down` as a delete, Heroku add-on by add-on name, Aurora members
  without a final snapshot.

**Log support**
- Claude Code `PowerShell` tool; Codex `powershell -Command` / `pwsh` / `cmd /c` calls; Gemini
  subagent chats; `~/.config/claude/projects`; Claude Desktop agent-mode folder (path from a
  third-party source, unverified).
- Background runs via `run_in_background`, Gemini `is_background` and Copilot `detach` are listed.
- The same tool call in two files is counted once; a UTF-8 BOM no longer drops a line or a file;
  Codex output given as an array is read.
- The text report and `--script` print the "uncertain" note.

**New coverage:** GKE node pools, eksctl node groups, AKS node pools, `aws cloudformation deploy` /
`create-stack`, `sst deploy`.

**Round 2 (same release)**
- Windows: teardowns paste into cmd.exe and Windows PowerShell 5.1. The `# note` is a separate field
  and line; `cd DIR && ...` became `terraform -chdir=DIR`, `docker compose --project-directory DIR`
  (with absolute `-f` paths) and `pulumi --cwd DIR`, or a separate `run in:` folder for tools with no
  such flag (serverless, railway, wrangler, fly, sam, cdk). On Windows, words with spaces use double
  quotes, `%`/`$` names become `<NAME>`, `TF_WORKSPACE=`/`AWS_REGION=` prefixes move to the hint with
  the `set` / `$env:` form, and ngrok, cloudflared, background processes and ssh tunnels are found with
  `Get-CimInstance` through `powershell -NoProfile -Command` and stopped with `taskkill /PID`
  (`pgrep` / `kill` elsewhere). `docker run` teardowns no longer chain `docker stop && docker rm`.
- Cost estimates: `gcloud compute disks create --size 2TB` is 2048 GB (was read as 2 GB); `pd-balanced`
  is $0.10/GB-month (was priced as SSD); default disk size is 100 GB for non-standard types; `az vm create`
  without `--size` is `Standard_D2s_v5`, the Azure CLI default (was `Standard_DS1_v2`, unpriced); EBS
  volumes default to `gp2` and read `--volume-type`.
- `gcloud config set compute/zone` / `compute/region` (and `CLOUDSDK_COMPUTE_ZONE/REGION`, `config unset`,
  `configurations activate`) are tracked per session: zonal VMs, disks, TPUs and GKE clusters, and
  regional static IPs, get that zone/region in their scope and their teardown.
- Bucket deletes are credited across sibling rules: `gsutil mb` + `gcloud storage buckets delete` /
  `gcloud storage rm -r`, `gcloud storage buckets create` + `gsutil rb`, `aws s3 mb` + `aws s3api
  delete-bucket`, `aws s3api create-bucket` + `aws s3 rb`. A rule can now have several undo patterns.
- `--version VALUE` (tpu-vm runtime, helm chart version) no longer hides a create as "prints a version".
- New coverage, each with its teardown and its delete: Cloud TPU VMs, Vertex AI Workbench (and legacy
  user-managed notebooks), SageMaker notebook instances (stop, then delete), Azure ML compute, Bedrock
  provisioned throughput (warns about commitment terms), Azure OpenAI / AI Services deployments
  (hourly when provisioned) and accounts (soft-delete purge), ALB/NLB, interface VPC endpoints,
  ElastiCache replication groups and serverless caches, OpenSearch domains (and legacy `es`) and
  Serverless collections, Redshift clusters and Serverless workgroups, Lightsail instances,
  `doctl` Droplets, managed databases and Kubernetes clusters, Azure Container Instances, VM scale sets,
  Azure Cache for Redis, Cosmos DB, Azure SQL servers and databases, `ssh -f` port-forward tunnels,
  `tailscale funnel`, `podman run -d`. TPUs, Bedrock provisioned throughput and provisioned Azure
  OpenAI deployments are marked `ACCEL, HOURLY` and listed with GPUs at the top. Hourly estimates
  added for ALB/NLB and interface endpoints.

**Fresh review (same release)**
- Creates hidden behind a wrapper are found: `timeout 900 …`, `nohup`, `setsid`, `nice -n N`,
  `stdbuf`, `aws-vault exec P -- …`, `doppler run -- …`, `op run -- …`, `dotenv -- …`,
  `pnpm|yarn|npm exec [--] …`, `bun x …`, `env -u X …`, `sudo -u USER -E …`, `time -p …`.
- Shell syntax no longer hides a create: `if …; then …; fi`, `for …; do …; done`, `( … )`, `{ …; }`,
  `! cmd`. `(cd infra && terraform apply)` is matched to `infra`, and the `cd` ends at the `)`.
- `bash -lc '…'` (and `-ec`, `-xc`, `sh`, `dash`, `ksh`) is unwrapped like `bash -c`.
- `docker run -h HOST` (and `psql`/`mysql`/`redis-cli -h`) is no longer read as `--help`.
- `docker compose up` and `docker run` without `-d`, sent to the background with `&` or the agent's
  background flag, are listed, as the 0.4.2 notes already promised.
- `./scripts/up.sh` the agent wrote is read from `scripts/`, never from a different `./up.sh`.
- Process lookups (`pgrep -af WORD`, and the PowerShell `-match 'WORD'` on Windows) only ever contain
  plain characters: `$( )`, backticks and quotes from a log become `.` and a leading `-` can't become
  a flag. Background-process words come from the script, or from `python -m MODULE`
  (`python3 -m http.server &` looks up `http.server`, not every python3).
- EC2 teardowns put `--region` after the whole `--filters Name=…,Values=running` argument (it was
  inserted inside it, which AWS rejects).
- `kubectl --context` / `-n` and `helm -n` values with shell characters become `<CONTEXT>` /
  `<NAMESPACE>` with a note (they were dropped, pointing the teardown at the current context or
  namespace), `--verify` skips those items, and a delete with such a value clears nothing.
- `grep -rn nohup …`, `ps aux | grep nohup` and similar are no longer background processes.
- `terraform apply -refresh-only` is not a create.
- `pkill -f PAT`, `pkill NAME`, `killall NAME` and `kill $(pgrep -f X)` after a background start in the
  same session mark it cleaned; a bare `kill %1` / `kill $!` / `kill PID` marks it "maybe".
- A cloud create sent to the background (`gcloud … create vm &`) is one row (the VM), not also a
  background process called `gcloud`.
- Very long log lines (inline images, pasted files) are read in linear time: 80 MB took 17 s and
  300 MB never finished; now about 1 s and 2 s.
- `--brief`, `--script` (and `--json`, text) use the documented exit codes; new `--exit-zero`.
- `--expired` / `--tag` with no match say "Nothing matches the filter (…)" and how many other items it
  hid, instead of "Nothing left running".
- README: says where `--force` is used (`fly machine destroy <ID> --force`, which Fly requires for a
  running machine) instead of "no `--force`".

## 0.4.1 (2026-11-01)

- Fix: a delete now clears only the resource in the same project, account, profile, region or subscription. Before, deleting VM "web" in project A also marked "web" in project B as cleaned. Reported on X. 4 regression tests (245 total).

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
