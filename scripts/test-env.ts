// Environment for the test suite: its own database, queue and bucket, so
// tests never touch dev data or compete with running dev workers.
export const TEST_ENV = {
  DATABASE_URL: "postgres://vpp:vpp@localhost:5433/vpp_test",
  SQS_QUEUE_NAME: "jobs-test",
  SQS_DLQ_NAME: "jobs-test-dlq",
  S3_BUCKET: "videos-test",
  MEDIA_BUCKET: "media-test",
  JOB_LEASE_SECONDS: "5",
  RETRY_BASE_MS: "50",
  RETRY_MAX_MS: "200",
  RECONCILE_STALE_PENDING_SECONDS: "1",
  WORKER_HEARTBEAT_MS: "100",
};
