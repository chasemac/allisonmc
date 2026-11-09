const TYPES = [
  {
    contentType: "image/png",
    sniff(bytes) {
      return bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    },
  },
  {
    contentType: "image/jpeg",
    sniff(bytes) {
      return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    },
  },
  {
    contentType: "image/webp",
    sniff(bytes) {
      return (
        bytes.length > 12 &&
        bytes.toString("ascii", 0, 4) === "RIFF" &&
        bytes.toString("ascii", 8, 12) === "WEBP"
      );
    },
  },
  {
    contentType: "application/pdf",
    sniff(bytes) {
      return bytes.length > 5 && bytes.toString("ascii", 0, 5) === "%PDF-";
    },
  },
];

export const ALLOWED_MEDIA_TYPES = new Set([
  ...TYPES.map((type) => type.contentType),
  "text/html",
  "model/vnd.collada+xml",
]);
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

export function detectMedia(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length === 0 || buffer.length > MAX_MEDIA_BYTES) return null;
  const head = buffer.subarray(0, 64).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<") || head.startsWith("<?xml") || head.includes("<svg") || head.includes("<script")) {
    return null;
  }
  for (const type of TYPES) {
    if (type.sniff(buffer)) return { contentType: type.contentType, bytes: buffer };
  }
  return null;
}

export function safeFilename(name) {
  const base = String(name || "download").split(/[/\\]/).pop();
  if (!base || base === "." || base === "..") return null;
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(base)) return null;
  return base;
}
