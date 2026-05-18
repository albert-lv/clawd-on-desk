// Nano Agent configuration (Go-based CLI)
// Hook-based integration — payload via NANO_HOOK_INPUT env var
// Settings: ~/.config/nano/config.yaml
// Docs: nano-agent/docs/features/HOOKS.md
//
// Event names are snake_case (e.g. pre_tool_use, session_start) and must be
// normalized to PascalCase (PreToolUse, SessionStart) before feeding state machine.

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
    SessionStart:          "idle",
    SessionEnd:            "sleeping",
    UserPromptSubmit:      "thinking",
    PreToolUse:            "working",
    PostToolUse:           "working",
    PostToolUseFailure:    "error",
    Stop:                  "attention",
    StopFailure:           "error",
    SubagentStart:         "juggling",
    SubagentStop:          "working",
    PreCompact:            "sweeping",
    PostCompact:           "attention",
    Notification:          "notification",
    PermissionRequest:     "notification",
  },
  capabilities: {
    httpHook: true,
    permissionApproval: true,
    notificationHook: true,
    sessionEnd: true,
    subagent: true,
  },
  hookConfig: {
    configFormat: "nano-yaml",
  },
  stdinFormat: "nanoHookEnv",
  pidField: "nano_pid",
};
