const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  registerNanoAgentHooks,
  unregisterNanoAgentHooks,
  NANO_COMMAND_HOOK_EVENTS,
  NANO_HTTP_HOOK_EVENTS,
  HOOK_NAME_PREFIX,
  ensureSecurityHooksArray,
  isOurEntry,
} = require("../hooks/nano-agent-install");

let yaml;
try {
  yaml = require("js-yaml");
} catch (err) {
  console.warn("js-yaml not installed — skipping nano-agent-install tests");
  process.exit(0);
}

const tempDirs = [];

function makeTempConfigFile(initial = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-nano-"));
  const configPath = path.join(tmpDir, "config.yaml");
  const content = yaml.dump(initial, { indent: 2, noRefs: true });
  fs.writeFileSync(configPath, content, "utf-8");
  tempDirs.push(tmpDir);
  return configPath;
}

function readYaml(filePath) {
  return yaml.load(fs.readFileSync(filePath, "utf-8"));
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("Nano Agent hook installer", () => {
  it("skips when config is missing", () => {
    const configPath = "/nonexistent/config.yaml";
    const result = registerNanoAgentHooks({ silent: true, configPath });
    assert.strictEqual(result.status, "skipped");
    assert.strictEqual(result.reason, "config-missing");
  });

  it("registers all command and HTTP hooks on fresh install", () => {
    const configPath = makeTempConfigFile({});
    const result = registerNanoAgentHooks({
      silent: true,
      configPath,
      nodeBin: "/usr/local/bin/node",
      scriptPath: "/opt/clawd/hooks/nano-agent-hook.js",
      port: 23333,
    });

    // 13 command hooks + 1 HTTP hook = 14
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.added, 14);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, 0);

    const config = readYaml(configPath);
    assert.ok(config.security);
    assert.ok(Array.isArray(config.security.hooks));
    assert.strictEqual(config.security.hooks.length, 14);

    // Verify command hooks
    const commandHooks = config.security.hooks.filter((h) => h.type === "command");
    assert.strictEqual(commandHooks.length, 13);
    for (const hook of commandHooks) {
      assert.ok(hook.name.startsWith(HOOK_NAME_PREFIX));
      assert.ok(hook.command.includes("/usr/local/bin/node"));
      assert.ok(hook.command.includes("/opt/clawd/hooks/nano-agent-hook.js"));
      assert.strictEqual(hook.enabled, true);
      assert.strictEqual(hook.failure_policy, "allow");
      assert.strictEqual(hook.async, true);
      assert.ok(Array.isArray(hook.env_whitelist));
      assert.ok(hook.env_whitelist.includes("CLAWD_REMOTE"));
    }

    // Verify HTTP hook
    const httpHooks = config.security.hooks.filter((h) => h.type === "http");
    assert.strictEqual(httpHooks.length, 1);
    const permHook = httpHooks[0];
    assert.ok(permHook.name.startsWith(HOOK_NAME_PREFIX));
    assert.strictEqual(permHook.event, "permission_request");
    assert.strictEqual(permHook.http.method, "POST");
    assert.ok(permHook.http.url.includes("127.0.0.1:23333"));
    assert.ok(permHook.http.url.includes("/permission"));
    assert.strictEqual(permHook.http.timeout_seconds, 600);
    assert.deepStrictEqual(permHook.http.url_allowlist, ["127.0.0.1", "localhost"]);
  });

  it("is idempotent on second run", () => {
    const configPath = makeTempConfigFile({});
    const firstResult = registerNanoAgentHooks({
      silent: true,
      configPath,
      nodeBin: "/usr/local/bin/node",
      port: 23333,
    });
    assert.strictEqual(firstResult.added, 14);

    const secondResult = registerNanoAgentHooks({
      silent: true,
      configPath,
      nodeBin: "/usr/local/bin/node",
      port: 23333,
    });

    assert.strictEqual(secondResult.status, "ok");
    assert.strictEqual(secondResult.added, 0);
    assert.strictEqual(secondResult.updated, 0);
    assert.strictEqual(secondResult.skipped, 14);
  });

  it("updates stale hooks when node path or port changes", () => {
    const configPath = makeTempConfigFile({});
    registerNanoAgentHooks({
      silent: true,
      configPath,
      nodeBin: "/old/node",
      port: 23333,
    });

    const result = registerNanoAgentHooks({
      silent: true,
      configPath,
      nodeBin: "/new/node",
      port: 23334,
    });

    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.updated, 14);
    assert.strictEqual(result.skipped, 0);

    const config = readYaml(configPath);
    const commandHook = config.security.hooks.find((h) => h.type === "command");
    assert.ok(commandHook.command.includes("/new/node"));
    assert.ok(!commandHook.command.includes("/old/node"));

    const httpHook = config.security.hooks.find((h) => h.type === "http");
    assert.ok(httpHook.http.url.includes("23334"));
    assert.ok(!httpHook.http.url.includes("23333"));
  });

  it("preserves user-defined hooks", () => {
    const userHook = {
      name: "user-custom-hook",
      event: "pre_tool_use",
      pattern: "*",
      type: "command",
      command: "echo 'user hook'",
      enabled: true,
    };
    const configPath = makeTempConfigFile({
      security: { hooks: [userHook], allow_rules: ["user-rule"] },
    });

    registerNanoAgentHooks({ silent: true, configPath, nodeBin: "/usr/local/bin/node" });

    const config = readYaml(configPath);
    assert.ok(config.security.hooks.find((h) => h.name === "user-custom-hook"));
    assert.deepStrictEqual(config.security.allow_rules, ["user-rule"]);
  });

  it("errors on incompatible config shape (security is scalar)", () => {
    const configPath = makeTempConfigFile({ security: "not-an-object" });
    const result = registerNanoAgentHooks({ silent: true, configPath });
    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.reason, "config-shape-incompatible");
  });

  it("errors on incompatible config shape (security.hooks is scalar)", () => {
    const configPath = makeTempConfigFile({ security: { hooks: "not-an-array" } });
    const result = registerNanoAgentHooks({ silent: true, configPath });
    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.reason, "config-shape-incompatible");
  });

  it("registers hooks in remote mode (CLAWD_REMOTE=1 prefix)", () => {
    const configPath = makeTempConfigFile({});
    const result = registerNanoAgentHooks({
      silent: true,
      configPath,
      nodeBin: "/usr/local/bin/node",
      remote: true,
    });

    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.added, 14);

    const config = readYaml(configPath);
    const commandHook = config.security.hooks.find((h) => h.type === "command");
    assert.ok(commandHook.command.startsWith("CLAWD_REMOTE=1 "));
  });

  it("uninstalls all Clawd hooks", () => {
    const configPath = makeTempConfigFile({});
    registerNanoAgentHooks({ silent: true, configPath, nodeBin: "/usr/local/bin/node" });

    const config = readYaml(configPath);
    const beforeCount = config.security.hooks.length;
    assert.strictEqual(beforeCount, 14);

    const result = unregisterNanoAgentHooks({ silent: true, configPath });
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.removed, 14);

    const afterConfig = readYaml(configPath);
    assert.strictEqual(afterConfig.security.hooks.length, 0);
  });

  it("uninstalls only Clawd hooks, preserves user hooks", () => {
    const userHook = {
      name: "user-block-rm",
      event: "pre_tool_use",
      type: "command",
      command: "echo 'user'",
    };
    const configPath = makeTempConfigFile({ security: { hooks: [userHook] } });
    registerNanoAgentHooks({ silent: true, configPath, nodeBin: "/usr/local/bin/node" });

    const config = readYaml(configPath);
    assert.strictEqual(config.security.hooks.length, 15); // 14 Clawd + 1 user

    unregisterNanoAgentHooks({ silent: true, configPath });

    const afterConfig = readYaml(configPath);
    assert.strictEqual(afterConfig.security.hooks.length, 1);
    assert.strictEqual(afterConfig.security.hooks[0].name, "user-block-rm");
  });
});

