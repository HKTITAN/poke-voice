# poke-voice

An [ElevenLabs](https://elevenlabs.io) MCP server tuned for [Poke](https://poke.com) and deployable as a single-function Vercel deployment.

It wraps the [official ElevenLabs MCP](https://github.com/elevenlabs/elevenlabs-mcp) (Python) as a serverless-friendly TypeScript server using [`mcp-handler`](https://www.npmjs.com/package/mcp-handler) + Streamable HTTP, so you can connect it to Poke via `poke.com/settings/connections`.

## Features

26 tools covering the full ElevenLabs surface:

- **TTS / audio generation** — `text_to_speech`, `text_to_sound_effects`, `compose_music`, `create_composition_plan`
- **Voice library** — `search_voices`, `get_voice`, `list_models`, `search_voice_library`
- **Voice design & cloning** — `text_to_voice` (design previews), `create_voice_from_preview`, `voice_clone` (IVC)
- **Audio processing** — `speech_to_text` (Scribe, with diarization), `speech_to_speech`, `isolate_audio`
- **Conversational AI** — `create_agent`, `list_agents`, `get_agent`, `add_knowledge_base_to_agent`, `list_conversations`, `get_conversation`, `make_outbound_call`, `list_phone_numbers`
- **Account** — `check_subscription`

### Poke-optimized differences from the upstream Python server

| Upstream (Python) | This server (Poke/Vercel) |
|---|---|
| Writes output files to `$HOME/Desktop` | Returns audio inline as an MCP **embedded resource** (base64) — Poke receives it as a file attachment in chat |
| `input_file_path` local paths | `audio_url` or `audio_base64` inputs (serverless has no persistent filesystem) |
| `play_audio` desktop playback tool | Removed (meaningless over HTTP) |
| API key in `.env` | **BYO key**: paste your ElevenLabs key as Poke's MCP auth token |

## Deploy to Vercel

1. Fork/clone this repo and push to your own GitHub account.
2. In [vercel.com](https://vercel.com), create a new project and import the repo.
3. **Enable [Fluid Compute](https://vercel.com/docs/functions/fluid-compute)** on the project (Settings → Functions).
4. (Optional) On Pro/Enterprise, bump `maxDuration` in `vercel.json` to `800` for long music generations.
5. Deploy. Your MCP endpoint is `https://<your-deployment>.vercel.app/mcp`.

No environment variables are required — each user supplies their own ElevenLabs API key through Poke's MCP auth field. (If you want a single-tenant server, set `ELEVENLABS_API_KEY` as a Vercel env var; it becomes the fallback when no bearer token is sent.)

## Connect to Poke

1. Go to [poke.com/settings/connections](https://poke.com/settings/connections).
2. Add a new MCP connection:
   - **URL**: `https://<your-deployment>.vercel.app/mcp`
   - **Auth token**: your ElevenLabs API key (starts with `sk_…`, from [elevenlabs.io/app/settings/api-keys](https://elevenlabs.io/app/settings/api-keys))
3. Name the connection something like `elevenlabs` or `voice`.

To test, ask Poke something like:

> Tell the subagent to use the "elevenlabs" integration's `text_to_speech` tool to say "hello from poke".

Poke will return the generated audio as a file attachment in chat.

If Poke persistently fails to pick the right MCP (e.g. after renaming the connection), send `clearhistory` to reset Poke's memory.

## Local development

```bash
npm install
npx vercel dev
```

Point an MCP inspector (`npx @modelcontextprotocol/inspector`) at `http://localhost:3000/mcp` via the Streamable HTTP transport, and pass your ElevenLabs key as a Bearer token.

Or run the included smoke-test client (after setting `ELEVENLABS_API_KEY`):

```bash
node scripts/test-client.mjs http://localhost:3000
```

## Tool reference

### Audio output

All audio-producing tools return an embedded resource with base64-encoded audio. The resource's `mimeType` reflects the requested `output_format` (defaults to `mp3_44100_128` → `audio/mpeg`). Supported formats:

```
mp3_22050_32, mp3_44100_32, mp3_44100_64, mp3_44100_96, mp3_44100_128,
mp3_44100_192 (Creator+), pcm_8000, pcm_16000, pcm_22050, pcm_24000,
pcm_44100 (Pro+), ulaw_8000, alaw_8000, opus_48000_{32,64,96,128,192}
```

### Audio input

Tools that consume audio (`speech_to_text`, `voice_clone`, `isolate_audio`, `speech_to_speech`) accept:

- `audio_url` — a publicly fetchable URL, **or**
- `audio_base64` — base64-encoded bytes (plus optional `filename` for content-type hinting).

Cost-incurring tools are marked with `COST WARNING` in their descriptions.

## References

- [ElevenLabs MCP (upstream, Python)](https://github.com/elevenlabs/elevenlabs-mcp)
- [`mcp-on-vercel` template](https://github.com/vercel-labs/mcp-on-vercel) · [Vercel MCP docs](https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel)
- [Poke MCP server template](https://github.com/InteractionCo/mcp-server-template) · [Poke MCP examples](https://github.com/InteractionCo/poke-mcp-examples)

## License

MIT.
