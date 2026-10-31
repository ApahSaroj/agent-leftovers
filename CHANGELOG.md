# Changelog

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
