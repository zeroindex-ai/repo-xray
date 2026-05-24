-- Remove the unused rate_limit_buckets table. It came from the service scaffold
-- (a token-bucket limiter), but repo-xray gates the analyze endpoint with the
-- per-client daily cap + global daily-$ ceiling in request_counts (0002) instead,
-- so the table and its src/lib/rateLimit.ts helper were dead. Append-only: 0001
-- still records that it once existed.
DROP TABLE IF EXISTS rate_limit_buckets;
