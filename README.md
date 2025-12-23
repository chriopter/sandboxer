<p align="center">
  <img src="logo.png" width="100" /><br><br>
  <b>Sandboxer</b><br><br>
  Give Claude root access to a disposable machine and let it run autonomously.<br>
  Monitor multiple agents live, take over via SSH, or switch to chat UI on mobile.
</p>

---

<img width="100%" alt="Dashboard" src="https://github.com/user-attachments/assets/e6105295-a898-4070-bc06-3458777144ec" />

## Features

- **Live previews** - See all sessions at a glance in a grid layout
- **Session persistence** - tmux-backed sessions survive restarts; chat sessions persist via Claude's `--resume` with stored session UUIDs
- **SSH takeover** - `ssh -t sandboxer@host sandboxer-shell` to take over sessions (TAB for multi-select split view)
- **Drag & drop** - Reorder sessions your way
- **Resume sessions** - Pick up previous Claude conversations
- **Multiple directories** - Run Claude in different project contexts
- **Image paste** - Ctrl+V images directly into terminal
- **Gemini CLI** - Claude can use Google's Gemini for second opinions

<img width="500" alt="SSH takeover" src="https://github.com/user-attachments/assets/e748762f-077a-48ef-82de-fad7c351a863" />

## Install

1. Install [Claude Code](https://docs.anthropic.com/en/docs/claude-code) on a dedicated/disposable machine

2. Run:
   ```bash
   claude --dangerously-skip-permissions "clone github.com/anthropics/sandboxer to /home/sandboxer/sandboxer-repo, read CLAUDE.md, then install: deps (python3 tmux ttyd caddy lazygit gemini-cli), copy service files, enable and start services"
   ```

3. Access at `http://<host>:8080` — default: `admin` / `admin`

4. Change password: `claude --dangerously-skip-permissions "change sandboxer password to YOUR_PASSWORD"`

5. Clone repos: `claude --dangerously-skip-permissions "clone github.com/user/repo to /home/sandboxer/git/repo"`

## Security

> **Warning**: This gives Claude complete control of a machine. Only use on a disposable VM without secrets.

## Technical

<details>
<summary>Session Persistence</summary>

CLI sessions use tmux for persistence. Chat sessions store Claude's session UUID for `--resume`. Both are tracked in `/etc/sandboxer/session_meta.json`:

```json
{
  "sandboxer-claude-1": {
    "workdir": "/home/sandboxer/git/myproject",
    "type": "claude",
    "mode": "cli"
  },
  "sandboxer-chat-1": {
    "workdir": "/home/sandboxer/git/myproject",
    "type": "chat",
    "mode": "chat",
    "claude_session_id": "abc123-def456-..."
  }
}
```

Chat message history is stored separately in `/etc/sandboxer/chat_history.json` and sent via SSE on page load.

</details>

---

Built with [webtui](https://github.com/webtui/webtui)
