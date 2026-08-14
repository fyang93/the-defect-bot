import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

export class PromptTemplateRenderer {
  private cache = new Map<string, string>();

  constructor(private workspacePiDir: () => string) {}
  clear(): void { this.cache.clear(); }

  render(name: string, variables: Record<string, unknown>): string {
    const template = this.cache.get(name) ?? this.load(name);
    return template.replace(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g, (_match, key: string) => String(variables[key] ?? ""));
  }

  private load(name: string): string {
    const local = path.join(this.workspacePiDir(), "prompts", `${name}.md`);
    const fallback = path.join(process.cwd(), "agent", ".pi", "prompts", `${name}.md`);
    const file = existsSync(local) ? local : fallback;
    if (!existsSync(file)) throw new Error(`Missing prompt template: ${local}`);
    const template = readFileSync(file, "utf8").replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "").trim();
    this.cache.set(name, template);
    return template;
  }
}
