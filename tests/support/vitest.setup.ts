import { spawn as nodeSpawn } from "node:child_process";
import { createRequire } from "node:module";
import { Readable } from "node:stream";

const require = createRequire(import.meta.url);
const tsconfigPath = require.resolve("../../tsconfig.json");
const tsxCliPath = require.resolve("tsx/cli");

type BunSpawnOptions = {
  cwd?: string;
  stdout?: "pipe" | "inherit";
  stderr?: "pipe" | "inherit";
  env?: NodeJS.ProcessEnv;
};

type BunSpawnResult = {
  stdout: ReadableStream | null;
  stderr: ReadableStream | null;
  exited: Promise<number | null>;
};

function toWebReadable(stream: Readable | null): ReadableStream | null {
  return stream ? (Readable.toWeb(stream) as ReadableStream) : null;
}

function normalizeCommand(cmd: string[]): string[] {
  if (cmd[0] !== "bun") return cmd;

  if (cmd[1] === "run" && cmd[2]?.endsWith(".ts")) {
    return [process.execPath, tsxCliPath, "--tsconfig", tsconfigPath, cmd[2], ...cmd.slice(3)];
  }

  if (cmd[1]?.endsWith(".ts")) {
    return [process.execPath, tsxCliPath, "--tsconfig", tsconfigPath, cmd[1], ...cmd.slice(2)];
  }

  return ["npm", ...cmd.slice(1)];
}

(globalThis as typeof globalThis & { Bun?: { spawn: (cmd: string[], options?: BunSpawnOptions) => BunSpawnResult } }).Bun = {
  spawn(cmd: string[], options: BunSpawnOptions = {}): BunSpawnResult {
    const normalized = normalizeCommand(cmd);
    const child = nodeSpawn(normalized[0]!, normalized.slice(1), {
      cwd: options.cwd,
      env: {
        ...process.env,
        NODE_NO_WARNINGS: "1",
        ...options.env,
      },
      stdio: ["ignore", options.stdout ?? "pipe", options.stderr ?? "pipe"],
    });

    return {
      stdout: toWebReadable(child.stdout),
      stderr: toWebReadable(child.stderr),
      exited: new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code));
      }),
    };
  },
};
