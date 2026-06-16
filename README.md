# harness

**A minimal code agent on AWS Bedrock AgentCore Runtime.** Give it a prompt;
it runs autonomously in an isolated microVM — reading and writing files,
running shell and Python, searching the web — and works the task to
completion. You invoke it asynchronously over the API and watch it work in
CloudWatch.

It's built on the [Strands Agents SDK](https://github.com/strands-agents)
(TypeScript) and is deliberately small. The point isn't the feature list —
it's to show *what a code agent actually is* and *how little it takes to run
one on managed infrastructure*: no Slack, no memory, no OAuth, just the agent
and the runtime it lives in.

```
make invoke PROMPT='compute the 15th Fibonacci number'
        │
        ▼  InvokeAgentRuntime  (returns immediately: "accepted")
   AgentCore Runtime — a fresh, isolated microVM per session
        │  server.ts → buildAgent() → agent.stream()
        │  · the model decides to call run_python
        │  · writes + runs code in /workspace, reads the result
        ▼  final answer streamed to CloudWatch logs
```

---

## How it works

**A code agent, not a tool-calling agent.** Most agents are handed a fixed
set of narrow tools (`get_order`, `send_email`) and can only do what those
tools allow. This one is handed *general* tools — a shell, a Python
interpreter, a filesystem — so it writes and runs its own code to get a job
done. You don't pre-build a tool per task; the agent composes the capability
on demand. `run_python` is the tool that makes it a code agent.

**One isolated microVM per session.** AgentCore Runtime scopes every
invocation to a `runtimeSessionId`, and each one gets its own microVM with
isolated compute, memory and filesystem. No two callers ever share an
environment — which is exactly what makes it safe to hand the agent a raw
shell. Re-using a session id routes back to the same microVM (until it idles
out); the sample uses a fresh id per call, so every run is clean.

**Asynchronous by design.** The invoke returns `accepted` immediately rather
than blocking — the agent may run for minutes, and its progress and final
answer are emitted as structured JSON lines to CloudWatch. The runtime sits
behind an API, so the same agent can be triggered from anywhere: a Slack
mention, a CloudWatch alarm, a PR webhook, or just the CLI as it is here.

**Ephemeral state.** Nothing persists across invocations — once a session
idles out, the microVM and its filesystem are gone. That's intentional for a
sample; to keep state longer you'd raise the idle timeout or externalise it
(e.g. AgentCore Memory).

---

## The toolset

14 baseline tools, enough for the agent to build its own capabilities:

| Area | Tools |
|---|---|
| Files | `read_file` `write_file` `edit_file` `multi_edit` `list_directory` |
| Search | `glob_files` `grep_search` |
| Execution | `run_bash` **`run_python`** |
| Data & media | `preview_data` `preview_file` `view_image` |
| Web | `web_search` `web_fetch` |

Every tool returns either a normal result or `{error, hint}` — it never
throws, so the agent reads the hint and adapts. They're deliberately simple
to read; harden them (output caps, tighter sandboxing) before production use.

**Skills.** Beyond tools, the agent can load *skills* — folders under
`skills/` each containing a `SKILL.md`. Strands lists them in the system
prompt and the agent pulls in a skill's full instructions on demand
(progressive disclosure). Drop in a new folder and it's picked up
automatically; see `skills/ascii-banner/` for a worked example.

---

## Prerequisites

- An **AWS account** with credentials in your shell (`aws sts get-caller-identity`
  succeeds) and **Bedrock model access** in `eu-north-1` for the default model
  (`global.anthropic.claude-opus-4-8`).
- **Docker** with Buildx — the runtime image is ARM64; Buildx cross-builds it
  from an x86 host.
- **Node 22+** and **AWS CLI v2**.
- A one-time CDK bootstrap: `npx cdk bootstrap aws://<account-id>/eu-north-1`.

Everything runs in `eu-north-1`, and that's fixed by design (see `src/config.ts`).

---

## Use it

```bash
make install                          # root + cdk dependencies
make deploy                           # build + push the ARM64 image, then cdk deploy

make invoke PROMPT='Use run_python to compute 7 factorial and tell me the number.'
make logs                             # tail the runtime's CloudWatch logs

make destroy                          # tear it all down
```

`make invoke` returns `accepted` immediately and the agent runs
asynchronously — watch `make logs` for the tool calls and the final answer.
CloudWatch delivery can lag a minute or two on a cold runtime.

Override the model at deploy with
`make deploy CDK_ARGS='-c bedrockModelId=...'` (or edit the default in
`cdk/bin/harness.ts`).

---

## Project layout

```
src/
  server.ts    AgentCore entrypoint — accepts {prompt}, runs the agent async
  agent.ts     buildAgent() (prompt + tools + skills + model) and the stream loop
  tools.ts     the 14 baseline tools
  config.ts    single source of runtime config (fails loud on missing required vars)
  prompt.ts    the system prompt
  emit.ts      JSON-line stdout logger
skills/
  ascii-banner/SKILL.md   sample skill; add a folder here and it's auto-loaded
cdk/
  bin/harness.ts          CDK app
  lib/runtime-stack.ts    the only stack: CfnRuntime + its IAM role
Dockerfile     the ARM64 runtime image
Makefile       install / deploy / invoke / logs / destroy
```

---

## License

[MIT](./LICENSE).
