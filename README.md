# harness

**A minimal agent harness on AWS Bedrock AgentCore Runtime.** It's a code
agent (the loop plus a handful of general tools) running on a managed runtime
that invokes it. Give it a prompt and it runs autonomously in an isolated microVM,
reading and writing files, running shell commands and scripts, and searching
the web, working the task to completion. You invoke it asynchronously over
the API and watch it work in CloudWatch.

It's built on the [Strands Agents SDK](https://github.com/strands-agents)
(TypeScript) and is deliberately small. The point isn't the feature list,
it's to show *what a minimal harness actually is* and *how little it takes to
run one on managed infrastructure*: no Slack, no memory, no OAuth, just the
code agent and the runtime it lives in.

```
make invoke PROMPT='compute the 15th Fibonacci number'
        │
        ▼  InvokeAgentRuntime  (returns immediately: "accepted")
   AgentCore Runtime - a fresh, isolated microVM per session
        │  server.ts → buildAgent() → agent.stream()
        │  · the model decides to call bash
        │  · writes + runs a script in /workspace, reads the result
        ▼  final answer streamed to CloudWatch logs
```

---

## How it works

**A code agent, not a tool-calling agent.** Most agents are handed a fixed
set of narrow tools (`get_order`, `send_email`) and can only do what those
tools allow. This one is handed *general* tools (a shell and a filesystem) so
it writes and runs its own code to get a job done. You don't pre-build a tool
per task, the agent composes the capability on demand. `bash` is the tool
that makes it a code agent.

**One isolated microVM per session.** AgentCore Runtime scopes every
invocation to a `runtimeSessionId`, and each one gets its own microVM with
isolated compute, memory and filesystem. No two callers ever share an
environment, which is exactly what makes it safe to hand the agent a raw
shell. Re-using a session id routes back to the same microVM (until it idles
out), and the sample leans on that: the agent is created once per microVM and
reused, so a second invocation with the same session id continues the same
conversation. That is the whole session store. There's no external one, and
when the microVM idles out the conversation goes with it. `make invoke` picks
a fresh id per call by default, so every run is clean; pass `SESSION_ID=` to
continue one.

**Asynchronous by design.** The invoke returns `accepted` immediately rather
than blocking, since the agent may run for minutes. Its progress and final
answer are emitted as structured JSON lines to CloudWatch. The runtime sits
behind an API, so the same agent can be triggered from anywhere: a Slack
mention, a CloudWatch alarm, a PR webhook, or just the CLI as it is here.

**Ephemeral state.** Nothing persists across invocations. Once a session
idles out, the microVM and its filesystem are gone. That's intentional for a
sample, and to keep state longer you'd raise the idle timeout or externalise
it (e.g. AgentCore Memory).

---

## The toolset

Four base tools plus two for the web, and that's the whole list:

