import type { BrowserWorker } from '@cloudflare/puppeteer';
export interface Env {
  BROWSER: BrowserWorker;
  DB: D1Database;
  IMAGES: R2Bucket;
  ASSETS: Fetcher;
  ADMIN_TOKEN: string;
  VIEWER_PASSWORD: string;
  SESSION_SECRET: string;
}
