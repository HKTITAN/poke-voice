const BASE = "https://api.elevenlabs.io";

export class ElevenLabsError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `ElevenLabs API error ${status}`);
    this.status = status;
    this.body = body;
  }
}

export type ElevenLabsBody = BodyInit | Buffer | Uint8Array;

export type ElevenLabsRequestInit = {
  method?: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  json?: unknown;
  body?: ElevenLabsBody;
  headers?: Record<string, string>;
  parse?: "json" | "binary" | "text";
};

function toBodyInit(b: ElevenLabsBody | undefined): BodyInit | undefined {
  if (b === undefined) return undefined;
  if (Buffer.isBuffer(b)) {
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength) as unknown as BodyInit;
  }
  return b as BodyInit;
}

function buildUrl(path: string, query?: ElevenLabsRequestInit["query"]): string {
  const url = new URL(path.startsWith("http") ? path : `${BASE}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.append(k, String(v));
    }
  }
  return url.toString();
}

export async function elevenlabs<T = unknown>(
  apiKey: string,
  path: string,
  init: ElevenLabsRequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "xi-api-key": apiKey,
    "User-Agent": "poke-voice/0.1",
    ...(init.headers ?? {}),
  };
  let body: ElevenLabsBody | undefined = init.body;
  if (init.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const res = await fetch(buildUrl(path, init.query), {
    method: init.method ?? (body ? "POST" : "GET"),
    headers,
    body: toBodyInit(body),
  });
  if (!res.ok) {
    let errBody: unknown;
    try {
      errBody = await res.json();
    } catch {
      try {
        errBody = await res.text();
      } catch {
        errBody = null;
      }
    }
    throw new ElevenLabsError(res.status, errBody);
  }
  const parse = init.parse ?? "json";
  if (parse === "binary") return (await res.arrayBuffer()) as unknown as T;
  if (parse === "text") return (await res.text()) as unknown as T;
  return (await res.json()) as T;
}

export async function elevenlabsBinary(
  apiKey: string,
  path: string,
  init: ElevenLabsRequestInit = {},
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const headers: Record<string, string> = {
    "xi-api-key": apiKey,
    "User-Agent": "poke-voice/0.1",
    ...(init.headers ?? {}),
  };
  let body: ElevenLabsBody | undefined = init.body;
  if (init.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const res = await fetch(buildUrl(path, init.query), {
    method: init.method ?? (body ? "POST" : "GET"),
    headers,
    body: toBodyInit(body),
  });
  if (!res.ok) {
    let errBody: unknown;
    try {
      errBody = await res.json();
    } catch {
      errBody = await res.text().catch(() => null);
    }
    throw new ElevenLabsError(res.status, errBody);
  }
  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  const bytes = await res.arrayBuffer();
  return { bytes, contentType };
}
