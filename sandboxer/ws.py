#!/usr/bin/env python3
"""WebSocket terminal server - connects xterm.js to tmux sessions."""

import asyncio
import fcntl
import json
import os
import pty
import signal
import struct
import termios

import websockets


async def handle_client(websocket):
    """Handle a WebSocket client connection."""
    master_fd = None
    pid = None
    read_task = None

    async def pty_reader():
        """Read from PTY and send to WebSocket."""
        nonlocal master_fd
        loop = asyncio.get_event_loop()
        while master_fd is not None:
            try:
                data = await loop.run_in_executor(None, lambda: os.read(master_fd, 65536))
                if data:
                    await websocket.send(data)
            except (OSError, BlockingIOError):
                await asyncio.sleep(0.01)
            except Exception:
                break

    try:
        async for message in websocket:
            if isinstance(message, str):
                try:
                    msg = json.loads(message)
                    # Only treat as control message if it's a dict with action key
                    if not isinstance(msg, dict) or "action" not in msg:
                        raise ValueError("Not a control message")
                    action = msg.get("action")

                    if action == "attach":
                        session = msg.get("session")
                        if not session:
                            continue

                        # Cleanup previous
                        if read_task:
                            read_task.cancel()
                            try:
                                await read_task
                            except asyncio.CancelledError:
                                pass
                        if master_fd is not None:
                            os.close(master_fd)
                        if pid is not None:
                            try:
                                os.kill(pid, signal.SIGTERM)
                            except ProcessLookupError:
                                pass

                        # Create PTY and fork
                        master_fd, slave_fd = pty.openpty()
                        pid = os.fork()

                        if pid == 0:
                            # Child
                            os.close(master_fd)
                            os.setsid()
                            os.dup2(slave_fd, 0)
                            os.dup2(slave_fd, 1)
                            os.dup2(slave_fd, 2)
                            os.close(slave_fd)
                            os.environ["TERM"] = "xterm-256color"
                            os.execvp("tmux", ["tmux", "attach-session", "-t", session])

                        os.close(slave_fd)

                        # Non-blocking
                        flags = fcntl.fcntl(master_fd, fcntl.F_GETFL)
                        fcntl.fcntl(master_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

                        # Resize
                        rows = msg.get("rows", 24)
                        cols = msg.get("cols", 80)
                        winsize = struct.pack("HHHH", rows, cols, 0, 0)
                        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, winsize)

                        # Start reader
                        read_task = asyncio.create_task(pty_reader())
                        await websocket.send(json.dumps({"status": "attached", "session": session}))

                    elif action == "resize":
                        if master_fd is not None:
                            rows = msg.get("rows", 24)
                            cols = msg.get("cols", 80)
                            winsize = struct.pack("HHHH", rows, cols, 0, 0)
                            fcntl.ioctl(master_fd, termios.TIOCSWINSZ, winsize)

                    elif action == "detach":
                        if read_task:
                            read_task.cancel()
                        if master_fd is not None:
                            os.close(master_fd)
                            master_fd = None
                        if pid is not None:
                            try:
                                os.kill(pid, signal.SIGTERM)
                            except ProcessLookupError:
                                pass
                            pid = None

                except (json.JSONDecodeError, ValueError):
                    # Terminal input as string (including numbers which are valid JSON)
                    if master_fd is not None:
                        os.write(master_fd, message.encode())

            elif isinstance(message, bytes):
                # Binary terminal input
                if master_fd is not None:
                    os.write(master_fd, message)

    finally:
        if read_task:
            read_task.cancel()
        if master_fd is not None:
            os.close(master_fd)
        if pid is not None:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass


async def main(host: str = "127.0.0.1", port: int = 8082):
    """Start WebSocket server."""
    async with websockets.serve(handle_client, host, port, max_size=10 * 1024 * 1024):
        print(f"ws://{ host}:{port}")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
