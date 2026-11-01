# Security

agent-leftovers reads your local agent logs, which can contain commands, file contents and
secrets. It is built to be safe by default:

- Without `--verify` or `--sweep` it runs no programs and makes no network calls.
- With `--verify` it runs only read-only describe/list/get commands from an allow-list. Names
  taken from logs must look like real resource names (never starting with `-`), every argument is
  checked against a strict character set, the CLI is looked up on your PATH (never in the current
  folder), and it runs from your temp folder.
- `--sweep` runs the same way, with three allow-listed list calls only (`gcloud compute
  instances|disks|addresses list`, `aws resourcegroupstaggingapi get-resources`, `az resource list`).
  Its teardowns are printed with a warning that the resource may not be your agent's.
- Secrets in commands and MCP arguments (API keys, passwords, tokens, `KEY=value` pairs) are masked
  in the text, `--json` and `--script` output, including tag values. Control characters (newlines,
  terminal escape codes) are stripped from every name, so a name can't break out of a `--script`
  comment or rewrite your terminal.
- Teardown commands are only printed, never run. `--script` writes every line commented out.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private reporting
(Security tab, "Report a vulnerability") on https://github.com/ApahSaroj/agent-leftovers.
I aim to reply within 72 hours.
