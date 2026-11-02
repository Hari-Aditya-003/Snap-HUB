import "server-only";

import { env } from "cloudflare:workers";
import { cookies } from "next/headers";

const encoder = new TextEncoder();
const ADMIN_COOKIE = "veyra_admin";

export function getSessionSecret() {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters.");
  }
  return env.SESSION_SECRET;
}

function toHex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function hmac(value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(getSessionSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

function fromHex(value: string) {
  if (!/^[0-9a-f]+$/iu.test(value) || value.length % 2 !== 0) return null;
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

export async function secureEqual(left: string, right: string) {
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) difference |= leftBytes[index] ^ rightBytes[index];
  return difference === 0;
}

async function verifySignedValue(value: string | undefined, expectedPrefix: string) {
  if (!value) return false;
  const [prefix, expires, signature] = value.split(".");
  if (prefix !== expectedPrefix || !expires || !signature) return false;
  if (Number(expires) < Date.now()) return false;
  const signatureBytes = fromHex(signature);
  if (!signatureBytes) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(getSessionSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, signatureBytes, encoder.encode(`${prefix}.${expires}`));
}

export async function createAdminSession() {
  const expires = String(Date.now() + 1000 * 60 * 60 * 12);
  return `admin.${expires}.${await hmac(`admin.${expires}`)}`;
}

export async function isAdmin() {
  const jar = await cookies();
  return verifySignedValue(jar.get(ADMIN_COOKIE)?.value, "admin");
}

export function adminCookieName() {
  return ADMIN_COOKIE;
}

export async function createGallerySession(albumId: string) {
  const expires = String(Date.now() + 1000 * 60 * 60 * 24 * 14);
  return `${albumId}.${expires}.${await hmac(`${albumId}.${expires}`)}`;
}

export async function hasGallerySession(albumId: string) {
  const jar = await cookies();
  return verifySignedValue(jar.get(`veyra_gallery_${albumId}`)?.value, albumId);
}

export async function canViewGallery(album: { id: string; status: string; access_mode: string }) {
  if (await isAdmin()) return true;
  if (album.status !== "live") return false;
  if (album.access_mode === "link") return true;
  return hasGallerySession(album.id);
}

export async function hashGuestPassword(albumId: string, password: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`${albumId}:${password}`),
  );
  return toHex(digest);
}

export function randomCode(length = 8) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}
