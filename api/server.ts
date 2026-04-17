import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";

import { elevenlabs, elevenlabsBinary } from "../lib/elevenlabs.js";
import {
  audioResource,
  buildMultipart,
  handleError,
  loadAudio,
  loadFile,
  mimeFromOutputFormat,
  requireApiKey,
  slug,
  textContent,
  timestampTag,
} from "../lib/helpers.js";

const DEFAULT_VOICE_ID =
  process.env.ELEVENLABS_DEFAULT_VOICE_ID ?? "cgSgspJ2msm6clMCkdW9";

const OUTPUT_FORMATS = [
  "mp3_22050_32",
  "mp3_44100_32",
  "mp3_44100_64",
  "mp3_44100_96",
  "mp3_44100_128",
  "mp3_44100_192",
  "pcm_8000",
  "pcm_16000",
  "pcm_22050",
  "pcm_24000",
  "pcm_44100",
  "ulaw_8000",
  "alaw_8000",
  "opus_48000_32",
  "opus_48000_64",
  "opus_48000_96",
  "opus_48000_128",
  "opus_48000_192",
] as const;

const OutputFormat = z.enum(OUTPUT_FORMATS);

function getApiKey(extra: { authInfo?: AuthInfo }): string {
  return requireApiKey(extra.authInfo?.token);
}

