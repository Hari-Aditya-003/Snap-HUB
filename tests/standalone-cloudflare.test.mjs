import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(import.meta.dirname, "..");
const builtConfig = join(root, "dist/server/wrangler.json");
const wrangler = join(root, "node_modules/wrangler/bin/wrangler.js");
let server;
let state;
let origin;

before(async () => {
  assert.ok(existsSync(join(root, "wrangler.json")), "Standalone Wrangler config is required");
  assert.ok(existsSync(builtConfig), "Build the Worker before running integration tests");
  state = mkdtempSync(join(tmpdir(), "snap-hub-cloudflare-test-"));
  const migration = spawnSync(process.execPath, [wrangler, "d1", "migrations", "apply", "DB",
    "--local", "--config", join(root, "wrangler.json"), "--persist-to", state],
  { cwd: root, encoding: "utf8", timeout: 60_000, env: { ...process.env, CI: "true" } });
  assert.equal(migration.status, 0, "Local migrations must succeed for an independent database");

  const socket = createServer();
  await new Promise((done, reject) => socket.listen(0, "127.0.0.1", done).once("error", reject));
  const port = socket.address().port;
  await new Promise((done) => socket.close(done));
  origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [wrangler, "dev", "--local", "--config", builtConfig,
    "--persist-to", state, "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0",
    "--var", "ADMIN_USERNAME:standalone-test", "--var", "ADMIN_PASSWORD:test-only-password",
    "--var", "SESSION_SECRET:test-only-session-secret-with-at-least-32-characters"],
  { cwd: root, stdio: "ignore", detached: process.platform !== "win32", env: { ...process.env, CI: "true" } });

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error("Local Worker exited before accepting requests");
    try {
      const response = await fetch(`${origin}/api/albums`, { signal: AbortSignal.timeout(1000) });
      if (response.status === 401) return;
    } catch { /* The local Worker is still starting. */ }
    await delay(250);
  }
  throw new Error("Local Worker did not become ready within 45 seconds");
}, { timeout: 120_000 });

after(async () => {
  if (server && server.exitCode === null) {
    const stopped = new Promise((done) => server.once("exit", done));
    if (process.platform === "win32") server.kill("SIGTERM");
    else process.kill(-server.pid, "SIGTERM");
    await stopped;
  }
  if (state) rmSync(state, { recursive: true, force: true });
});

test("deployment artifact contains D1 migrations and needs no Sites bindings", () => {
  const config = JSON.parse(readFileSync(builtConfig, "utf8"));
  const db = config.d1_databases.find((database) => database.binding === "DB");
  assert.ok(db, "The DB binding must be present");
  assert.ok(existsSync(resolve(dirname(builtConfig), db.migrations_dir, "0000_shiny_epoch.sql")),
    "Generated deployment config must locate the committed SQL migrations");
  assert.equal(config.services?.some((service) => service.binding === "CONNECTORS") ?? false, false);
  assert.equal(existsSync(join(root, "dist/.openai")), false);
});

test("public website loads directly from the Cloudflare Worker", async () => {
  const response = await fetch(origin);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Snap HUB/);
  assert.ok(response.headers.get("content-security-policy"));
});

test("Sites identity headers cannot authorize access to private albums", async () => {
  const response = await fetch(`${origin}/api/albums`, {
    headers: { "oai-authenticated-user-id": "pretend-owner" },
  });
  assert.equal(response.status, 401);
});

test("invalid host credentials are rejected without creating a session", async () => {
  const response = await fetch(`${origin}/api/admin/login`, {
    method: "POST", redirect: "manual",
    body: new URLSearchParams({ username: "standalone-test", password: "incorrect" }),
  });
  assert.equal(response.status, 303);
  assert.equal(new URL(response.headers.get("location"), origin).searchParams.get("error"), "invalid-login");
  assert.equal(response.headers.get("set-cookie"), null);
});

test("host login and D1-backed album listing work without ChatGPT", async () => {
  const login = await fetch(`${origin}/api/admin/login`, {
    method: "POST", redirect: "manual",
    body: new URLSearchParams({ username: "standalone-test", password: "test-only-password" }),
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie");
  assert.ok(cookie?.includes("HttpOnly"));
  const response = await fetch(`${origin}/api/albums`, { headers: { cookie: cookie.split(";")[0] } });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.albums, []);
  assert.deepEqual(data.photos, []);
  assert.deepEqual(data.collections, []);
});
