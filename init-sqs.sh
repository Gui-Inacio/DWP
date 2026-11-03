#!/bin/bash
set -euo pipefail

REGION="us-east-1"
MAIN_QUEUE="wager-transactions.fifo"
DLQ="wager-transactions-dlq.fifo"
MAX_RECEIVE_COUNT=5   # tentativas de entrega antes de ir para a DLQ

# 1) DLQ (FIFO)
DLQ_URL=$(awslocal sqs create-queue \
  --region "$REGION" \
  --queue-name "$DLQ" \
  --attributes FifoQueue=true \
  --query QueueUrl --output text)

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --region "$REGION" \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

# 2) Fila principal (FIFO) com redrive para a DLQ
cat > /tmp/main-queue-attrs.json <<JSON
{
  "FifoQueue": "true",
  "VisibilityTimeout": "30",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"${DLQ_ARN}\",\"maxReceiveCount\":\"${MAX_RECEIVE_COUNT}\"}"
}
JSON

awslocal sqs create-queue \
  --region "$REGION" \
  --queue-name "$MAIN_QUEUE" \
  --attributes file:///tmp/main-queue-attrs.json

echo "SQS pronto: $MAIN_QUEUE (DLQ: $DLQ, maxReceiveCount=$MAX_RECEIVE_COUNT)"
