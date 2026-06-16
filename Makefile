.PHONY: help install typecheck deploy destroy invoke logs ecr.create build.push

REGION       := eu-north-1
REPO_NAME    := harness
STACK        := Harness-Runtime

ACCOUNT  = $(shell aws sts get-caller-identity --query Account --output text)
REGISTRY = $(ACCOUNT).dkr.ecr.$(REGION).amazonaws.com

CDK       := $(CURDIR)/cdk/node_modules/.bin/cdk
TAGS_FILE := /tmp/harness-image-tag.json
# Files whose content determines the image tag — change any, get a new tag.
HASH_INPUTS := src skills Dockerfile package.json package-lock.json

help:
	@echo "Setup:"
	@echo "  make install     Install root + cdk deps"
	@echo "  make typecheck   tsc --noEmit"
	@echo ""
	@echo "Deploy (eu-north-1):"
	@echo "  make deploy      Build + push the image, then cdk deploy"
	@echo "  make destroy     Tear down the stack"
	@echo ""
	@echo "Run:"
	@echo "  make invoke PROMPT='what is 2+2? show your working'"
	@echo "  make logs        Tail the runtime's CloudWatch logs"

install:
	npm install
	cd cdk && npm install

typecheck:
	npx tsc --noEmit

# ---------------------------------------------------------------------------
# Deploy
# ---------------------------------------------------------------------------

ecr.create:
	@aws ecr describe-repositories --region $(REGION) --repository-names $(REPO_NAME) >/dev/null 2>&1 \
	  || aws ecr create-repository --region $(REGION) --repository-name $(REPO_NAME) >/dev/null
	@echo "ECR repo $(REPO_NAME) ready"

IMAGE_TAG = $(shell find $(HASH_INPUTS) -type f -print0 2>/dev/null | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -c1-12)

build.push: ecr.create
	@TAG=$(IMAGE_TAG); \
	IMAGE=$(REGISTRY)/$(REPO_NAME):$$TAG; \
	echo "tag: $$TAG"; \
	if aws ecr describe-images --region $(REGION) --repository-name $(REPO_NAME) --image-ids imageTag=$$TAG >/dev/null 2>&1; then \
	  echo "image already in ECR — skipping build"; \
	else \
	  aws ecr get-login-password --region $(REGION) | docker login --username AWS --password-stdin $(REGISTRY); \
	  docker buildx build --platform linux/arm64 -t $$IMAGE --push .; \
	fi; \
	echo "{\"imageTag\":\"$$TAG\"}" > $(TAGS_FILE); \
	echo "wrote $(TAGS_FILE)"

# CDK_ARGS passes extra flags/context through, e.g.
#   make deploy CDK_ARGS='-c bedrockModelId=global.anthropic.claude-sonnet-4-6'
deploy: build.push
	cd cdk && npm install --silent
	cd cdk && $(CDK) deploy --all --require-approval never -c imageTagsFile=$(TAGS_FILE) $(CDK_ARGS)

destroy:
	cd cdk && $(CDK) destroy --all --force -c imageTagsFile=$(TAGS_FILE)

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

RUNTIME_ARN = $(shell aws cloudformation describe-stacks --region $(REGION) \
	--stack-name $(STACK) --query "Stacks[0].Outputs[?OutputKey=='RuntimeArn'].OutputValue" --output text)
# AgentCore requires a session id of 33+ chars; a UUID with the dashes
# stripped and doubled is plenty.
SESSION_ID = $(shell uuidgen | tr -d - | tr A-Z a-z)$(shell uuidgen | tr -d - | tr A-Z a-z)
PROMPT ?= Say hello and tell me what tools you have.

invoke:
	@echo "invoking $(RUNTIME_ARN)"
	@aws bedrock-agentcore invoke-agent-runtime --region $(REGION) \
	  --cli-binary-format raw-in-base64-out \
	  --agent-runtime-arn "$(RUNTIME_ARN)" \
	  --runtime-session-id "$(SESSION_ID)" \
	  --content-type application/json \
	  --payload '{"prompt":"$(PROMPT)"}' \
	  /dev/stdout
	@echo
	@echo "agent runs asynchronously, the call returns 'accepted'. watch 'make logs'"
	@echo "for progress and the final answer (CloudWatch can lag a minute on a cold runtime)."

# The runtime's log group is keyed by its full id (e.g. harness-1ugjfL3pFs),
# which we pull out of the ARN. `aws logs tail` needs the exact group name.
RUNTIME_ID = $(shell echo "$(RUNTIME_ARN)" | sed 's|.*runtime/||')
LOG_GROUP  = /aws/bedrock-agentcore/runtimes/$(RUNTIME_ID)-DEFAULT

logs:
	@aws logs tail "$(LOG_GROUP)" --region $(REGION) --since 10m --follow \
	  | python3 scripts/format-logs.py
