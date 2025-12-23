"""Chat mode - Claude JSON streaming for web chat interface.

Messages are persisted in SQLite for history across refreshes.
Claude's --resume handles conversation context.
"""

import json
import os
import queue
import select
import subprocess
import threading

from . import db

# Claude binary path
CLAUDE_PATH = "/home/sandboxer/.local/bin/claude"
SYSTEM_PROMPT_PATH = "/home/sandboxer/git/sandboxer/system-prompt.txt"

# Active chat sessions in memory: name -> (process, session_id)
chat_sessions: dict[str, tuple] = {}

# Track which sessions are currently processing (for cross-tab sync)
processing_sessions: set[str] = set()


def set_processing(name: str, is_processing: bool):
    """Mark a session as processing or not."""
    if is_processing:
        processing_sessions.add(name)
    else:
        processing_sessions.discard(name)


def is_processing(name: str) -> bool:
    """Check if a session is currently processing."""
    return name in processing_sessions


def restore_chat_sessions():
    """Restore chat sessions from database on server restart."""
    for session in db.get_chat_sessions():
        name = session['name']
        session_id = session.get('claude_session_id') or ""
        chat_sessions[name] = (None, session_id)


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
    """Broadcast a message to all subscribers (legacy - polling is now primary)."""
    with subscribers_lock:
        for q in chat_subscribers.get(name, []):
            try:
                q.put_nowait(message)
            except queue.Full:
                pass


def init_chat_session(name: str, workdir: str, resume_id: str = None) -> str:
    """Initialize a chat session. Returns session_id (may be empty for new sessions)."""
    session_id = resume_id or ""
    chat_sessions[name] = (None, session_id)

    # Ensure session exists in database
    db.upsert_session(
        name=name,
        workdir=workdir,
        session_type='chat',
        mode='chat',
        claude_session_id=session_id if session_id else None
    )

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


def get_history(name: str, limit: int = 100, offset: int = 0) -> list[dict]:
    """Get chat message history from database."""
    return db.get_messages(name, limit=limit, offset=offset)


def save_message(name: str, role: str, content: str, metadata: dict = None):
    """Save a message to the database."""
    db.add_message(name, role, content, metadata)


def send_message(name: str, message: str, workdir: str, session_id: str = None):
    """Send a message and return a generator that yields JSON response lines.

    Each message spawns a new Claude process (one-shot mode).
    Claude requires stdin to be closed before it outputs, so we can't maintain
    a persistent process for bidirectional communication.
    """
    # Save user message to database
    save_message(name, 'user', message)

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
        assistant_text = []  # Collect assistant response text

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

                    # Collect assistant text for database storage
                    if data.get("type") == "assistant":
                        content = data.get("message", {}).get("content", [])
                        for block in content:
                            if block.get("type") == "text":
                                assistant_text.append(block.get("text", ""))

                    # Also collect streaming deltas
                    if data.get("type") == "content_block_delta":
                        delta = data.get("delta", {}).get("text", "")
                        if delta:
                            assistant_text.append(delta)

                    yield line.decode().strip()
                except json.JSONDecodeError:
                    pass
        finally:
            # Save assistant response to database
            full_response = "".join(assistant_text)
            if full_response:
                save_message(name, 'assistant', full_response)

            # Update stored session_id
            if new_session_id:
                if name in chat_sessions:
                    chat_sessions[name] = (None, new_session_id)
                # Also save to database
                db.update_session_field(name, 'claude_session_id', new_session_id)

            # Ensure process is cleaned up
            if proc.poll() is None:
                proc.terminate()

    return response_generator(), lambda: chat_sessions.get(name, (None, ""))[1]
