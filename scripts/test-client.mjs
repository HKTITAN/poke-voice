#!/usr/bin/env node
// Minimal smoke test: lists MCP tools on the given server.
// Usage:
//   ELEVENLABS_API_KEY=sk_... node scripts/test-client.mjs http://localhost:3000
//   node scripts/test-client.mjs https://your-deployment.vercel.app sk_...
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = process.argv[2] ?? "http://localhost:3000";
const apiKey = process.argv[3] ?? process.env.ELEVENLABS_API_KEY ?? "";

const url = new URL("/mcp", base);
const transport = new StreamableHTTPClientTransport(url, {
  requestInit: apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : undefined,
});
const client = new Client({ name: "poke-voice-test", version: "0.1.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log(`Connected. ${tools.tools.length} tools available:`);
for (const t of tools.tools) console.log(`  - ${t.name}: ${t.description?.slice(0, 80)}...`);

await client.close();
