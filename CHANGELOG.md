# Changelog

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
