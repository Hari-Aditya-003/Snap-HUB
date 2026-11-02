import { readFile } from "node:fs/promises";
import { hasValidMediaSignature } from "../lib/uploads.ts";

const baseUrl = process.env.SECURITY_TEST_BASE_URL ?? "http://127.0.0.1:5173";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  console.log(`PASS ${message}`);
}

async function localCredentials() {
  const source = await readFile(new URL("../.env", import.meta.url), "utf8");
  const values = new Map<string, string>();
  for (const line of source.split(/\r?\n/u)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/u);
    if (match) values.set(match[1], match[2]);
  }
  const username = values.get("ADMIN_USERNAME");
  const password = values.get("ADMIN_PASSWORD");
  if (!username || !password) throw new Error("Local admin credentials are missing from .env");
  return { username, password };
}

function formHeaders(ip: string) {
  return {
    "Content-Type": "application/x-www-form-urlencoded",
    Origin: baseUrl,
    "CF-Connecting-IP": ip,
  };
}

const home = await fetch(baseUrl, { redirect: "manual" });
check(home.status === 200, "home page responds successfully");
for (const header of [
  "content-security-policy",
  "strict-transport-security",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
  "permissions-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
]) {
  check(Boolean(home.headers.get(header)), `${header} header is present`);
}
const csp = home.headers.get("content-security-policy") ?? "";
check(csp.includes("object-src 'none'"), "CSP blocks browser plugins");
check(csp.includes("frame-ancestors 'none'"), "CSP blocks clickjacking");
check(!csp.includes("unsafe-eval"), "CSP does not allow eval");

const unauthAlbums = await fetch(`${baseUrl}/api/albums`, { redirect: "manual" });
check(unauthAlbums.status === 401, "album data rejects unauthenticated access");
const unauthDrive = await fetch(`${baseUrl}/api/admin/google-drive/status`, { redirect: "manual" });
check(unauthDrive.status === 401, "Google Drive connection details reject unauthenticated access");
check(!unauthAlbums.headers.has("access-control-allow-origin"), "protected API does not enable cross-origin reads");

const crossSiteLogin = await fetch(`${baseUrl}/api/admin/login`, {
  method: "POST",
  redirect: "manual",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    Origin: "https://attacker.invalid",
    "Sec-Fetch-Site": "cross-site",
  },
  body: new URLSearchParams({ username: "attacker", password: "attacker" }),
});
check(crossSiteLogin.status === 403, "cross-site mutation is blocked");

const invalidLogin = await fetch(`${baseUrl}/api/admin/login`, {
  method: "POST",
  redirect: "manual",
  headers: formHeaders("198.51.100.10"),
  body: new URLSearchParams({ username: "wrong", password: "wrong" }),
});
check(invalidLogin.status === 303 && invalidLogin.headers.get("location")?.includes("invalid-login"), "invalid admin login is rejected generically");

const rateIp = `198.51.100.${20 + Math.floor(Math.random() * 180)}`;
let limited = false;
for (let attempt = 0; attempt < 11; attempt += 1) {
  const response = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: formHeaders(rateIp),
    body: new URLSearchParams({ username: "wrong", password: "wrong" }),
  });
  limited = response.headers.get("location")?.includes("too-many-attempts") ?? false;
}
check(limited, "admin brute-force attempts are rate limited in durable storage");

const credentials = await localCredentials();
const login = await fetch(`${baseUrl}/api/admin/login`, {
  method: "POST",
  redirect: "manual",
  headers: formHeaders(`203.0.113.${20 + Math.floor(Math.random() * 180)}`),
  body: new URLSearchParams(credentials),
});
check(login.status === 303 && login.headers.get("location")?.endsWith("/admin"), "valid admin login creates a session");
const setCookie = login.headers.get("set-cookie") ?? "";
check(setCookie.includes("HttpOnly") && setCookie.toLowerCase().includes("samesite=lax"), "admin session cookie is HttpOnly and SameSite protected");
const cookie = setCookie.split(";", 1)[0];
check(Boolean(cookie), "admin session cookie was issued");

const authenticatedAlbums = await fetch(`${baseUrl}/api/albums`, { headers: { Cookie: cookie } });
check(authenticatedAlbums.status === 200, "valid admin session can access protected data");
const [cookieName, cookieValue] = cookie.split("=", 2);
const tamperedValue = `${cookieValue.slice(0, -1)}${cookieValue.endsWith("0") ? "1" : "0"}`;
const tampered = await fetch(`${baseUrl}/api/albums`, { headers: { Cookie: `${cookieName}=${tamperedValue}` } });
check(tampered.status === 401, "tampered session signature is rejected");

const invalidOAuthState = await fetch(`${baseUrl}/api/admin/google-drive/callback?state=attacker&code=attacker`, {
  redirect: "manual",
  headers: { Cookie: cookie },
});
check(invalidOAuthState.status === 303 && invalidOAuthState.headers.get("location")?.includes("drive=invalid-state"), "OAuth callback rejects forged state");

const crossSiteLogout = await fetch(`${baseUrl}/api/admin/logout`, {
  method: "POST",
  redirect: "manual",
  headers: { Cookie: cookie, Origin: "https://attacker.invalid", "Sec-Fetch-Site": "cross-site" },
});
check(crossSiteLogout.status === 403, "cross-site logout is blocked");

const fakeJpeg = new File([new TextEncoder().encode("<script>alert(1)</script>")], "attack.jpg", { type: "image/jpeg" });
const realJpegHeader = new File([Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])], "photo.jpg", { type: "image/jpeg" });
const disguisedSvg = new File([new TextEncoder().encode("<svg onload=alert(1)></svg>")], "attack.png", { type: "image/png" });
check(!(await hasValidMediaSignature(fakeJpeg)), "spoofed JPEG upload is rejected");
check(await hasValidMediaSignature(realJpegHeader), "valid JPEG signature is accepted");
check(!(await hasValidMediaSignature(disguisedSvg)), "active-content file disguised as PNG is rejected");

console.log("Security smoke suite completed successfully.");
