"""Chat mode - Claude JSON streaming for web chat interface."""

import json
import os
import queue
import select
import subprocess
import threading

# Claude binary path - use system path or user-accessible location
# When running as sandboxer user, we need a path that user can access
CLAUDE_PATH = "/home/sandboxer/.local/bin/claude"
SYSTEM_PROMPT_PATH = "/home/sandboxer/git/sandboxer/system-prompt.txt"

# Active chat sessions: name -> (process, session_id)
# Note: process is None for one-shot mode (each message spawns a new process)
chat_sessions: dict[str, tuple] = {}

# Message history per session: name -> list of message dicts
chat_history: dict[str, list] = {}

# SSE subscribers per session: name -> list of queues
chat_subscribers: dict[str, list] = {}
subscribers_lock = threading.Lock()


def add_subscriber(name: str) -> queue.Queue:
    """Add a subscriber for session updates. Returns a queue to read from."""
    q = queue.Queue()
    with subscribers_lock:
        if name not in chat_subscribers:
            chat_subscribers[name] = []
        chat_subscribers[name].append(q)
    return q


def remove_subscriber(name: str, q: queue.Queue):
    """Remove a subscriber."""
    with subscribers_lock:
        if name in chat_subscribers and q in chat_subscribers[name]:
            chat_subscribers[name].remove(q)


def broadcast_message(name: str, message: dict):
    """Broadcast a message to all subscribers of a session."""
    # Store in history
    if name not in chat_history:
        chat_history[name] = []
    chat_history[name].append(message)

    # Broadcast to subscribers
    with subscribers_lock:
        if name in chat_subscribers:
            for q in chat_subscribers[name]:
                try:
                    q.put_nowait(message)
                except queue.Full:
                    pass


def get_history(name: str) -> list:
    """Get message history for a session."""
    return chat_history.get(name, [])


def init_chat_session(name: str, workdir: str, resume_id: str = None) -> str:
    """Initialize a chat session. Returns session_id (may be empty for new sessions)."""
    session_id = resume_id or ""
    chat_sessions[name] = (None, session_id)
    # Clear history for new sessions (no resume_id means fresh start)
    if not resume_id and name in chat_history:
        del chat_history[name]
    return session_id


def stop_chat_session(name: str) -> str:
    """Stop a chat session, return session_id for resume."""
    session_id = ""
    if name in chat_sessions:
        _, session_id = chat_sessions[name]
        del chat_sessions[name]
    return session_id


def get_chat_session(name: str):
    """Get chat session info. Returns (None, session_id) or None."""
    return chat_sessions.get(name)


def is_chat_session(name: str) -> bool:
    """Check if a session is a chat session."""
    return name in chat_sessions


def send_message(name: str, message: str, workdir: str, session_id: str = None):
    """Send a message and return a generator that yields JSON response lines.

    Each message spawns a new Claude process (one-shot mode).
    Claude requires stdin to be closed before it outputs, so we can't maintain
    a persistent process for bidirectional communication.
    """
    # Build command - same params as CLI sessions
    cmd = [
        CLAUDE_PATH, "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        "--system-prompt", SYSTEM_PROMPT_PATH,
    ]

    # Use session_id from parameter or from stored session
    if not session_id and name in chat_sessions:
        _, session_id = chat_sessions[name]

    if session_id:
        cmd.extend(["--resume", session_id])

    # Add the message as argument
    cmd.append(message)

    # Spawn process as 'sandboxer' user (Claude refuses --dangerously-skip-permissions as root)
    import pwd

    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env["HOME"] = "/home/sandboxer"
    env["IS_SANDBOX"] = "1"  # Same as CLI sessions

    # Get sandboxer user info
    try:
        sandboxer_user = pwd.getpwnam("sandboxer")
        user_uid = sandboxer_user.pw_uid
        user_gid = sandboxer_user.pw_gid
    except KeyError:
        user_uid = None
        user_gid = None

    def set_user():
        if user_uid is not None and user_gid is not None:
            os.setgid(user_gid)
            os.setuid(user_uid)

    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=workdir,
        env=env,
        bufsize=0,  # Unbuffered
        preexec_fn=set_user if user_uid else None,
    )


    # Close stdin immediately to let Claude process
    proc.stdin.close()

    # Brief pause to let process start
    import time
    time.sleep(0.1)

    # Generator that yields response lines
    def response_generator():
        import time
        new_session_id = None

        # Wait a moment for process to start outputting
        time.sleep(0.5)
        try:
            while True:
                poll_result = proc.poll()
                if poll_result is not None:
                    break
                ready, _, _ = select.select([proc.stdout], [], [], 0.1)
                if not ready:
                    continue
                line = proc.stdout.readline()
                if not line:
                    break
                try:
                    data = json.loads(line.decode())
                    # Capture session_id for future messages
                    if data.get("type") == "system" and data.get("subtype") == "init":
                        new_session_id = data.get("session_id", "")
                    yield line.decode().strip()
                except json.JSONDecodeError:
                    pass
        finally:
            # Update stored session_id
            if new_session_id and name in chat_sessions:
                chat_sessions[name] = (None, new_session_id)
            # Ensure process is cleaned up
            if proc.poll() is None:
                proc.terminate()

    return response_generator(), lambda: chat_sessions.get(name, (None, ""))[1]
