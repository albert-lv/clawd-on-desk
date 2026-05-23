// Nano Agent configuration (Go-based CLI)
// Hook-based integration — JSON envelope on stdin (post-PR-210 contract)
// Settings: ~/.config/nano/config.yaml
// Docs: nano-agent/docs/features/HOOKS.md
//
// Event names are PascalCase (PreToolUse, SessionStart, etc.) — no snake_case normalization.

module.exports = {
  id: "nano-agent",
  name: "Nano Agent",
  processNames: {
    win: ["nano.exe"],
    mac: ["nano"],
    linux: ["nano"],
  },
  eventSource: "hook",
  // PascalCase event names → state strings
  eventMap: {
    SessionStart:       "idle",
    SessionEnd:         "idle",
    UserPromptSubmit:   "working",
    PreToolUse:         "working",
    PostToolUse:        "working",
    PostToolUseFailure: "working",
    Stop:               "idle",
    StopFailure:        "idle",
    SubagentStart:      "juggling",
    SubagentStop:       "working",
    PreCompact:         "working",
    PostCompact:        "working",
    PermissionRequest:  "needs-permission",
    Notification:       "notification",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: true,
    notificationHook: true,
    sessionEnd: true,
    subagent: true,
  },
  hookConfig: {
    configFormat: "nano-yaml",
  },
  stdinFormat: "nanoHookJson",
  pidField: "nano_pid",
};
