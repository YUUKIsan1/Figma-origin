import type { BrowserWorker } from '@cloudflare/puppeteer';
export interface Env {
  API_RATE_LIMITER: RateLimit;
  AUTH_RATE_LIMITER: RateLimit;
  LOGIN_RATE_LIMITER: RateLimit;
  WRITE_RATE_LIMITER: RateLimit;
  BROWSER: BrowserWorker;
  DB: D1Database;
  IMAGES: R2Bucket;
  ASSETS: Fetcher;
  ADMIN_TOKEN: string;
  VIEWER_PASSWORD: string;
  SESSION_SECRET: string;
}
