# Contributing

Thanks for helping. The most useful contributions are small and concrete.

## Report a false positive or a miss

Open an issue with the "False positive / missed resource" template and paste:

- the command or MCP tool name the agent ran (mask anything secret),
- what agent-leftovers printed for it, and what you expected.

`npx github:ApahSaroj/agent-leftovers --json --project <folder>` gives the exact rule id and command for each item.

## Add a rule

Shell rules live in `src/rules.js`. Each rule has `when` (the command prefix), `name` or
`multi` (how to read the resource name), `teardown`, and optionally `undo` (the delete that
cleans it up) and `deploy: true` (for commands that usually update something that already
exists, so the teardown looks before it deletes).

Rules of thumb:

- A teardown never adds `--quiet`, `--yes`, `--force` or anything that skips a safety prompt.
- A deploy or apply never gets a bare delete or destroy: start with a describe/list/state command.
- Never put a folder path or a placeholder like `(all functions)` into a command argument.
- If you add a `--verify` check in `src/verify.js`, use only read verbs, and add what "not found"
  looks like for that CLI to `GONE`.

MCP servers are recognised in `src/mcp.js` by server name and the verb in the tool name.

## Run the tests

```
node test/run.js      # unit + CLI tests, no network, no cloud account needed
node test/stress.js   # 60,000 tool calls
node test/smoke.js    # what CI runs on Windows
```

Every fix should come with a test that fails without it. No runtime dependencies, please.

## AI disclosure

Much of this code was written with an AI coding agent and reviewed by a human. Contributions made
the same way are welcome; please test them as you would your own.
