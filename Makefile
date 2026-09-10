.PHONY: help install typecheck deploy destroy invoke logs ecr.create build.push observability.enable

# config.json is the single source of truth for region and feature switches.
REGION       := $(shell node -p "require('./config.json').region")
REPO_NAME    := harness
STACK        := Harness-Runtime

ACCOUNT  = $(shell aws sts get-caller-identity --query Account --output text)
REGISTRY = $(ACCOUNT).dkr.ecr.$(REGION).amazonaws.com

CDK       := $(CURDIR)/cdk/node_modules/.bin/cdk
TAGS_FILE := /tmp/harness-image-tag.json
# Files whose content determines the image tag - change any, get a new tag.
HASH_INPUTS := src skills config.json Dockerfile package.json package-lock.json

help:
	@echo "Setup:"
	@echo "  make install     Install root + cdk deps"
	@echo "  make typecheck   tsc --noEmit"
	@echo ""
	@echo "Deploy (region from config.json):"
	@echo "  make deploy                Build + push the image, then cdk deploy"
	@echo "  make destroy               Tear down the stack"
	@echo "  make observability.enable  One-time: turn on CloudWatch Transaction Search (100% indexing)"
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
	  echo "image already in ECR - skipping build"; \
	else \
	  aws ecr get-login-password --region $(REGION) | docker login --username AWS --password-stdin $(REGISTRY); \
	  docker buildx build --platform linux/arm64 -t $$IMAGE --push .; \
	fi; \
	echo "{\"imageTag\":\"$$TAG\"}" > $(TAGS_FILE); \
	echo "wrote $(TAGS_FILE)"

# Settings live in config.json, not in flags. CDK_ARGS is only for passing
# raw cdk options through if you ever need to.
deploy: build.push
	cd cdk && npm install --silent
	cd cdk && $(CDK) deploy --all --require-approval never -c imageTagsFile=$(TAGS_FILE) $(CDK_ARGS)

destroy:
	cd cdk && $(CDK) destroy --all --force -c imageTagsFile=$(TAGS_FILE)

# ---------------------------------------------------------------------------
# Observability (one-time, per account and region)
# ---------------------------------------------------------------------------
# Spans exported by the runtime land in X-Ray. CloudWatch Transaction Search
# turns them into structured logs in the aws/spans log group, which is what
# the CloudWatch GenAI Observability console reads. Three account-level
# settings: let X-Ray write to CloudWatch Logs, point X-Ray at CloudWatch
# Logs, and index 100% of spans so every session shows up (the default is a
# sample). Not part of the stack on purpose: it's shared by every agent in
# the account and region, so destroying one stack shouldn't turn it off.
observability.enable:
	@aws logs put-resource-policy --region $(REGION) --policy-name TransactionSearchXRayAccess --policy-document \
	  '{"Version":"2012-10-17","Statement":[{"Sid":"TransactionSearchXRayAccess","Effect":"Allow","Principal":{"Service":"xray.amazonaws.com"},"Action":"logs:PutLogEvents","Resource":["arn:aws:logs:$(REGION):$(ACCOUNT):log-group:aws/spans:*","arn:aws:logs:$(REGION):$(ACCOUNT):log-group:/aws/application-signals/data:*"],"Condition":{"ArnLike":{"aws:SourceArn":"arn:aws:xray:$(REGION):$(ACCOUNT):*"},"StringEquals":{"aws:SourceAccount":"$(ACCOUNT)"}}}]}' >/dev/null
	@aws xray update-trace-segment-destination --region $(REGION) --destination CloudWatchLogs 2>/dev/null || echo "trace destination already CloudWatchLogs"
	aws xray update-indexing-rule --region $(REGION) --name Default --rule '{"Probabilistic":{"DesiredSamplingPercentage":100}}'
	@echo "Transaction Search on in $(REGION), indexing 100% of spans. Activation can take a few minutes."
	@echo "Traces: CloudWatch > GenAI Observability."

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
	@SID="$(SESSION_ID)"; \
	echo "invoking $(RUNTIME_ARN)"; \
	echo "session: $$SID  (first 8: $${SID:0:8})"; \
	aws bedrock-agentcore invoke-agent-runtime --region $(REGION) \
	  --cli-binary-format raw-in-base64-out \
	  --agent-runtime-arn "$(RUNTIME_ARN)" \
	  --runtime-session-id "$$SID" \
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

# Prints the last 30 min, one JSON event per line. `make logs FOLLOW=1` streams live.
FOLLOW ?=
logs:
ifeq ($(FOLLOW),)
	@aws logs tail "$(LOG_GROUP)" --region $(REGION) --since 30m --format short
else
	@aws logs tail "$(LOG_GROUP)" --region $(REGION) --since 30m --format short --follow
endif
