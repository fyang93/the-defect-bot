import { runRepoTool } from "bot/tools/registry";

const command = process.argv[2]?.trim() || "";
const rawArgs = process.argv[3] || "{}";
const args = JSON.parse(rawArgs) as Record<string, unknown>;
const result = await runRepoTool(command, args);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
