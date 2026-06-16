# harness

A minimal **code agent** on AWS Bedrock AgentCore Runtime. You invoke it
asynchronously via the API with a prompt; it runs in an isolated microVM
with a sandboxed toolset — reading/writing files, running shell and Python,
searching the web — and works the task to completion. Progress and the final
answer land in CloudWatch.

It's built on the [Strands Agents SDK](https://github.com/strands-agents)
(TypeScript) and is deliberately small: this is the "what *is* a code agent,
and how little does it take to run one on managed infrastructure" sample,
with no Slack, no memory, no OAuth — just the agent.

```
make invoke PROMPT='compute the 15th Fibonacci number'
        │
        ▼  InvokeAgentRuntime  (returns immediately: "accepted")
   AgentCore Runtime — one microVM per invocation
        │  buildAgent() → agent.stream()
        │  · the model decides to call run_python
        │  · writes + runs code in /workspace
        ▼  final answer logged to CloudWatch
```

---

## What's in here

```
src/
  server.ts    AgentCore entrypoint — accepts {prompt}, runs the agent async
  agent.ts     buildAgent() (prompt + tools + model) and the stream loop
  config.ts    single source of runtime config (loud on missing required vars)
  tools.ts     the 14 base tools (files, shell, run_python, web, data preview)
  prompt.ts    the system prompt   emit.ts  JSON-line stdout logger
cdk/
  bin/harness.ts        CDK app
  lib/runtime-stack.ts  the only stack: CfnRuntime + its IAM role
Dockerfile     the ARM64 runtime image
Makefile       install / deploy / invoke / logs
```

The agent is granted 14 tools; the interesting one is **`run_python`**,
which is what makes this a *code agent* — it writes and executes its own code
rather than calling pre-built per-task tools.

---

## Prerequisites

- **AWS account** with credentials in your shell (`aws sts get-caller-identity`
  succeeds) and **Bedrock model access** in `eu-north-1` for the default model
  (`global.anthropic.claude-opus-4-8`).
- **Docker** with Buildx (the image is ARM64; Buildx cross-builds from x86).
- **Node 22+**, **AWS CLI v2**, and a one-time
  `npx cdk bootstrap aws://<account-id>/eu-north-1`.

Everything runs in `eu-north-1` and that isn't configurable (see `src/config.ts`).

---

## Use it

```bash
make install                          # root + cdk deps
make deploy                           # build + push the ARM64 image, then cdk deploy

make invoke PROMPT='Use run_python to compute 7 factorial and tell me the number.'
make logs                             # tail the runtime's CloudWatch logs

make destroy                          # tear it all down
```

`make invoke` returns `accepted` immediately — the agent runs asynchronously
in its microVM. Watch `make logs` for the tool calls and the final answer.
CloudWatch delivery from AgentCore can lag a minute or two on a cold runtime.

Override the model at deploy with `-c bedrockModelId=...` via
`make deploy CDK_ARGS=...` (or edit the default in `cdk/bin/harness.ts`).

---

## License

MIT.
