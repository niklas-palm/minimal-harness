// AgentCore CfnRuntime for the harness - the agent container plus the IAM
// role it runs as. That's the whole stack: no memory, no OAuth, no trigger
// Lambda. You invoke the runtime directly via the API (see the Makefile).
import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import { CfnRuntime } from 'aws-cdk-lib/aws-bedrockagentcore';
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
  /** Bedrock model id used by the agent (cross-region inference profile). */
  readonly bedrockModelId: string;
}

export class RuntimeStack extends Stack {
  public readonly runtimeArn: string;

  constructor(scope: Construct, id: string, props: RuntimeStackProps) {
    super(scope, id, props);

    const { region, account } = Stack.of(this);
    const { imageTag, repoName, bedrockModelId } = props;

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

    const runtime = new CfnRuntime(this, 'HarnessRuntime', {
      agentRuntimeName: 'harness',
      description: 'Minimal Strands code agent on AgentCore',
      roleArn: role.roleArn,
      agentRuntimeArtifact: { containerConfiguration: { containerUri } },
      networkConfiguration: { networkMode: 'PUBLIC' },
      protocolConfiguration: 'HTTP',
      environmentVariables: {
        BEDROCK_MODEL_ID: bedrockModelId,
      },
      lifecycleConfiguration: { idleRuntimeSessionTimeout: IDLE_TIMEOUT_SECONDS },
    });

    this.runtimeArn = runtime.attrAgentRuntimeArn;

    new CfnOutput(this, 'RuntimeArn', { value: this.runtimeArn });
  }
}
