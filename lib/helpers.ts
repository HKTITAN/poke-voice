import { ElevenLabsError } from "./elevenlabs.js";

export type AudioInput = {
  audio_url?: string;
  audio_base64?: string;
  filename?: string;
};

export async function loadAudio(input: AudioInput): Promise<{
  buffer: Buffer;
  filename: string;
  contentType: string;
}> {
  if (!input.audio_url && !input.audio_base64) {
    throw new Error("Provide either audio_url or audio_base64.");
  }
  if (input.audio_url && input.audio_base64) {
    throw new Error("Provide only one of audio_url or audio_base64.");
  }
  if (input.audio_url) {
    const res = await fetch(input.audio_url);
    if (!res.ok) throw new Error(`Failed to fetch audio_url: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") ?? "audio/mpeg";
    const urlName = input.filename ?? input.audio_url.split("/").pop()?.split("?")[0] ?? "audio.mp3";
    return { buffer: buf, filename: urlName, contentType };
  }
  const buf = Buffer.from(input.audio_base64!, "base64");
  return {
    buffer: buf,
    filename: input.filename ?? "audio.mp3",
    contentType: guessContentTypeFromName(input.filename ?? "audio.mp3"),
  };
}

export async function loadFile(input: {
  file_url?: string;
  file_base64?: string;
  filename?: string;
}): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
  if (!input.file_url && !input.file_base64) {
    throw new Error("Provide either file_url or file_base64.");
  }
  if (input.file_url) {
    const res = await fetch(input.file_url);
    if (!res.ok) throw new Error(`Failed to fetch file_url: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const urlName = input.filename ?? input.file_url.split("/").pop()?.split("?")[0] ?? "file.bin";
    return { buffer: buf, filename: urlName, contentType };
  }
  const buf = Buffer.from(input.file_base64!, "base64");
  return {
    buffer: buf,
    filename: input.filename ?? "file.bin",
    contentType: guessContentTypeFromName(input.filename ?? "file.bin"),
  };
}

export function guessContentTypeFromName(name: string): string {
  const ext = name.toLowerCase().split(".").pop();
  const map: Record<string, string> = {
    mp3: "audio/mpeg",
    wav: "audio/wav",
    flac: "audio/flac",
    m4a: "audio/mp4",
    ogg: "audio/ogg",
    opus: "audio/opus",
    webm: "audio/webm",
    pdf: "application/pdf",
    txt: "text/plain",
    html: "text/html",
    epub: "application/epub+zip",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
  return (ext && map[ext]) ?? "application/octet-stream";
}

export function extFromMime(mime: string): string {
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("pcm")) return "pcm";
  if (mime.includes("opus")) return "opus";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("flac")) return "flac";
  return "bin";
}

export function audioResource(params: {
  bytes: ArrayBuffer | Buffer;
  mimeType: string;
  name: string;
}) {
  const buf = Buffer.isBuffer(params.bytes) ? params.bytes : Buffer.from(params.bytes);
  const ext = extFromMime(params.mimeType);
  const uri = `elevenlabs://${params.name}.${ext}`;
  return {
    type: "resource" as const,
    resource: {
      uri,
      mimeType: params.mimeType,
      blob: buf.toString("base64"),
    },
  };
}

export function textContent(text: string) {
  return { type: "text" as const, text };
}

export function handleError(err: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  let msg: string;
  if (err instanceof ElevenLabsError) {
    msg = `ElevenLabs API error ${err.status}: ${
      typeof err.body === "string" ? err.body : JSON.stringify(err.body)
    }`;
  } else if (err instanceof Error) {
    msg = err.message;
  } else {
    msg = String(err);
  }
  return {
    content: [{ type: "text", text: msg }],
    isError: true,
  };
}

export function requireApiKey(token: string | undefined): string {
  const key = token && token.trim() ? token.trim() : process.env.ELEVENLABS_API_KEY;
  if (!key) {
    throw new Error(
      "Missing ElevenLabs API key. Pass it as the Bearer token in the Authorization header (via Poke's MCP auth field) or set the ELEVENLABS_API_KEY env var.",
    );
  }
  return key;
}

export function slug(s: string, max = 24): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, max) || "out";
}

export function timestampTag(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(
    d.getUTCHours(),
  )}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

export function mimeFromOutputFormat(fmt: string): string {
  if (fmt.startsWith("mp3")) return "audio/mpeg";
  if (fmt.startsWith("pcm")) return "audio/pcm";
  if (fmt.startsWith("ulaw")) return "audio/basic";
  if (fmt.startsWith("alaw")) return "audio/x-alaw-basic";
  if (fmt.startsWith("opus")) return "audio/opus";
  return "application/octet-stream";
}

export async function buildMultipart(fields: Record<string, string | { buffer: Buffer; filename: string; contentType: string } | undefined>): Promise<{
  body: Buffer;
  contentType: string;
}> {
  const boundary = `----pokevoice${Math.random().toString(36).slice(2)}${Date.now()}`;
  const parts: Buffer[] = [];
  const CRLF = "\r\n";
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(Buffer.from(`--${boundary}${CRLF}`));
    if (typeof value === "string") {
      parts.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`,
        ),
      );
    } else {
      parts.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${name}"; filename="${value.filename}"${CRLF}Content-Type: ${value.contentType}${CRLF}${CRLF}`,
        ),
      );
      parts.push(value.buffer);
      parts.push(Buffer.from(CRLF));
    }
  }
  parts.push(Buffer.from(`--${boundary}--${CRLF}`));
  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
