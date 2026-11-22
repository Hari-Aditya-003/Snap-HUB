import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(import.meta.dirname, "..", "..");
const builtConfig = join(root, "dist", "server", "wrangler.json");
const wrangler = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const migrationsDir = join(root, "drizzle");

export type LocalWorker = {
  origin: string;
  adminUsername: string;
  adminPassword: string;
  stop: () => Promise<void>;
};

type LocalWorkerOptions = {
  /** Extra SQL statements applied to the throwaway D1 database after migrations. */
  seedSql?: string;
  /** Extra `--var NAME:VALUE` pairs passed to `wrangler dev`. */
  vars?: Record<string, string>;
};

const workerEnv = () => ({ ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" });

/**
 * Boots the production Worker build against an isolated local D1 database.
 * This mirrors tests/standalone-cloudflare.test.mjs: schema and fixture rows
 * land in a temp `--persist-to` directory, then `wrangler dev` serves the app
 * on a random 127.0.0.1 port. `SNAP_HUB_FAKE_DRIVE=1` keeps every Google Drive
 * call inside the local runtime, so no Google account or outbound network
 * access is needed.
 */
export async function startLocalWorker(options: LocalWorkerOptions = {}): Promise<LocalWorker> {
  assert.ok(existsSync(builtConfig), "Run `npm run build` before the browser suite (npm run test:browser does this)");
  const state = mkdtempSync(join(tmpdir(), "snap-hub-browser-test-"));
  let server: ChildProcess | null = null;
  const stop = async () => {
    if (server && server.exitCode === null && server.pid) {
      const stopped = new Promise((done) => server!.once("exit", done));
      if (process.platform === "win32") {
        // `wrangler dev` spawns workerd.exe children that keep D1 sqlite files
        // locked. SIGTERM on Windows only reaches the node process, so kill
        // the whole tree before removing the state directory.
        spawnSync("taskkill", ["/pid", String(server.pid), "/t", "/f"], { stdio: "ignore" });
      } else {
        process.kill(-server.pid, "SIGTERM");
      }
      await Promise.race([stopped, delay(15_000)]);
    }
    // File locks can outlive the process briefly on Windows; retry and never
    // let cleanup failure hide the real test result.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        rmSync(state, { recursive: true, force: true });
        return;
      } catch {
        await delay(500);
      }
    }
    console.warn(`Could not remove temporary state directory ${state}; leaving it behind.`);
  };

  try {
    // Apply every committed migration plus the fixture rows through a single
    // `d1 execute`. Each wrangler CLI invocation boots workerd, so one combined
    // file is much faster than `migrations apply` plus a separate seed, and
    // the app never reads wrangler's migration bookkeeping table.
    const migrationSql = readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql"))
      .sort()
      .map((file) => readFileSync(join(migrationsDir, file), "utf8"))
      .join("\n");
    const fixtureSql = join(state, "fixture.sql");
    writeFileSync(fixtureSql, `${migrationSql}\n${options.seedSql ?? ""}\n`);
    const seed = spawnSync(process.execPath, [wrangler, "d1", "execute", "DB", "--local",
      "--config", join(root, "wrangler.json"), "--persist-to", state, "--file", fixtureSql],
    { cwd: root, encoding: "utf8", timeout: 120_000, env: workerEnv() });
    assert.equal(seed.status, 0, `The isolated database fixture must be created:\n${seed.stderr}`);

    const vars = {
      ADMIN_USERNAME: "browser-test-admin",
      ADMIN_PASSWORD: "browser-test-only-password",
      SESSION_SECRET: "browser-test-session-secret-with-at-least-32-characters",
      SNAP_HUB_FAKE_DRIVE: "1",
      ...options.vars,
    };
    server = spawn(process.execPath, [wrangler, "dev", "--local", "--config", builtConfig,
      "--persist-to", state, "--ip", "127.0.0.1", "--port", "0", "--inspector-port", "0",
      ...Object.entries(vars).flatMap(([name, value]) => ["--var", `${name}:${value}`])],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", env: workerEnv() });

    let origin = "";
    let startup = "";
    const readStartup = (chunk: Buffer) => {
      // Wrangler decorates the ready line with ANSI colors even when piped.
      startup = (startup + chunk.toString().replace(/\u001b\[[0-9;]*m/g, "")).slice(-16384);
      const match = startup.match(/Ready on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) origin = match[1];
    };
    server.stdout!.on("data", readStartup);
    server.stderr!.on("data", readStartup);

    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`Local Worker exited before accepting requests:\n${startup}`);
      if (origin) {
        try {
          const response = await fetch(`${origin}/api/albums`, { signal: AbortSignal.timeout(1500) });
          // Any HTTP response means the Worker is accepting requests; the
          // specs themselves assert the seeded data loads correctly.
          if (response.status < 600) {
            return {
              origin,
              adminUsername: vars.ADMIN_USERNAME,
              adminPassword: vars.ADMIN_PASSWORD,
              stop,
            };
          }
        } catch { /* The local Worker is still starting. */ }
      }
      await delay(250);
    }
    throw new Error(`Local Worker did not become ready within 90 seconds:\n${startup}`);
  } catch (error) {
    await stop();
    throw error;
  }
}
