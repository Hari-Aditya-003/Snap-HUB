import QRCode from "qrcode";

const instructions = {
  gallery: "Scan to open the event gallery",
  upload: "Scan to share your photos and videos",
  slideshow: "Scan to open the live slideshow",
} as const;

export function downloadQrSign({ title, target, mode, slug }: {
  title: string; target: string; mode: keyof typeof instructions; slug: string | null;
}) {
  const canvas = document.createElement("canvas");
  canvas.width = 1600;
  canvas.height = 2000;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable");

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#19101b";
  context.textAlign = "center";
  context.font = "bold 64px system-ui";
  context.fillText("Snap HUB", 800, 174);
  context.font = "bold 104px system-ui";
  context.fillText(title, 800, 385, 1320);
  context.font = "60px system-ui";
  context.fillText(instructions[mode], 800, 505, 1320);

  // Draw integer-sized modules and retain a four-module quiet zone for printing.
  const matrix = QRCode.create(target, { errorCorrectionLevel: "M" }).modules;
  const scale = Math.floor(1120 / (matrix.size + 8));
  const size = matrix.size * scale;
  const originX = Math.floor((canvas.width - size) / 2);
  const originY = 655 + 4 * scale;
  context.fillStyle = "#000000";
  for (let row = 0; row < matrix.size; row += 1) {
    for (let column = 0; column < matrix.size; column += 1) {
      if (matrix.get(row, column)) context.fillRect(originX + column * scale, originY + row * scale, scale, scale);
    }
  }

  const link = document.createElement("a");
  const filename = (slug ?? title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70);
  link.download = `${filename || "snap-hub"}-${mode}-sign.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
}
