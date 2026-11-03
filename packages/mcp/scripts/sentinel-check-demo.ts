// Calls the agentguard_sentinel_check MCP tool over stdio (as Claude/Codex would): the agent
// buys Sentinel's paid check, paying through its own vault.
// Usage: AGENTGUARD_VAULT=demo2.agentguard.testnet SENTINEL_URL=http://localhost:3000 npx tsx scripts/sentinel-check-demo.ts [account]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: [new URL("../dist/index.js", import.meta.url).pathname],
  env: { ...process.env, AGENTGUARD_VAULT: process.env.AGENTGUARD_VAULT ?? "demo2.agentguard.testnet", NEAR_NETWORK: "testnet" } as Record<string, string>,
});
const client = new Client({ name: "agentguard-sentinel-check-demo", version: "0.1.0" });
await client.connect(transport);
const r = await client.callTool({ name: "agentguard_sentinel_check", arguments: { account: process.argv[2] ?? "agentguard-sh0p.testnet" } });
console.log(r.isError ? "[ERROR]" : "", (r.content as { text: string }[])[0].text);
await client.close();
