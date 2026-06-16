#!/usr/bin/env node
import { readFileSync } from 'node:fs';

import { App } from 'aws-cdk-lib';

import { RuntimeStack } from '../lib/runtime-stack';

const app = new App();

// Hardcoded - every resource lives in eu-north-1. We do NOT honour
// AWS_REGION / CDK_DEFAULT_REGION, because a stale shell env can silently
// misroute a deploy to a neighbouring region.
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: 'eu-north-1',
};

const REPO_NAME = 'harness';
const BEDROCK_MODEL_ID =
  (app.node.tryGetContext('bedrockModelId') as string | undefined) ??
  'global.anthropic.claude-opus-4-8';

// The Makefile builds + pushes the image and writes its content-hash tag to
// a JSON file, then passes the path via context. Without it there's no image
// to point the runtime at, so we skip the stack.
const imageTagsFile = app.node.tryGetContext('imageTagsFile') as string | undefined;
if (!imageTagsFile) {
  throw new Error('imageTagsFile context not set - run via `make deploy`, not raw cdk');
}
const { imageTag } = JSON.parse(readFileSync(imageTagsFile, 'utf8')) as { imageTag: string };

new RuntimeStack(app, 'Harness-Runtime', {
  env,
  imageTag,
  repoName: REPO_NAME,
  bedrockModelId: BEDROCK_MODEL_ID,
});

app.synth();
