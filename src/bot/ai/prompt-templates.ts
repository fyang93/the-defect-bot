import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

export class PromptTemplateRenderer {
  private readonly cache = new Map<string, string>();

  constructor(private readonly workspacePiDir: () => string) {}

  clear(): void {
    this.cache.clear();
  }

  render(name: string, variables: Record<string, unknown>): string {
    const template = this.load(name);
    return template.replace(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g, (_match, key: string) => {
      const value = variables[key];
      return value === undefined || value === null ? "" : String(value);
    });
  }

  private templatePath(name: string): string {
    return path.join(this.workspacePiDir(), "prompts", `${name}.md`);
  }

  private load(name: string): string {
    const cached = this.cache.get(name);
    if (cached !== undefined) return cached;

    let filePath = this.templatePath(name);
    if (!existsSync(filePath)) {
      const fallbackPath = path.join(process.cwd(), "agent", ".pi", "prompts", `${name}.md`);
      if (existsSync(fallbackPath)) filePath = fallbackPath;
    }
    if (!existsSync(filePath)) throw new Error(`Missing prompt template: ${filePath}`);

    const raw = readFileSync(filePath, "utf-8");
    const body = raw.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "").trim();
    this.cache.set(name, body);
    return body;
  }
}