describe("ensureSecurityHooksArray", () => {
  it("creates security.hooks array when missing", () => {
    const config = {};
    const hooks = ensureSecurityHooksArray(config);
    assert.ok(Array.isArray(hooks));
    assert.strictEqual(hooks.length, 0);
    assert.strictEqual(config.security.hooks, hooks);
  });

  it("returns null when security is array (incompatible)", () => {
    const config = { security: [] };
    assert.strictEqual(ensureSecurityHooksArray(config), null);
  });

  it("returns null when security.hooks is not array", () => {
    const config = { security: { hooks: "not-array" } };
    assert.strictEqual(ensureSecurityHooksArray(config), null);
  });
});

describe("isOurEntry", () => {
  it("identifies Clawd entries by name prefix", () => {
    assert.strictEqual(isOurEntry({ name: "clawd-on-desk:session_start" }), true);
    assert.strictEqual(isOurEntry({ name: "clawd-on-desk:permission_request" }), true);
  });

  it("rejects non-Clawd entries", () => {
    assert.strictEqual(isOurEntry({ name: "user-custom-hook" }), false);
    assert.strictEqual(isOurEntry({ name: "clawd-on-desk-custom" }), false);
    assert.strictEqual(isOurEntry({}), false);
    assert.strictEqual(isOurEntry(null), false);
  });
});
