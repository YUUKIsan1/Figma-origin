-- Counters now use Workers Rate Limiting bindings and do not consume D1 writes.
DROP TABLE IF EXISTS rate_limits;
