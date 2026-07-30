import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/bot/app/config";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Feishu config", () => {
  test("expands credentials from the project env file", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "defect-feishu-config-")); roots.push(root);
    writeFileSync(path.join(root, ".env"), "TEST_FEISHU_ID=cli_test\nTEST_FEISHU_SECRET=secret\n");
    writeFileSync(path.join(root, "config.toml"), `
[feishu]
app_id = "\${TEST_FEISHU_ID}"
app_secret = "\${TEST_FEISHU_SECRET}"
input_merge_window_seconds = 2
menu_page_size = 5
[bot]
default_timezone = "Asia/Shanghai"
`);
    const config = loadConfig(path.join(root, "config.toml"));
    expect(config.feishu).toMatchObject({ appId: "cli_test", appSecret: "secret", inputMergeWindowSeconds: 2, menuPageSize: 5 });
    expect(config.paths.uploadSubdir).toBe("feishu");
  });

  test("does not require a bootstrap user", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "defect-feishu-config-")); roots.push(root);
    writeFileSync(path.join(root, "config.toml"), `[feishu]\napp_id="cli_x"\napp_secret="s"\n[bot]\ndefault_timezone="UTC"\n`);
    expect(() => loadConfig(path.join(root, "config.toml"))).not.toThrow();
  });
});
