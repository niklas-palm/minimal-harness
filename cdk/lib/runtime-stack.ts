// AgentCore CfnRuntime for the harness - the agent container, the IAM role it
// runs as, and (unless switched off in config.json) an AgentCore Gateway
// fronting AWS's managed web search connector. That's the whole stack: no
// memory, no OAuth, no trigger Lambda. You invoke the runtime directly via the
// API (see the Makefile).
import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import { CfnGateway, CfnGatewayTarget, CfnRuntime } from 'aws-cdk-lib/aws-bedrockagentcore';
import { ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

const AGENTCORE_PRINCIPAL = 'bedrock-agentcore.amazonaws.com';
// After this many seconds idle, AgentCore terminates the microVM and all its
// state. This sample doesn't persist anything across invocations, so we keep
// it short. Raise it (or externalise state, e.g. via AgentCore Memory) if you
// need state to survive longer between calls.
const IDLE_TIMEOUT_SECONDS = 120;

export interface RuntimeStackProps extends StackProps {
  /** ECR image tag (content hash from the Makefile, written to a JSON file). */
  readonly imageTag: string;
  /** ECR repository name (must match the Makefile's REPO_NAME). */
  readonly repoName: string;
  /** Provision the web search gateway and give the agent a web_search tool. */
  readonly webSearch: boolean;
  /** Let the runtime role export OpenTelemetry spans to X-Ray. */
  readonly tracing: boolean;
}

export class RuntimeStack extends Stack {
  public readonly runtimeArn: string;

  constructor(scope: Construct, id: string, props: RuntimeStackProps) {
    super(scope, id, props);

    const { region, account } = Stack.of(this);
    const { imageTag, repoName, webSearch, tracing } = props;

    const containerUri = `${account}.dkr.ecr.${region}.amazonaws.com/${repoName}:${imageTag}`;
    const runtimeLogGroupArn = `arn:aws:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes/*`;

    // ReadOnlyAccess gives the agent broad read access to the account (handy
    // for the "ask boto3 about my account" use case). Everything below adds
    // the few write/invoke actions ReadOnlyAccess doesn't cover.
    const role = new Role(this, 'RuntimeRole', {
      assumedBy: new ServicePrincipal(AGENTCORE_PRINCIPAL),
      description: 'Runtime role for the harness AgentCore runtime.',
      managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName('ReadOnlyAccess')],
    });

    // CloudWatch logs the runtime auto-creates per session.
    role.addToPolicy(
      new PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
        resources: [runtimeLogGroupArn, `${runtimeLogGroupArn}:log-stream:*`],
      }),
    );

    // Bedrock model invocation. Unscoped so cross-region inference profiles
    // (e.g. global.anthropic.claude-opus-4-8) work without listing every
    // sub-arn. ReadOnlyAccess does not include bedrock:Converse*.
    role.addToPolicy(
      new PolicyStatement({
        actions: [
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream',
          'bedrock:Converse',
          'bedrock:ConverseStream',
        ],
        resources: ['*'],
      }),
    );

    // Spans go to X-Ray's OTLP endpoint (see src/tracing.ts). X-Ray has no
    // resource-level permissions.
    if (tracing) {
      role.addToPolicy(
        new PolicyStatement({
          actions: ['xray:PutTraceSegments', 'xray:PutSpans', 'xray:PutSpansForIndexing'],
          resources: ['*'],
        }),
      );
    }

    // The container reads config.json for everything else; only a deploy
    // output needs to travel as an env var.
    const environmentVariables: Record<string, string> = {};
    if (webSearch) {
      environmentVariables.WEB_SEARCH_GATEWAY_URL = this.addWebSearchGateway(role);
    }

    const runtime = new CfnRuntime(this, 'HarnessRuntime', {
      agentRuntimeName: 'harness',
      description: 'Minimal Strands code agent on AgentCore',
      roleArn: role.roleArn,
      agentRuntimeArtifact: { containerConfiguration: { containerUri } },
      networkConfiguration: { networkMode: 'PUBLIC' },
      protocolConfiguration: 'HTTP',
      environmentVariables,
      lifecycleConfiguration: { idleRuntimeSessionTimeout: IDLE_TIMEOUT_SECONDS },
    });

    this.runtimeArn = runtime.attrAgentRuntimeArn;

    new CfnOutput(this, 'RuntimeArn', { value: this.runtimeArn });
  }

  // An AgentCore Gateway with the AWS-managed `web-search` connector as its
  // only target. The gateway authenticates callers with IAM, so the runtime
  // role just needs InvokeGateway on it - no API key anywhere. Returns the
  // gateway URL the agent's web_search tool posts to.
  private addWebSearchGateway(runtimeRole: Role): string {
    const { region, account } = Stack.of(this);

    // The service role the gateway assumes to call the connector. Its trust
    // policy is scoped to gateways in this account; the ARN has to be a
    // pattern because the gateway doesn't exist yet when the role is made.
    const gatewayRole = new Role(this, 'WebSearchGatewayRole', {
      assumedBy: new ServicePrincipal(AGENTCORE_PRINCIPAL, {
        conditions: {
          StringEquals: { 'aws:SourceAccount': account },
          ArnLike: { 'aws:SourceArn': `arn:aws:bedrock-agentcore:${region}:${account}:gateway/*` },
        },
      }),
      description: 'Assumed by the harness web search gateway to call the managed connector.',
    });
    gatewayRole.addToPolicy(
      new PolicyStatement({
        actions: ['bedrock-agentcore:InvokeWebSearch'],
        resources: [`arn:aws:bedrock-agentcore:${region}:aws:tool/web-search.v1`],
      }),
    );
    gatewayRole.addToPolicy(
      new PolicyStatement({
        actions: ['bedrock-agentcore:InvokeGateway'],
        resources: [`arn:aws:bedrock-agentcore:${region}:${account}:gateway/*`],
      }),
    );

    const gateway = new CfnGateway(this, 'WebSearchGateway', {
      name: 'harness-web-search',
      authorizerType: 'AWS_IAM',
      protocolType: 'MCP',
      protocolConfiguration: { mcp: { supportedVersions: ['2025-03-26'] } },
      roleArn: gatewayRole.roleArn,
    });
    // Target name is part of the tool name the agent calls: web-search___WebSearch.
    new CfnGatewayTarget(this, 'WebSearchTarget', {
      gatewayIdentifier: gateway.attrGatewayIdentifier,
      name: 'web-search',
      targetConfiguration: {
        mcp: {
          connector: {
            source: { connectorId: 'web-search' },
            configurations: [{ name: 'WebSearch', parameterValues: {} }],
          },
        },
      },
      credentialProviderConfigurations: [{ credentialProviderType: 'GATEWAY_IAM_ROLE' }],
    });

    runtimeRole.addToPolicy(
      new PolicyStatement({
        actions: ['bedrock-agentcore:InvokeGateway'],
        resources: [gateway.attrGatewayArn],
      }),
    );

    new CfnOutput(this, 'WebSearchGatewayUrl', { value: gateway.attrGatewayUrl });
    return gateway.attrGatewayUrl;
  }
}
