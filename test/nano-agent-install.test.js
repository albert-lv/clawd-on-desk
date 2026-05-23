const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  registerNanoAgentHooks,
  unregisterNanoAgentHooks,
  NANO_HOOK_EVENTS_BASE,
  NANO_HOOK_EVENTS_OPTIONAL,
  OUR_ID_PREFIX,
  DEFAULT_HOOK_TIMEOUT_SECONDS,
  PERMISSION_HOOK_TIMEOUT_SECONDS,
  ensureHooksMapping,
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

  it("registers all 14 events with both optionals on", () => {
    const configPath = makeTempConfigFile({});
    const result = registerNanoAgentHooks({
      silent: true,
      configPath,
      nodeBin: "/usr/local/bin/node",
      scriptPath: "/opt/clawd/hooks/nano-agent-hook.js",
      permissionsEnabled: true,
      notificationHookEnabled: true,
    });

    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.added, 14);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, 0);

    const config = readYaml(configPath);
    assert.ok(config.hooks);
    assert.ok(typeof config.hooks === "object" && !Array.isArray(config.hooks));

    // Verify all events have entries
    for (const event of [...NANO_HOOK_EVENTS_BASE, ...NANO_HOOK_EVENTS_OPTIONAL]) {
      assert.ok(Array.isArray(config.hooks[event]), `hooks.${event} should be an array`);
      const entry = config.hooks[event].find((e) => e.id && e.id.startsWith(OUR_ID_PREFIX));
      assert.ok(entry, `Missing Clawd entry for ${event}`);
      assert.strictEqual(entry.id, `${OUR_ID_PREFIX}${event}`);
      assert.strictEqual(entry.matcher, "*");
      assert.ok(entry.command.includes("/usr/local/bin/node"));
      assert.ok(entry.command.includes("/opt/clawd/hooks/nano-agent-hook.js"));
    }

    // Verify PermissionRequest has longer timeout
    const permEntry = config.hooks.PermissionRequest[0];
    assert.strictEqual(permEntry.timeout, PERMISSION_HOOK_TIMEOUT_SECONDS);

    // Verify other events have default timeout
    const startEntry = config.hooks.SessionStart[0];
    assert.strictEqual(startEntry.timeout, DEFAULT_HOOK_TIMEOUT_SECONDS);

    // No BinaryStop registered
    assert.strictEqual(config.hooks.BinaryStop, undefined);
  });

  it("omits PermissionRequest when permissionsEnabled=false", () => {
    const configPath = makeTempConfigFile({});
    const result = registerNanoAgentHooks({
      silent: true,
      configPath,
      nodeBin: "/usr/local/bin/node",
      permissionsEnabled: false,
      notificationHookEnabled: true,
    });

    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.added, 13);
    const config = readYaml(configPath);
    assert.strictEqual(config.hooks.PermissionRequest, undefined);
    assert.ok(Array.isArray(config.hooks.Notification));
  });

  it("omits Notification when notificationHookEnabled=false", () => {
    const configPath = makeTempConfigFile({});
    const result = registerNanoAgentHooks({
      silent: true,
      configPath,
      nodeBin: "/usr/local/bin/node",
      permissionsEnabled: true,
      notificationHookEnabled: false,
    });

    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.added, 13);
    const config = readYaml(configPath);
    assert.strictEqual(config.hooks.Notification, undefined);
    assert.ok(Array.isArray(config.hooks.PermissionRequest));
  });

  it("is idempotent on second run", () => {
    const configPath = makeTempConfigFile({});
    const firstResult = registerNanoAgentHooks({
      silent: true,
      configPath,
      nodeBin: "/usr/local/bin/node",
      permissionsEnabled: true,
      notificationHookEnabled: true,
    });
    assert.strictEqual(firstResult.added, 14);

    const secondResult = registerNanoAgentHooks({
      silent: true,
      configPath,
      nodeBin: "/usr/local/bin/node",
      permissionsEnabled: true,
      notificationHookEnabled: true,
    });

    assert.strictEqual(secondResult.status, "ok");
    assert.strictEqual(secondResult.added, 0);
    assert.strictEqual(secondResult.updated, 0);
    assert.strictEqual(secondResult.skipped, 14);
  });

  it("flipping permissionsEnabled off after install yields removed: 1", () => {
    const configPath = makeTempConfigFile({});
    registerNanoAgentHooks({
      silent: true,
      configPath,
      nodeBin: "/usr/local/bin/node",
      permissionsEnabled: true,
      notificationHookEnabled: true,
    });

    const result = registerNanoAgentHooks({
      silent: true,
      configPath,
      nodeBin: "/usr/local/bin/node",
      permissionsEnabled: false,
      notificationHookEnabled: true,
    });

    assert.strictEqual(result.removed, 1);
    assert.strictEqual(result.skipped, 13);
    const config = readYaml(configPath);
    assert.strictEqual(config.hooks.PermissionRequest, undefined);
  });

  it("updates stale entries when nodeBin changes", () => {
    const configPath = makeTempConfigFile({});
    registerNanoAgentHooks({
      silent: true,
      configPath,
      nodeBin: "/old/node",
      permissionsEnabled: true,
      notificationHookEnabled: true,
    });

    const result = registerNanoAgentHooks({
      silent: true,
      configPath,
      nodeBin: "/new/node",
      permissionsEnabled: true,
      notificationHookEnabled: true,
    });

    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.updated, 14);
    assert.strictEqual(result.skipped, 0);

    const config = readYaml(configPath);
    const entry = config.hooks.SessionStart[0];
    assert.ok(entry.command.includes("/new/node"));
    assert.ok(!entry.command.includes("/old/node"));
  });

  it("preserves user entries co-located under PreToolUse", () => {
    const userEntry = {
      id: "user-custom:PreToolUse",
      matcher: "*.py",
      command: "echo 'user hook'",
      timeout: 10,
    };
    const configPath = makeTempConfigFile({
      hooks: { PreToolUse: [userEntry] },
    });

    registerNanoAgentHooks({ silent: true, configPath, nodeBin: "/usr/local/bin/node" });

    const config = readYaml(configPath);
    assert.strictEqual(config.hooks.PreToolUse.length, 2);
    assert.ok(config.hooks.PreToolUse.find((e) => e.id === "user-custom:PreToolUse"));
  });

  it("preserves hooks.ralph across register call", () => {
    const configPath = makeTempConfigFile({
      hooks: { ralph: { loop_interval: 5, enabled: true } },
    });

    registerNanoAgentHooks({ silent: true, configPath, nodeBin: "/usr/local/bin/node" });

    const config = readYaml(configPath);
    assert.deepStrictEqual(config.hooks.ralph, { loop_interval: 5, enabled: true });
  });

  it("errors config-shape-incompatible when config.hooks is an array", () => {
    const configPath = makeTempConfigFile({ hooks: ["not", "a", "mapping"] });
    const result = registerNanoAgentHooks({ silent: true, configPath });
    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.reason, "config-shape-incompatible");
  });

  it("errors config-shape-incompatible when per-event value is not a list", () => {
    const configPath = makeTempConfigFile({ hooks: { SessionStart: "not-a-list" } });
    const result = registerNanoAgentHooks({ silent: true, configPath, nodeBin: "/usr/local/bin/node" });
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
    const entry = config.hooks.SessionStart[0];
    assert.ok(entry.command.startsWith("CLAWD_REMOTE=1 "));
  });

  it("uninstalls all Clawd entries; user entries + ralph survive", () => {
    const userEntry = {
      id: "user:PreToolUse",
      matcher: "*",
      command: "echo user",
      timeout: 5,
    };
    const configPath = makeTempConfigFile({
      hooks: {
        ralph: { loop_interval: 5 },
        PreToolUse: [userEntry],
      },
    });
    registerNanoAgentHooks({ silent: true, configPath, nodeBin: "/usr/local/bin/node" });

    const result = unregisterNanoAgentHooks({ silent: true, configPath });
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.removed, 14);

    const config = readYaml(configPath);
    // ralph survives
    assert.deepStrictEqual(config.hooks.ralph, { loop_interval: 5 });
    // user entry survives
    assert.strictEqual(config.hooks.PreToolUse.length, 1);
    assert.strictEqual(config.hooks.PreToolUse[0].id, "user:PreToolUse");
    // Empty event keys are deleted
    assert.strictEqual(config.hooks.SessionStart, undefined);
  });
});

describe("ensureHooksMapping", () => {
  it("creates hooks={} when missing", () => {
    const config = {};
    const mapping = ensureHooksMapping(config);
    assert.ok(mapping !== null);
    assert.deepStrictEqual(config.hooks, {});
  });

  it("returns null when hooks is an array", () => {
    const config = { hooks: [] };
    assert.strictEqual(ensureHooksMapping(config), null);
  });

  it("returns null when hooks is a scalar", () => {
    const config = { hooks: "scalar" };
    assert.strictEqual(ensureHooksMapping(config), null);
  });
});

describe("isOurEntry", () => {
  it("identifies entries by OUR_ID_PREFIX", () => {
    assert.strictEqual(isOurEntry({ id: "clawd-on-desk:SessionStart" }), true);
    assert.strictEqual(isOurEntry({ id: "clawd-on-desk:PermissionRequest" }), true);
  });

  it("rejects non-prefixed, empty, and null entries", () => {
    assert.strictEqual(isOurEntry({ id: "user-custom:PreToolUse" }), false);
    assert.strictEqual(isOurEntry({}), false);
    assert.strictEqual(isOurEntry(null), false);
  });
});
