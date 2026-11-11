# 会话 API（MCP）

`bin/dst-mcp.js` 是一个 stdio MCP 服务器，把 `dst session …` 的能力暴露给任意 agent
（DSH、Claude Code、Codex）：列出、查询、尾读、续跑和分叉**其他** DSH 会话，不需要 TUI。
工具调用走同一条 CLI 语法与同一个官方 adapter，所以命令行与工具的行为、退出码和错误码一致。

## 安装

```json
// ~/.mcp.json （与已有内容合并，不要覆盖）
{
  "mcpServers": {
    "dsh-sessions": {
      "command": "node",
      "args": ["/Users/username/Docs/dsh-tui-fork/bin/dst-mcp.js"]
    }
  }
}
```

DSH 的 `mcp-claude` 插件在挂载时读取 `~/.mcp.json`（`sources`），重启 TUI 后工具以
`mcp__dsh-sessions__*` 出现；Claude Code 可直接把同一段写进 `~/.claude.json`。
`node` 需要在 PATH 上，或把 `command` 换成 node 的绝对路径。

## 工具

| 工具 | 作用 | 限制 |
| --- | --- | --- |
| `sessions_list` | 当前 cwd 的会话：`sessionId`、`kind`（root/fork/subagent）、`ownerPid`、可选的 `title` | 默认 50，最多 200；`titles` 会读取每个会话日志，较慢 |
| `session_status` | 一个会话：标题、cwd、kind、preset、事件数、最后事件、是否在跑、持有进程 pid | 读取完整会话日志 |
| `session_tail` | 最近事件：`seq`、`type`、`time`、截断到 500 字符的文本、工具名 | 默认 20，最多 200 |
| `session_fork` | 复制到最后关闭的回合，生成 `parentSession` = 源的新会话；源日志不改动 | 写入；子会话继承源的 `agentPreset` |
| `session_prompt` | 在空闲会话里跑一个 headless 回合并返回答案 | 被占用 → `SESSION_OCCUPIED`；带 preset → `SESSION_PRESET_UNSUPPORTED` |

## 限制（明确不支持）

- **给正在 TUI 里工作的会话发消息**：没有跨进程 IPC/队列。`session_prompt` 会先读
  `~/.dsh-tui/session-mounts.json`，发现持有进程就以 `SESSION_OCCUPIED` 拒绝；
  该文件损坏或版本未知时按“无法确认”拒绝（`SESSION_OCCUPIED_UNAVAILABLE`），而不是当空闲。
- **带 `agentPreset` 的会话不能 headless 续跑**（headless profile 不组合这些 preset）：
  先 `session_fork`，再在 TUI 的 `/resume` 里继续。
- **任意切点未实现**：只按“最后一个已关闭回合”分叉；没有关闭回合的会话返回
  `SESSION_FORK_UNAVAILABLE`。
- **MCP 不是沙箱**：工具以启动它的用户身份执行 `dst`，`session_prompt` 会真实运行模型回合。

## 命令行等价物

```sh
dst session list --json [--all] [--limit N] [--titles]
dst session status <id> --json
dst session tail <id> --json [--limit N]
dst session fork <id> --json [--title T]
dst run --session-id <id> "任务"
```

协议帧、退出码与版本限制见[自动化 CLI](cli.md)。
