declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    ADMIN_USERNAME: string;
    ADMIN_PASSWORD: string;
    SESSION_SECRET: string;
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_SECRET: string;
    /** Local-only: serve generated sample-gallery media (never set in production). */
    SAMPLE_MEDIA?: string;
    SNAP_HUB_FAKE_DRIVE?: string;
  }
}
