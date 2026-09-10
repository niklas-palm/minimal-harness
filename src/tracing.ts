// Tracing. Strands emits OpenTelemetry spans for the agent loop, every model
// call and every tool call. We register a tracer provider that exports them
// to AWS X-Ray's OTLP endpoint; CloudWatch Transaction Search indexes them
// and the CloudWatch GenAI Observability console shows them per session
// (see `make observability.enable` for the one-time account setup).
//
// Why our own exporter: X-Ray's OTLP endpoint wants SigV4-signed requests,
// which the stock OTLP exporter can't do, and AWS's Node auto-instrumentation
// only works for CommonJS builds. Signing the POST ourselves is 20 lines.
//
// Three small things AWS's distro does that the console's Agent and Session
// views depend on, so we do them too: mark the resource as a gen_ai_agent,
// put session.id on every span (not just the root), and deliver spans to the
// agent's own log group (the `spans` stream AgentCore pre-creates) instead of
// the shared aws/spans group.

import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { ProtobufTraceSerializer } from "@opentelemetry/otlp-transformer";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  AlwaysOnSampler,
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { SignatureV4 } from "@smithy/signature-v4";

import { REDACT_TRACE_CONTENT, REGION } from "./config.js";

const ENDPOINT = new URL(`https://xray.${REGION}.amazonaws.com/v1/traces`);

// AgentCore sets OTEL_RESOURCE_ATTRIBUTES on the container (service name, the
// runtime's log group, cloud.resource_id) so the console can tie spans to this
// agent. Empty when running locally.
const ENV_ATTRIBUTES: Record<string, string> = Object.fromEntries(
  (process.env.OTEL_RESOURCE_ATTRIBUTES ?? "")
    .split(",")
    .filter(Boolean)
    .map((kv) => kv.split("=", 2) as [string, string]),
);
const LOG_GROUP = ENV_ATTRIBUTES["aws.log.group.names"];

class XRayExporter implements SpanExporter {
  private signer = new SignatureV4({
    service: "xray",
    region: REGION,
    credentials: defaultProvider(),
    sha256: Sha256,
  });

  // With these headers X-Ray delivers the spans to the agent's own log group;
  // without them (locally) they go to the shared aws/spans group.
  private headers: Record<string, string> = {
    host: ENDPOINT.host,
    "content-type": "application/x-protobuf",
    ...(LOG_GROUP && {
      "x-aws-log-group": LOG_GROUP,
      "x-aws-log-stream": "spans",
    }),
  };

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    this.send(spans).then(
      () => done({ code: ExportResultCode.SUCCESS }),
      (error: Error) => done({ code: ExportResultCode.FAILED, error }),
    );
  }

  private async send(spans: ReadableSpan[]): Promise<void> {
    const body = ProtobufTraceSerializer.serializeRequest(spans);
    if (!body) return;
    const signed = await this.signer.sign({
      method: "POST",
      protocol: ENDPOINT.protocol,
      hostname: ENDPOINT.hostname,
      path: ENDPOINT.pathname,
      headers: this.headers,
      body,
    });
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: signed.headers,
      body: Buffer.from(body),
    });
    if (!res.ok)
      throw new Error(
        `x-ray returned ${res.status}: ${(await res.text()).slice(0, 200)}`,
      );
  }

  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

// Content redaction. Strands records what was said on the spans: messages as
// span events, tool arguments and results as attributes. With
// redactTraceContent on we drop the events and blank those attributes before
// export, so a trace still shows the shape of a run (tools called, tokens,
// timings) but not what the user or the model said.
const CONTENT_ATTRIBUTES = [
  "gen_ai.system_instructions",
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
];
const redactor: SpanProcessor = {
  onStart() {},
  onEnd(span) {
    const attributes = span.attributes as Record<string, unknown>;
    for (const key of CONTENT_ATTRIBUTES)
      if (key in attributes) attributes[key] = "[REDACTED]";
    span.events.length = 0;
  },
  async forceFlush() {},
  async shutdown() {},
};

// The session this microVM serves, stamped on every span: the Session view
// groups on it, and Strands only puts it on the root span.
let sessionId: string | undefined;
export function setTraceSessionId(id: string): void {
  sessionId = id;
}
const sessionStamp: SpanProcessor = {
  onStart(span) {
    if (sessionId) span.setAttribute("session.id", sessionId);
  },
  onEnd() {},
  async forceFlush() {},
  async shutdown() {},
};

let provider: NodeTracerProvider | undefined;

export function startTracing(): void {
  provider = new NodeTracerProvider({
    // aws.service.type is what marks this resource as an agent to the console.
    resource: resourceFromAttributes({
      "service.name": "harness",
      "aws.service.type": "gen_ai_agent",
      ...ENV_ATTRIBUTES,
    }),
    sampler: new AlwaysOnSampler(), // every session, not a sample of them
    spanProcessors: [
      sessionStamp,
      ...(REDACT_TRACE_CONTENT ? [redactor] : []),
      new BatchSpanProcessor(new XRayExporter()),
    ],
  });
  // Registers the global tracer provider; Strands picks it up from there.
  provider.register();
}

// Call at the end of a run: the microVM may be torn down soon after, and
// BatchSpanProcessor otherwise exports on a timer.
export async function flushTraces(): Promise<void> {
  await provider?.forceFlush();
}
