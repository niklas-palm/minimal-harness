// Tracing. Strands emits OpenTelemetry spans for the agent loop, every model
// call and every tool call. We register a tracer provider that exports them
// to AWS X-Ray's OTLP endpoint; CloudWatch Transaction Search indexes them
// and the CloudWatch GenAI Observability console shows them per session
// (see `make observability.enable` for the one-time account setup).
//
// Why our own exporter: X-Ray's OTLP endpoint wants SigV4-signed requests,
// which the stock OTLP exporter can't do, and AWS's Node auto-instrumentation
// only works for CommonJS builds. Signing the POST ourselves is 20 lines.

import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { ProtobufTraceSerializer } from '@opentelemetry/otlp-transformer';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  AlwaysOnSampler,
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { SignatureV4 } from '@smithy/signature-v4';

import { REDACT_TRACE_CONTENT, REGION } from './config.js';

const ENDPOINT = new URL(`https://xray.${REGION}.amazonaws.com/v1/traces`);

class XRayExporter implements SpanExporter {
  private signer = new SignatureV4({
    service: 'xray',
    region: REGION,
    credentials: defaultProvider(),
    sha256: Sha256,
  });

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
      method: 'POST',
      protocol: ENDPOINT.protocol,
      hostname: ENDPOINT.hostname,
      path: ENDPOINT.pathname,
      headers: { host: ENDPOINT.host, 'content-type': 'application/x-protobuf' },
      body,
    });
    const res = await fetch(ENDPOINT, { method: 'POST', headers: signed.headers, body: Buffer.from(body) });
    if (!res.ok) throw new Error(`x-ray returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
  'gen_ai.system_instructions',
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
];
const redactor: SpanProcessor = {
  onStart() {},
  onEnd(span) {
    const attributes = span.attributes as Record<string, unknown>;
    for (const key of CONTENT_ATTRIBUTES) if (key in attributes) attributes[key] = '[REDACTED]';
    span.events.length = 0;
  },
  async forceFlush() {},
  async shutdown() {},
};

// AgentCore sets OTEL_RESOURCE_ATTRIBUTES on the container (the runtime's
// log group, among others) so the console can tie spans to this agent.
function resourceAttributesFromEnv(): Record<string, string> {
  const pairs = (process.env.OTEL_RESOURCE_ATTRIBUTES ?? '').split(',').filter(Boolean);
  return Object.fromEntries(pairs.map((kv) => kv.split('=', 2) as [string, string]));
}

let provider: NodeTracerProvider | undefined;

export function startTracing(): void {
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': 'harness', ...resourceAttributesFromEnv() }),
    sampler: new AlwaysOnSampler(), // every session, not a sample of them
    spanProcessors: [...(REDACT_TRACE_CONTENT ? [redactor] : []), new BatchSpanProcessor(new XRayExporter())],
  });
  // Registers the global tracer provider; Strands picks it up from there.
  provider.register();
}

// Call at the end of a run: the microVM may be torn down soon after, and
// BatchSpanProcessor otherwise exports on a timer.
export async function flushTraces(): Promise<void> {
  await provider?.forceFlush();
}