const handler = createMcpHandler((server) => {
  // ---------- text_to_speech ----------
  server.tool(
    "text_to_speech",
    "Convert text to speech with a given ElevenLabs voice. Returns the audio as an embedded MCP resource (base64). Either voice_id or voice_name may be supplied; if neither, the default voice is used. COST WARNING: incurs ElevenLabs credits.",
    {
      text: z.string().min(1),
      voice_id: z.string().optional(),
      voice_name: z.string().optional(),
      model_id: z.string().optional(),
      language: z.string().optional().describe("ISO 639-1 language code"),
      stability: z.number().min(0).max(1).optional(),
      similarity_boost: z.number().min(0).max(1).optional(),
      style: z.number().min(0).max(1).optional(),
      use_speaker_boost: z.boolean().optional(),
      speed: z.number().min(0.7).max(1.2).optional(),
      output_format: OutputFormat.optional(),
    },
    async (args, extra) => {
      try {
        const apiKey = getApiKey(extra);
        if (args.voice_id && args.voice_name) {
          throw new Error("Provide only one of voice_id or voice_name.");
        }
        let voiceId = args.voice_id;
        let voiceName = args.voice_name;
        if (!voiceId && voiceName) {
          const res = await elevenlabs<{ voices: Array<{ voice_id: string; name: string }> }>(
            apiKey,
            `/v1/voices`,
            { query: { search: voiceName } },
          );
          const match =
            res.voices.find((v) => v.name === voiceName) ?? res.voices[0];
          if (!match) throw new Error(`No voice found matching "${voiceName}".`);
          voiceId = match.voice_id;
        }
        if (!voiceId) voiceId = DEFAULT_VOICE_ID;

        const modelId =
          args.model_id ??
          (args.language && ["hu", "no", "vi"].includes(args.language)
            ? "eleven_flash_v2_5"
            : "eleven_multilingual_v2");
        const outputFormat = args.output_format ?? "mp3_44100_128";

        const body: Record<string, unknown> = {
          text: args.text,
          model_id: modelId,
          voice_settings: {
            stability: args.stability ?? 0.5,
            similarity_boost: args.similarity_boost ?? 0.75,
            style: args.style ?? 0,
            use_speaker_boost: args.use_speaker_boost ?? true,
            speed: args.speed ?? 1.0,
          },
        };
        if (args.language) body.language_code = args.language;

        const { bytes } = await elevenlabsBinary(
          apiKey,
          `/v1/text-to-speech/${voiceId}`,
          { query: { output_format: outputFormat }, json: body },
        );

        return {
          content: [
            textContent(
              `Generated ${bytes.byteLength} bytes of audio with voice ${voiceId} (format: ${outputFormat}).`,
            ),
            audioResource({
              bytes,
              mimeType: mimeFromOutputFormat(outputFormat),
              name: `tts_${slug(args.text, 16)}_${timestampTag()}`,
            }),
          ],
        };
      } catch (e) {
        return handleError(e);
      }
    },
  );

  // ---------- speech_to_text ----------
  server.tool(
    "speech_to_text",
    "Transcribe speech from an audio file. Accepts audio_url or audio_base64. If diarize=true, speakers are labeled. COST WARNING: incurs ElevenLabs credits.",
    {
      audio_url: z.string().url().optional(),
      audio_base64: z.string().optional(),
      filename: z.string().optional(),
      language_code: z.string().optional().describe("ISO 639-3 code; auto-detect if omitted"),
      diarize: z.boolean().optional(),
      tag_audio_events: z.boolean().optional(),
    },
    async (args, extra) => {
      try {
        const apiKey = getApiKey(extra);
        const audio = await loadAudio(args);
        const mp = await buildMultipart({
          model_id: "scribe_v1",
          file: { buffer: audio.buffer, filename: audio.filename, contentType: audio.contentType },
          language_code: args.language_code ?? undefined,
          diarize: args.diarize ? "true" : undefined,
          tag_audio_events: args.tag_audio_events === false ? "false" : "true",
        });
        const res = await elevenlabs<{ text: string; words?: Array<{ speaker_id?: string; text?: string; type?: string }> }>(
          apiKey,
          `/v1/speech-to-text`,
          { method: "POST", headers: { "Content-Type": mp.contentType }, body: mp.body },
        );
        let transcript = res.text ?? "";
        if (args.diarize && res.words && res.words.length) {
          const lines: string[] = [];
          let curSpeaker: string | null = null;
          let buf: string[] = [];
          for (const w of res.words) {
            if (!w.text || w.type === "spacing") continue;
            const spk = w.speaker_id ?? "unknown";
            if (spk !== curSpeaker) {
              if (curSpeaker && buf.length) lines.push(`${curSpeaker.toUpperCase()}: ${buf.join(" ")}`);
              curSpeaker = spk;
              buf = [w.text.trim()];
            } else buf.push(w.text.trim());
          }
          if (curSpeaker && buf.length) lines.push(`${curSpeaker.toUpperCase()}: ${buf.join(" ")}`);
          transcript = lines.join("\n\n");
        }
        return { content: [textContent(transcript)] };
      } catch (e) {
        return handleError(e);
      }
    },
  );

  // ---------- text_to_sound_effects ----------
  server.tool(
    "text_to_sound_effects",
    "Generate a sound effect from a text prompt (0.5 – 5 seconds). COST WARNING: incurs ElevenLabs credits.",
    {
      text: z.string().min(1),
      duration_seconds: z.number().min(0.5).max(5).optional(),
      loop: z.boolean().optional(),
      output_format: OutputFormat.optional(),
    },
    async (args, extra) => {
      try {
        const apiKey = getApiKey(extra);
        const outputFormat = args.output_format ?? "mp3_44100_128";
        const { bytes } = await elevenlabsBinary(apiKey, `/v1/sound-generation`, {
          query: { output_format: outputFormat },
          json: {
            text: args.text,
            duration_seconds: args.duration_seconds ?? 2,
            loop: args.loop ?? false,
          },
        });
        return {
          content: [
            textContent(`Generated ${bytes.byteLength} bytes of sound effect.`),
            audioResource({
              bytes,
              mimeType: mimeFromOutputFormat(outputFormat),
              name: `sfx_${slug(args.text, 16)}_${timestampTag()}`,
            }),
          ],
        };
      } catch (e) {
        return handleError(e);
      }
    },
  );

  // ---------- search_voices ----------
  server.tool(
    "search_voices",
    "Search voices in the user's ElevenLabs library (by name/description/labels).",
    {
      search: z.string().optional(),
      sort: z.enum(["created_at_unix", "name"]).optional(),
      sort_direction: z.enum(["asc", "desc"]).optional(),
    },
    async (args, extra) => {
      try {
        const apiKey = getApiKey(extra);
        const res = await elevenlabs<{
          voices: Array<{ voice_id: string; name: string; category?: string; description?: string }>;
        }>(apiKey, `/v1/voices`, {
          query: {
            search: args.search,
            sort: args.sort ?? "name",
            sort_direction: args.sort_direction ?? "desc",
          },
        });
        return {
          content: [
            textContent(
              JSON.stringify(
                res.voices.map((v) => ({ id: v.voice_id, name: v.name, category: v.category })),
                null,
                2,
              ),
            ),
          ],
        };
      } catch (e) {
        return handleError(e);
      }
    },
  );

  // ---------- list_models ----------
  server.tool("list_models", "List all available ElevenLabs models.", {}, async (_args, extra) => {
    try {
      const apiKey = getApiKey(extra);
      const res = await elevenlabs<
        Array<{ model_id: string; name: string; languages?: Array<{ language_id: string; name: string }> }>
      >(apiKey, `/v1/models`);
      return {
        content: [
          textContent(
            JSON.stringify(
              res.map((m) => ({
                id: m.model_id,
                name: m.name,
                languages: (m.languages ?? []).map((l) => ({ id: l.language_id, name: l.name })),
              })),
              null,
              2,
            ),
          ),
        ],
      };
    } catch (e) {
      return handleError(e);
    }
  });

  // ---------- get_voice ----------
  server.tool(
    "get_voice",
    "Get details of a specific voice by ID.",
    { voice_id: z.string() },
    async (args, extra) => {
      try {
        const apiKey = getApiKey(extra);
        const res = await elevenlabs(apiKey, `/v1/voices/${args.voice_id}`);
        return { content: [textContent(JSON.stringify(res, null, 2))] };
      } catch (e) {
        return handleError(e);
      }
    },
  );

  // ---------- voice_clone ----------
  server.tool(
    "voice_clone",
    "Create an Instant Voice Clone from one or more audio samples. Each sample may be given as audio_url or audio_base64. COST WARNING: incurs ElevenLabs credits.",
    {
      name: z.string(),
      description: z.string().optional(),
      samples: z
        .array(
          z.object({
            audio_url: z.string().url().optional(),
            audio_base64: z.string().optional(),
            filename: z.string().optional(),
          }),
        )
        .min(1),
    },
    async (args, extra) => {
      try {
        const apiKey = getApiKey(extra);
        const fields: Record<string, string | { buffer: Buffer; filename: string; contentType: string } | undefined> = {
          name: args.name,
          description: args.description,
        };
        // Multiple `files` fields — we need a custom multipart since our helper uses an object map.
        // Build manually:
        const boundary = `----pvclone${Math.random().toString(36).slice(2)}${Date.now()}`;
        const CRLF = "\r\n";
        const parts: Buffer[] = [];
        const push = (s: string | Buffer) =>
          parts.push(typeof s === "string" ? Buffer.from(s) : s);
        push(`--${boundary}${CRLF}Content-Disposition: form-data; name="name"${CRLF}${CRLF}${args.name}${CRLF}`);
        if (args.description) {
          push(
            `--${boundary}${CRLF}Content-Disposition: form-data; name="description"${CRLF}${CRLF}${args.description}${CRLF}`,
          );
        }
        for (const s of args.samples) {
          const audio = await loadAudio(s);
          push(
            `--${boundary}${CRLF}Content-Disposition: form-data; name="files"; filename="${audio.filename}"${CRLF}Content-Type: ${audio.contentType}${CRLF}${CRLF}`,
          );
          push(audio.buffer);
          push(CRLF);
        }
        push(`--${boundary}--${CRLF}`);
        const body = Buffer.concat(parts);
        const res = await elevenlabs<{ voice_id: string; name?: string }>(
          apiKey,
          `/v1/voices/add`,
          {
            method: "POST",
            headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
            body,
          },
        );
        return {
          content: [
            textContent(
              `Voice cloned: name="${res.name ?? args.name}", voice_id=${res.voice_id}`,
            ),
          ],
        };
      } catch (e) {
        return handleError(e);
      }
    },
  );

  // ---------- isolate_audio ----------
  server.tool(
    "isolate_audio",
    "Extract clean voice audio (removes background noise) from an audio file supplied as audio_url or audio_base64. COST WARNING: incurs ElevenLabs credits.",
    {
      audio_url: z.string().url().optional(),
      audio_base64: z.string().optional(),
      filename: z.string().optional(),
    },
    async (args, extra) => {
      try {
        const apiKey = getApiKey(extra);
        const audio = await loadAudio(args);
        const mp = await buildMultipart({
          audio: { buffer: audio.buffer, filename: audio.filename, contentType: audio.contentType },
        });
        const { bytes, contentType } = await elevenlabsBinary(apiKey, `/v1/audio-isolation`, {
          method: "POST",
          headers: { "Content-Type": mp.contentType },
          body: mp.body,
        });
        return {
          content: [
            textContent(`Isolated audio: ${bytes.byteLength} bytes.`),
            audioResource({
              bytes,
              mimeType: contentType || "audio/mpeg",
              name: `iso_${slug(audio.filename, 16)}_${timestampTag()}`,
            }),
          ],
        };
      } catch (e) {
        return handleError(e);
      }
    },
  );

  // ---------- check_subscription ----------
  server.tool(
    "check_subscription",
    "Check the current ElevenLabs subscription status (usage, quota, tier).",
    {},
    async (_args, extra) => {
      try {
        const apiKey = getApiKey(extra);
        const res = await elevenlabs(apiKey, `/v1/user/subscription`);
        return { content: [textContent(JSON.stringify(res, null, 2))] };
      } catch (e) {
        return handleError(e);
      }
    },
  );

  // ---------- create_agent ----------
  server.tool(
    "create_agent",
    "Create a Conversational AI agent with the given configuration. COST WARNING: incurs ElevenLabs credits.",
    {
      name: z.string(),
      first_message: z.string(),
      system_prompt: z.string(),
      voice_id: z.string().optional(),
      language: z.string().optional(),
      llm: z.string().optional(),
      temperature: z.number().min(0).max(1).optional(),
      max_tokens: z.number().int().optional(),
      asr_quality: z.enum(["high", "low"]).optional(),
      model_id: z.string().optional(),
      optimize_streaming_latency: z.number().int().min(0).max(4).optional(),
      stability: z.number().min(0).max(1).optional(),
      similarity_boost: z.number().min(0).max(1).optional(),
      turn_timeout: z.number().int().optional(),
      max_duration_seconds: z.number().int().optional(),
      record_voice: z.boolean().optional(),
      retention_days: z.number().int().optional(),
    },
    async (args, extra) => {
      try {
        const apiKey = getApiKey(extra);
        const voiceId = args.voice_id ?? DEFAULT_VOICE_ID;
        const conversation_config = {
          agent: {
            first_message: args.first_message,
            language: args.language ?? "en",
            prompt: {
              prompt: args.system_prompt,
              llm: args.llm ?? "gemini-2.0-flash-001",
              temperature: args.temperature ?? 0.5,
              ...(args.max_tokens !== undefined ? { max_tokens: args.max_tokens } : {}),
            },
          },
          asr: { quality: args.asr_quality ?? "high" },
          tts: {
            model_id: args.model_id ?? "eleven_turbo_v2",
            voice_id: voiceId,
            optimize_streaming_latency: args.optimize_streaming_latency ?? 3,
            stability: args.stability ?? 0.5,
            similarity_boost: args.similarity_boost ?? 0.8,
          },
          turn: { turn_timeout: args.turn_timeout ?? 7 },
          conversation: { max_duration_seconds: args.max_duration_seconds ?? 300 },
        };
        const platform_settings = {
          call_limits: { agent_concurrency_limit: -1 },
          privacy: {
            record_voice: args.record_voice ?? true,
            retention_days: args.retention_days ?? 730,
          },
        };
        const res = await elevenlabs<{ agent_id: string }>(
          apiKey,
          `/v1/convai/agents/create`,
          { json: { name: args.name, conversation_config, platform_settings } },
        );
        return {
          content: [
            textContent(
              `Agent created. name="${args.name}" agent_id=${res.agent_id} voice_id=${voiceId}`,
            ),
          ],
        };
      } catch (e) {
        return handleError(e);
      }
    },
  );

  // ---------- add_knowledge_base_to_agent ----------
  server.tool(
    "add_knowledge_base_to_agent",
    "Attach a knowledge-base document (URL, inline text, or uploaded file) to a Conversational AI agent. Supply exactly one of url / text / (file_url|file_base64). Allowed file types: epub, pdf, docx, txt, html. COST WARNING: may incur credits.",
    {
      agent_id: z.string(),
      knowledge_base_name: z.string(),
      url: z.string().url().optional(),
      text: z.string().optional(),
      file_url: z.string().url().optional(),
      file_base64: z.string().optional(),
      filename: z.string().optional(),
    },
    async (args, extra) => {
      try {
        const apiKey = getApiKey(extra);
        const provided = [
          args.url,
          args.text,
          args.file_url ?? args.file_base64,
        ].filter(Boolean).length;
        if (provided !== 1) throw new Error("Provide exactly one of: url, text, or file.");

        let kbId: string;
        if (args.url) {
          const r = await elevenlabs<{ id: string }>(
            apiKey,
            `/v1/convai/knowledge-base/url`,
            { json: { name: args.knowledge_base_name, url: args.url } },
          );
          kbId = r.id;
        } else {
          let file: { buffer: Buffer; filename: string; contentType: string };
          if (args.text !== undefined) {
            file = {
              buffer: Buffer.from(args.text, "utf-8"),
              filename: "text.txt",
              contentType: "text/plain",
            };
          } else {
            file = await loadFile({
              file_url: args.file_url,
              file_base64: args.file_base64,
              filename: args.filename,
            });
          }
          const mp = await buildMultipart({
            name: args.knowledge_base_name,
            file,
          });
          const r = await elevenlabs<{ id: string }>(
            apiKey,
            `/v1/convai/knowledge-base/file`,
            { method: "POST", headers: { "Content-Type": mp.contentType }, body: mp.body },
          );
          kbId = r.id;
        }

        const agent = await elevenlabs<{ conversation_config?: { agent?: { prompt?: { knowledge_base?: Array<unknown> } } } }>(
          apiKey,
          `/v1/convai/agents/${args.agent_id}`,
        );
        const conv = (agent.conversation_config ?? {}) as any;
        conv.agent = conv.agent ?? {};
        conv.agent.prompt = conv.agent.prompt ?? {};
        const kbList = (conv.agent.prompt.knowledge_base ?? []) as Array<unknown>;
        kbList.push({
          type: args.url ? "url" : "file",
          name: args.knowledge_base_name,
          id: kbId,
        });
        conv.agent.prompt.knowledge_base = kbList;

        await elevenlabs(apiKey, `/v1/convai/agents/${args.agent_id}`, {
          method: "PATCH",
          json: { conversation_config: conv },
        });

        return {
          content: [
            textContent(
              `Knowledge base "${args.knowledge_base_name}" (id=${kbId}) attached to agent ${args.agent_id}.`,
            ),
          ],
        };
      } catch (e) {
        return handleError(e);
      }
    },
  );

  // ---------- list_agents ----------
  server.tool("list_agents", "List all Conversational AI agents.", {}, async (_args, extra) => {
    try {
      const apiKey = getApiKey(extra);
      const res = await elevenlabs<{ agents: Array<{ agent_id: string; name: string }> }>(
        apiKey,
        `/v1/convai/agents`,
      );
      if (!res.agents?.length) return { content: [textContent("No agents found.")] };
      return {
        content: [
          textContent(res.agents.map((a) => `${a.name} (ID: ${a.agent_id})`).join("\n")),
        ],
      };
    } catch (e) {
      return handleError(e);
    }
  });

  // ---------- get_agent ----------
  server.tool(
    "get_agent",
    "Get details about a specific Conversational AI agent.",
    { agent_id: z.string() },
    async (args, extra) => {
      try {
        const apiKey = getApiKey(extra);
        const res = await elevenlabs(apiKey, `/v1/convai/agents/${args.agent_id}`);
        return { content: [textContent(JSON.stringify(res, null, 2))] };
      } catch (e) {
        return handleError(e);
      }
    },
  );

  // ---------- get_conversation ----------
  server.tool(
    "get_conversation",
    "Fetch full details (including transcript) of a completed agent conversation.",
    { conversation_id: z.string() },
    async (args, extra) => {
      try {
        const apiKey = getApiKey(extra);
        const res = await elevenlabs(apiKey, `/v1/convai/conversations/${args.conversation_id}`);
        return { content: [textContent(JSON.stringify(res, null, 2))] };
      } catch (e) {
        return handleError(e);
      }
    },
  );

  // ---------- list_conversations ----------
  server.tool(
    "list_conversations",
    "List Conversational AI conversations with optional filtering.",
    {
      agent_id: z.string().optional(),
      cursor: z.string().optional(),
      call_start_before_unix: z.number().int().optional(),
      call_start_after_unix: z.number().int().optional(),
      page_size: z.number().int().min(1).max(100).optional(),
    },
    async (args, extra) => {
      try {
        const apiKey = getApiKey(extra);
        const res = await elevenlabs(apiKey, `/v1/convai/conversations`, {
          query: {
            agent_id: args.agent_id,
            cursor: args.cursor,
            call_start_before_unix: args.call_start_before_unix,
            call_start_after_unix: args.call_start_after_unix,
            page_size: args.page_size ?? 30,
          },
        });
        return { content: [textContent(JSON.stringify(res, null, 2))] };
      } catch (e) {
        return handleError(e);
      }
    },
  );

  // ---------- speech_to_speech ----------
  server.tool(
    "speech_to_speech",
    "Re-voice a source audio clip with a target voice (audio-to-audio). Supply audio_url or audio_base64. COST WARNING: incurs ElevenLabs credits.",
    {
      voice_id: z.string().optional(),
      voice_name: z.string().optional(),
      audio_url: z.string().url().optional(),
      audio_base64: z.string().optional(),
      filename: z.string().optional(),
      output_format: OutputFormat.optional(),
    },
    async (args, extra) => {
      try {
        const apiKey = getApiKey(extra);
        if (args.voice_id && args.voice_name) {
          throw new Error("Provide only one of voice_id or voice_name.");
        }
        let voiceId = args.voice_id;
        if (!voiceId && args.voice_name) {
          const res = await elevenlabs<{ voices: Array<{ voice_id: string; name: string }> }>(
            apiKey,
            `/v1/voices`,
            { query: { search: args.voice_name } },
          );
          const match = res.voices.find((v) => v.name === args.voice_name) ?? res.voices[0];
          if (!match) throw new Error(`No voice found matching "${args.voice_name}".`);
          voiceId = match.voice_id;
        }
        if (!voiceId) voiceId = DEFAULT_VOICE_ID;

        const audio = await loadAudio(args);
        const outputFormat = args.output_format ?? "mp3_44100_128";
        const mp = await buildMultipart({
          model_id: "eleven_multilingual_sts_v2",
          audio: { buffer: audio.buffer, filename: audio.filename, contentType: audio.contentType },
        });
        const { bytes } = await elevenlabsBinary(
          apiKey,
          `/v1/speech-to-speech/${voiceId}`,
          {
            method: "POST",
            query: { output_format: outputFormat },
            headers: { "Content-Type": mp.contentType },
            body: mp.body,
          },
        );
        return {
          content: [
            textContent(`Re-voiced ${bytes.byteLength} bytes.`),
            audioResource({
              bytes,
              mimeType: mimeFromOutputFormat(outputFormat),
              name: `sts_${slug(audio.filename, 12)}_${timestampTag()}`,
            }),
          ],
        };
      } catch (e) {
        return handleError(e);
      }
    },
  );

  // ---------- text_to_voice (voice design previews) ----------
  server.tool(
    "text_to_voice",
    "Design a new voice from a text description. Returns three preview audio clips plus their generated_voice_ids (pass one to create_voice_from_preview to save it). COST WARNING: incurs ElevenLabs credits.",
    {
      voice_description: z.string().min(1),
      text: z.string().optional(),
    },
    async (args, extra) => {
      try {
        const apiKey = getApiKey(extra);
        const res = await elevenlabs<{
          previews: Array<{ generated_voice_id: string; audio_base_64: string; media_type?: string }>;
        }>(apiKey, `/v1/text-to-voice/create-previews`, {
          json: {
            voice_description: args.voice_description,
            ...(args.text ? { text: args.text } : { auto_generate_text: true }),
          },
        });
        const content: Array<ReturnType<typeof textContent> | ReturnType<typeof audioResource>> = [
          textContent(
            `Generated voice IDs: ${res.previews.map((p) => p.generated_voice_id).join(", ")}`,
          ),
        ];
        for (const p of res.previews) {
          content.push(
            audioResource({
              bytes: Buffer.from(p.audio_base_64, "base64"),
              mimeType: p.media_type ?? "audio/mpeg",
              name: `voice_design_${p.generated_voice_id}`,
            }),
          );
        }
        return { content };
      } catch (e) {
        return handleError(e);
      }
    },
  );

  // ---------- create_voice_from_preview ----------
  server.tool(
    "create_voice_from_preview",
    "Save a generated voice preview (from text_to_voice) to the user's voice library. COST WARNING: incurs ElevenLabs credits.",
    {
      generated_voice_id: z.string(),
      voice_name: z.string(),
      voice_description: z.string(),
    },
    async (args, extra) => {
      try {
        const apiKey = getApiKey(extra);
        const res = await elevenlabs<{ voice_id: string; name?: string }>(
          apiKey,
          `/v1/text-to-voice/create-voice-from-preview`,
          {
            json: {
              generated_voice_id: args.generated_voice_id,
              voice_name: args.voice_name,
              voice_description: args.voice_description,
            },
          },
        );
        return {
          content: [
            textContent(
              `Voice saved: name="${res.name ?? args.voice_name}" voice_id=${res.voice_id}`,
            ),
          ],
        };
      } catch (e) {
        return handleError(e);
      }
    },
  );

  // ---------- make_outbound_call ----------
  server.tool(
    "make_outbound_call",
    "Place an outbound phone call with a Conversational AI agent. Automatically routes through Twilio or SIP trunk based on the phone number's provider. COST WARNING: incurs ElevenLabs + telephony credits.",
    {
      agent_id: z.string(),
      agent_phone_number_id: z.string(),
      to_number: z.string().describe("E.164 format, e.g. +14155551234"),
    },
    async (args, extra) => {
      try {
        const apiKey = getApiKey(extra);
        const list = await elevenlabs<Array<{ phone_number_id: string; provider: string }>>(
          apiKey,
          `/v1/convai/phone-numbers`,
        );
        const phone = list.find((p) => p.phone_number_id === args.agent_phone_number_id);
        if (!phone) throw new Error(`Phone number ${args.agent_phone_number_id} not found.`);

        const provider = phone.provider.toLowerCase();
        let endpoint: string;
        if (provider === "twilio") endpoint = `/v1/convai/twilio/outbound-call`;
        else if (provider === "sip_trunk") endpoint = `/v1/convai/sip-trunk/outbound-call`;
        else throw new Error(`Unsupported provider: ${phone.provider}`);

        const res = await elevenlabs(apiKey, endpoint, {
          json: {
            agent_id: args.agent_id,
            agent_phone_number_id: args.agent_phone_number_id,
            to_number: args.to_number,
          },
        });
        return {
          content: [
            textContent(
              `Outbound call initiated via ${phone.provider}: ${JSON.stringify(res)}`,
            ),
          ],
        };
      } catch (e) {
        return handleError(e);
      }
    },
  );

  // ---------- search_voice_library ----------
  server.tool(
    "search_voice_library",
    "Search the public shared ElevenLabs voice library.",
    {
      search: z.string().optional(),
      page: z.number().int().min(0).optional(),
      page_size: z.number().int().min(1).max(100).optional(),
    },
    async (args, extra) => {
      try {
        const apiKey = getApiKey(extra);
        const res = await elevenlabs(apiKey, `/v1/shared-voices`, {
          query: {
            search: args.search,
            page: args.page ?? 0,
            page_size: args.page_size ?? 10,
          },
        });
        return { content: [textContent(JSON.stringify(res, null, 2))] };
      } catch (e) {
        return handleError(e);
      }
    },
  );

  // ---------- list_phone_numbers ----------
  server.tool(
    "list_phone_numbers",
    "List all phone numbers attached to the ElevenLabs account.",
    {},
    async (_args, extra) => {
      try {
        const apiKey = getApiKey(extra);
        const res = await elevenlabs(apiKey, `/v1/convai/phone-numbers`);
        return { content: [textContent(JSON.stringify(res, null, 2))] };
      } catch (e) {
        return handleError(e);
      }
    },
  );

  // ---------- compose_music ----------
  server.tool(
    "compose_music",
    "Generate music from a text prompt or a composition plan (from create_composition_plan). COST WARNING: incurs ElevenLabs credits.",
    {
      prompt: z.string().optional(),
      composition_plan: z.record(z.unknown()).optional(),
      music_length_ms: z.number().int().min(1000).max(300000).optional(),
      output_format: OutputFormat.optional(),
    },
    async (args, extra) => {
      try {
        const apiKey = getApiKey(extra);
        if (!args.prompt && !args.composition_plan) {
          throw new Error("Provide either prompt or composition_plan.");
        }
        if (args.prompt && args.composition_plan) {
          throw new Error("Provide only one of prompt or composition_plan.");
        }
        if (args.music_length_ms !== undefined && args.composition_plan) {
          throw new Error("music_length_ms cannot be used with composition_plan.");
        }
        const outputFormat = args.output_format ?? "mp3_44100_128";
        const body: Record<string, unknown> = {};
        if (args.prompt) body.prompt = args.prompt;
        if (args.composition_plan) body.composition_plan = args.composition_plan;
        if (args.music_length_ms !== undefined) body.music_length_ms = args.music_length_ms;

        const { bytes } = await elevenlabsBinary(apiKey, `/v1/music`, {
          query: { output_format: outputFormat },
          json: body,
        });
        return {
          content: [
            textContent(`Composed ${bytes.byteLength} bytes of music.`),
            audioResource({
              bytes,
              mimeType: mimeFromOutputFormat(outputFormat),
              name: `music_${timestampTag()}`,
            }),
          ],
        };
      } catch (e) {
        return handleError(e);
      }
    },
  );

  // ---------- create_composition_plan ----------
  server.tool(
    "create_composition_plan",
    "Create a composition plan (structured blueprint) from a prompt. Free to generate but rate-limited. Pass the returned plan to compose_music.",
    {
      prompt: z.string(),
      music_length_ms: z.number().int().min(10000).max(300000).optional(),
      source_composition_plan: z.record(z.unknown()).optional(),
    },
    async (args, extra) => {
      try {
        const apiKey = getApiKey(extra);
        const body: Record<string, unknown> = { prompt: args.prompt };
        if (args.music_length_ms !== undefined) body.music_length_ms = args.music_length_ms;
        if (args.source_composition_plan)
          body.source_composition_plan = args.source_composition_plan;
        const res = await elevenlabs(apiKey, `/v1/music/plan`, { json: body });
        return { content: [textContent(JSON.stringify(res, null, 2))] };
      } catch (e) {
        return handleError(e);
      }
    },
  );
});

// Accept any non-empty bearer token as the ElevenLabs API key.
// Users paste their key directly into Poke's MCP auth field.
const verifyToken = async (
  _req: Request,
  bearerToken?: string,
): Promise<AuthInfo | undefined> => {
  const token = (bearerToken ?? "").trim();
  if (!token) {
    // Allow env-var fallback for single-tenant deployments.
    if (process.env.ELEVENLABS_API_KEY) {
      return {
        token: process.env.ELEVENLABS_API_KEY,
        scopes: [],
        clientId: "env",
      };
    }
    return undefined;
  }
  return { token, scopes: [], clientId: "byo" };
};

const authHandler = withMcpAuth(handler, verifyToken, {
  required: !process.env.ELEVENLABS_API_KEY,
});

export { authHandler as GET, authHandler as POST, authHandler as DELETE };