| Tool | What it does |
|---|---|
| `read_file` | Read a text file with line numbers, paging with offset/limit |
| `write_file` | Create a file (refuses to overwrite one the agent hasn't read) |
| `edit_file` | Replace an exact, unique string in a file the agent has read |
| `bash` | Run a shell command: ls, rg, python3, git, curl, pip, anything |
| `web_fetch` | Fetch a page and return its text, HTML stripped |
| `web_search` | Search the web via AWS's managed connector (optional, see below) |

Listing, finding and grepping files and running Python all go through `bash`.
The model already knows those commands, so a dedicated tool has to earn its
place by doing something the shell does badly: `read_file` shapes output for
the context window, `edit_file` enforces a unique exact match, `write_file`
is explicit about overwriting. That's the same shape the big coding agents
have converged on, and AgentCore's own managed harness ships just `shell` and
`file_operations`.

**The web tools.** `web_fetch` is plain code: it fetches a page and hands the
model readable text instead of raw HTML, which is the difference between a
usable result and 20k characters of markup. `web_search` is the one piece
with infrastructure behind it: it calls AWS's managed AgentCore web search
connector through an AgentCore Gateway, authenticated with the runtime's IAM
role. No API key, no scraping. It's on by default and
`"webSearch": false` in `config.json` leaves it out entirely (no gateway is
created and the tool isn't wired). The gateway speaks MCP, but a
tool call is one signed HTTP POST, so `src/web.ts` makes that call directly
rather than pulling in an MCP client. That's how AWS exposes search; any
search API would slot in the same way.

**Tool descriptions do real work.** The model only knows what the
descriptions tell it, so they spell out the things that would otherwise
surprise it: each `bash` call is a fresh shell, commands are killed after the
timeout and long jobs go in the background, output is capped, edits need the
file read first, and line-number prefixes from `read_file` must be stripped
before matching. Every tool returns either a normal result or
`{error, hint}`, it never throws, so the agent reads the hint and adapts. The
run is limited to 50 turns. Harden further before production use.

**Skills.** Beyond tools, the agent can load *skills*, which are folders under
`skills/` each containing a `SKILL.md`. Strands lists them in the system
prompt and the agent pulls in a skill's full instructions on demand
(progressive disclosure). Drop in a new folder and it's picked up
automatically, and there's a worked example in `skills/ascii-banner/`.

---

## Configuration

Everything you'd want to change lives in one file, `config.json`, read by the
Makefile, the CDK stack and the running container alike:

```json
{
  "region": "eu-west-1",
  "bedrockModelId": "global.anthropic.claude-opus-4-8",
  "webSearch": true,
  "tracing": true,
  "redactTraceContent": true
}
```

No deploy flags. Change the file, `make deploy`, done. The only value that
reaches the container as an environment variable is the web search gateway
URL, because it only exists after deploy.

---

## Tracing

A harness you can't observe isn't much of a harness, so tracing is on by
default. Strands emits OpenTelemetry spans for the agent loop, every model
call and every tool call. `src/tracing.ts` registers a tracer provider that
exports them, SigV4-signed, to X-Ray's OTLP endpoint, and CloudWatch
Transaction Search turns them into the per-session view in
**CloudWatch > GenAI Observability**. Each span carries `session.id`, so one
invocation is one trace, and the sampler is always-on: every session is
exported, not a sample of them.

One-time account setup, per region:

```bash
make observability.enable
```

That does three things: lets X-Ray write to CloudWatch Logs, points X-Ray at
CloudWatch Logs, and sets the indexing rule to 100% so every trace is
searchable (the default indexes a sample). It's deliberately not part of the
stack: the setting is shared by every agent in the account and region, so
tearing down one stack shouldn't switch it off. Activation takes a few
minutes; until it's active, X-Ray rejects the export and the run logs an
`error` event saying so. Safe to run again.

**Redaction.** Strands records what was said on the spans: messages as span
events, tool arguments and results as attributes. With
`redactTraceContent: true` (the default) those are stripped before export, so
a trace shows the shape of a run (tools called, tokens, timings) but not the
prompts, answers or tool payloads. Set it to `false` when you're debugging and
want the full content in the trace.

Why not AWS's Node auto-instrumentation: it patches `require()` and only works
for CommonJS builds. This harness is ESM under `tsx`, where it silently emits
nothing, which is exactly the failure mode to avoid in something meant to be
observable.

---

## Prerequisites

- An **AWS account** with credentials in your shell (`aws sts get-caller-identity`
  succeeds) and **Bedrock model access** in the configured region for the
  configured model.
- **Docker** with Buildx. The runtime image is ARM64, and Buildx cross-builds
  it from an x86 host.
- **Node 22+** and **AWS CLI v2**.
- A one-time CDK bootstrap: `npx cdk bootstrap aws://<account-id>/eu-west-1`.

The default region is `eu-west-1`, one of the regions where the managed web
search connector is available. The shell's `AWS_REGION` is ignored on purpose;
the region comes from `config.json` only.

---

## Use it

```bash
make install                          # root + cdk dependencies
make observability.enable             # once per account/region: Transaction Search at 100%
make deploy                           # build + push the ARM64 image, then cdk deploy

make invoke PROMPT='Compute 7 factorial with a Python script and tell me the number.'
make logs                             # tail the runtime's CloudWatch logs

# continue a conversation: reuse the session id `make invoke` printed
make invoke SESSION_ID=<id> PROMPT='Now divide it by 8.'

make destroy                          # tear it all down
```

`make invoke` returns `accepted` immediately and the agent runs
asynchronously, so watch `make logs` for the tool calls and the final answer.
CloudWatch delivery can lag a minute or two on a cold runtime. A follow-up
call with the same `SESSION_ID` within the idle timeout (120 seconds by
default, see `cdk/lib/runtime-stack.ts`) lands in the same microVM and the
agent remembers the earlier turns.

To change the model, region or a feature switch, edit `config.json` and
deploy again.

---

## Project layout

```
src/
  server.ts      AgentCore entrypoint, accepts {prompt} and runs the agent async
  agent.ts       buildAgent() (prompt + tools + skills + model) and the stream loop
  tools.ts       the four base tools
  web.ts         web_fetch, and web_search (one signed POST to the gateway)
  tracing.ts     OpenTelemetry provider + SigV4 exporter to X-Ray, optional redaction
  config.ts      reads config.json; the one place runtime config comes from
  prompt.ts      the system prompt
  emit.ts        JSON-line stdout logger
config.json    region, model, feature switches (read by Makefile, CDK and runtime)
skills/
  ascii-banner/SKILL.md   sample skill; add a folder here and it's auto-loaded
cdk/
  bin/harness.ts          CDK app
  lib/runtime-stack.ts    the only stack: CfnRuntime + IAM role + web search gateway
Dockerfile     the ARM64 runtime image
Makefile       install / observability.enable / deploy / invoke / logs / destroy
```

---

## License

[MIT](./LICENSE).
