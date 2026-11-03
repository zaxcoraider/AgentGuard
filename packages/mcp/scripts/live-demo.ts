// Starts the MCP server over stdio (as Claude/Codex would) and calls each tool
// against a real vault. Usage: AGENTGUARD_VAULT=demo2.agentguard.testnet npx tsx scripts/live-demo.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const vault = process.env.AGENTGUARD_VAULT ?? "demo2.agentguard.testnet";
const transport = new StdioClientTransport({
  command: "node",
  args: [new URL("../dist/index.js", import.meta.url).pathname],
  env: { ...process.env, AGENTGUARD_VAULT: vault, NEAR_NETWORK: "testnet" } as Record<string, string>,
});
const client = new Client({ name: "agentguard-live-demo", version: "0.1.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { text: string }[])[0].text;
  console.log(`\n> ${name} ${JSON.stringify(args)}${r.isError ? "  [ERROR]" : ""}\n${text}`);
  return r.isError ? text : JSON.parse(text);
}

await call("agentguard_policy");
await call("agentguard_balance");
await call("agentguard_check_address", { account: "agentguard-shop.testnet" });
await call("agentguard_check_address", { account: "agentguard-evil.testnet" });
await call("agentguard_check_address", { account: "agentguard-sh0p.testnet" });
const paid = await call("agentguard_pay", { recipient: "agentguard-shop.testnet", amount_near: "0.05", memo: "mcp live demo: coffee" });
await call("agentguard_pay", { recipient: "agentguard-evil.testnet", amount_near: "0.2", memo: "mcp live demo: injected 'refund'" });
await call("agentguard_pay", { recipient: "agentguard-shop.testnet", amount_near: "5", memo: "mcp live demo: drain attempt" });
if (paid?.id) await call("agentguard_payment_status", { id: paid.id });
await call("agentguard_history", { limit: 3 });
await client.close();
