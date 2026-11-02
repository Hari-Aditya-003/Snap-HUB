const allowedTypes = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif",
  "video/mp4", "video/quicktime", "video/webm",
]);
const allowedExtensions = new Set(["jpg", "jpeg", "png", "webp", "gif", "heic", "heif", "mp4", "mov", "webm"]);

export function isAllowedMedia(file: File) {
  const extension = file.name.toLowerCase().split(".").pop() ?? "";
  return allowedTypes.has(file.type.toLowerCase()) && allowedExtensions.has(extension);
}

function startsWith(bytes: Uint8Array, signature: number[]) {
  return signature.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes: Uint8Array, start: number, length: number) {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

export async function hasValidMediaSignature(file: File) {
  if (!isAllowedMedia(file)) return false;
  const bytes = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const type = file.type.toLowerCase();
  if (type === "image/jpeg") return startsWith(bytes, [0xff, 0xd8, 0xff]);
  if (type === "image/png") return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (type === "image/gif") return ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a";
  if (type === "image/webp") return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP";
  if (type === "video/webm") return startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]);
  if (type === "video/mp4" || type === "video/quicktime") return ascii(bytes, 4, 4) === "ftyp";
  if (type === "image/heic" || type === "image/heif") {
    const brand = ascii(bytes, 8, 4);
    return ascii(bytes, 4, 4) === "ftyp" && ["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand);
  }
  return false;
}
