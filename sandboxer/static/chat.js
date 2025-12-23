/* Sandboxer - Fullscreen Chat Page JavaScript */

const sessionName = window.SANDBOXER_SESSION;
const messagesContainer = document.getElementById("chat-messages");
const textarea = document.getElementById("chat-textarea");
const sendBtn = document.getElementById("send-btn");
const toggleBtn = document.getElementById("toggle-btn");
const killBtn = document.getElementById("kill-btn");
const sshBtn = document.getElementById("ssh-btn");
const imgBtn = document.getElementById("img-btn");
const imgBtnMobile = document.getElementById("img-btn-mobile");
const imageInput = document.getElementById("image-input");

// Toast helper
function showToast(message, type = "info") {
  const toast = document.getElementById("paste-toast");
  if (!toast) return;
  toast.textContent = message;
  toast.className = "paste-toast show " + type;
  setTimeout(() => {
    toast.classList.remove("show");
  }, 3000);
}

// Render a chat message bubble
function renderMessage(role, content) {
  const bubble = document.createElement("div");
  bubble.className = "chat-message " + role;
  bubble.textContent = content;
  messagesContainer.appendChild(bubble);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
  return bubble;
}

// Send message to Claude
async function sendMessage() {
  const message = textarea.value.trim();
  if (!message) return;

  // Render user message
  renderMessage("user", message);
  textarea.value = "";
  textarea.style.height = "auto";

  // Disable send button
  sendBtn.disabled = true;
  sendBtn.textContent = "...";

  // Show thinking spinner
  const thinkingEl = document.createElement("div");
  thinkingEl.className = "chat-message assistant thinking";
  thinkingEl.innerHTML = '<span is-="spinner" variant-="dots"></span> thinking';
  messagesContainer.appendChild(thinkingEl);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;

  // State for streaming response
  let currentBubble = null;
  let currentText = "";
  let removedThinking = false;
  let streamedResponse = false;  // Track if we got streaming (skip final assistant msg)

  // Mark as sending to skip sync messages
  window.activeSending = true;

  try {
    const res = await fetch("/api/chat-send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: sessionName, message: message }),
    });

    if (!res.ok) {
      showToast("Failed to send message", "error");
      return;
    }

    // Read SSE stream from POST response
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (!data || data === "{}") continue;

          try {
            const event = JSON.parse(data);

            // Handle title update
            if (event.type === "title_update" && event.title) {
              document.title = event.title + " - Sandboxer";
              const titleEl = document.querySelector(".chat-title");
              if (titleEl) titleEl.textContent = event.title;
              continue;
            }

            if (event.type === "assistant") {
              // Skip if we already rendered via streaming
              if (streamedResponse) continue;

              // Remove thinking spinner
              if (!removedThinking) {
                thinkingEl.remove();
                removedThinking = true;
              }
              const content = event.message && event.message.content;
              if (content && Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === "text" && block.text) {
                    if (!currentBubble) {
                      currentBubble = renderMessage("assistant", "");
                    }
                    currentBubble.textContent = block.text;
                  }
                }
              }
            } else if (event.type === "content_block_start") {
              // Remove thinking spinner
              if (!removedThinking) {
                thinkingEl.remove();
                removedThinking = true;
              }
              if (event.content_block && event.content_block.type === "text") {
                streamedResponse = true;  // Mark that we got streaming
                currentBubble = document.createElement("div");
                currentBubble.className = "chat-message assistant streaming";
                messagesContainer.appendChild(currentBubble);
                currentText = "";
                messagesContainer.scrollTop = messagesContainer.scrollHeight;
              }
            } else if (event.type === "content_block_delta") {
              const delta = event.delta && event.delta.text;
              if (delta && currentBubble) {
                currentText += delta;
                currentBubble.textContent = currentText;
                messagesContainer.scrollTop = messagesContainer.scrollHeight;
              }
            } else if (event.type === "content_block_stop") {
              if (currentBubble) {
                currentBubble.classList.remove("streaming");
              }
            } else if (event.type === "result") {
              if (currentBubble) {
                currentBubble.classList.remove("streaming");
              }
            }
          } catch (e) {
            console.error("Failed to parse SSE data:", e);
          }
        }
      }
    }
  } catch (err) {
    console.error("Chat error:", err);
    showToast("Failed to send message", "error");
  } finally {
    // Clean up thinking spinner if still present
    if (!removedThinking && thinkingEl.parentNode) {
      thinkingEl.remove();
    }
    sendBtn.disabled = false;
    sendBtn.textContent = "Send";
    window.activeSending = false;  // Allow sync messages again
  }
}

// Toggle to CLI mode
async function toggleToCLI() {
  toggleBtn.disabled = true;
  toggleBtn.textContent = "...";

  try {
    const res = await fetch("/api/chat-toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: sessionName, target_mode: "cli" }),
    });

    const data = await res.json();
    if (data.ok) {
      // Redirect to terminal view
      window.location.href = "/terminal?session=" + encodeURIComponent(sessionName);
    } else {
      showToast("Failed to switch to CLI", "error");
      toggleBtn.disabled = false;
      toggleBtn.textContent = "cli";
    }
  } catch (err) {
    showToast("Failed to switch to CLI", "error");
    toggleBtn.disabled = false;
    toggleBtn.textContent = "cli";
  }
}

// Kill session
async function killSession() {
  if (!confirm("Kill session " + sessionName + "?")) return;

  try {
    await fetch("/kill?session=" + encodeURIComponent(sessionName));
    window.close();
    // If window.close() doesn't work, redirect to home
    setTimeout(() => {
      window.location.href = "/";
    }, 500);
  } catch (err) {
    showToast("Failed to kill session", "error");
  }
}

// Copy SSH command
async function copySSH() {
  const host = window.location.hostname;
  const cmd = `ssh -t sandboxer@${host} "sudo tmux attach -t '${sessionName}'"`;

  try {
    await navigator.clipboard.writeText(cmd);
    showToast("Copied: " + cmd, "success");
  } catch (err) {
    // Fallback copy
    const ta = document.createElement("textarea");
    ta.value = cmd;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    showToast("Copied: " + cmd, "success");
  }
}

// Image upload
let pasteTimeout = null;

function triggerImageUpload() {
  const isMobile = window.matchMedia("(pointer: coarse)").matches;
  if (isMobile) {
    imageInput.click();
  } else {
    // Desktop: enable paste mode
    showToast("Ctrl+V to paste, or double-click to browse", "info");
    clearTimeout(pasteTimeout);
    pasteTimeout = setTimeout(() => {
      showToast("Paste timed out", "info");
    }, 10000);
  }
}

async function uploadImage(file) {
  if (!file || !file.type.startsWith("image/")) {
    showToast("Not an image", "error");
    return;
  }

  showToast("Uploading...", "info");

  try {
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(",")[1]);
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.readAsDataURL(file);
    });

    const filename = file.name || `upload_${Date.now()}.png`;
    const res = await fetch("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: base64, filename })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Upload failed");

    // Append path to textarea
    textarea.value = textarea.value + (textarea.value ? " " : "") + data.path;
    textarea.focus();
    showToast(data.path, "success");
  } catch (err) {
    showToast("Upload failed: " + err.message, "error");
  }
}

// Auto-resize textarea
function autoResize() {
  textarea.style.height = "auto";
  textarea.style.height = Math.min(textarea.scrollHeight, 200) + "px";
}

// Event listeners
sendBtn.addEventListener("click", sendMessage);

// Keyboard handling:
// - PC: Enter = send, Alt+Enter or Shift+Enter = newline
// - Mobile: Enter = newline (natural behavior)
const isMobile = window.matchMedia("(pointer: coarse)").matches;

textarea.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    if (isMobile) {
      // Mobile: let Enter create newlines naturally
      return;
    }
    // PC: Enter sends, Alt+Enter or Shift+Enter for newline
    if (!e.altKey && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }
});

textarea.addEventListener("input", autoResize);

toggleBtn.addEventListener("click", toggleToCLI);
killBtn.addEventListener("click", killSession);
sshBtn.addEventListener("click", copySSH);
imgBtn.addEventListener("click", triggerImageUpload);
imgBtn.addEventListener("dblclick", () => imageInput.click());

// Mobile image button - direct file picker (always available beside send)
if (imgBtnMobile) {
  imgBtnMobile.addEventListener("click", () => imageInput.click());
}

imageInput.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) uploadImage(file);
  e.target.value = "";
});

// Handle paste for image upload
document.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) {
        uploadImage(file);
        clearTimeout(pasteTimeout);
        return;
      }
    }
  }
});

// Focus textarea on load
textarea.focus();

// ═══ Sync with other tabs ═══

let syncConnection = null;

function connectSync() {
  if (syncConnection) return;

  const es = new EventSource("/api/chat-sync?session=" + encodeURIComponent(sessionName));
  syncConnection = es;

  es.onmessage = (e) => {
    if (!e.data || e.data === "{}") return;

    // Skip sync messages while we're sending (we render directly from POST)
    if (window.activeSending) return;

    try {
      const event = JSON.parse(e.data);

      // Handle title update from other tab
      if (event.type === "title_update" && event.title) {
        document.title = event.title + " - Sandboxer";
        const titleEl = document.querySelector(".chat-title");
        if (titleEl) titleEl.textContent = event.title;
        return;
      }

      // Handle synced messages and history
      if (event.type === "user_message") {
        renderMessage("user", event.content);
      } else if (event.type === "assistant_message") {
        // Clean format from history
        renderMessage("assistant", event.content);
      } else if (event.type === "assistant") {
        // Live streaming format
        const content = event.message?.content;
        if (content && Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) {
              renderMessage("assistant", block.text);
            }
          }
        }
      } else if (event.type === "result") {
        // Show result summary
        const cost = event.total_cost_usd ? "$" + event.total_cost_usd.toFixed(4) : "";
        const duration = event.duration_ms ? (event.duration_ms / 1000).toFixed(1) + "s" : "";
        if (cost || duration) {
          const bubble = document.createElement("div");
          bubble.className = "chat-message system";
          bubble.textContent = "done " + [duration, cost].filter(Boolean).join(" · ");
          messagesContainer.appendChild(bubble);
          messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }
      }
    } catch (err) {
      console.error("Sync error:", err);
    }
  };

  es.onerror = () => {
    syncConnection = null;
    setTimeout(connectSync, 2000);
  };
}

// Connect sync on load
connectSync();

// ═══ iOS Safari keyboard handling ═══
// Use visualViewport API to position input above keyboard

const inputArea = document.querySelector(".chat-composer");
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
              (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

if (isIOS && window.visualViewport && inputArea) {
  const vv = window.visualViewport;

  function positionInput() {
    // Position input at bottom of visual viewport
    const offsetTop = vv.offsetTop;
    const height = vv.height;
    inputArea.style.position = "fixed";
    inputArea.style.top = (offsetTop + height) + "px";
    inputArea.style.bottom = "auto";
    inputArea.style.transform = "translateY(-100%)";

    // Scroll messages to bottom
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  vv.addEventListener("resize", positionInput);
  vv.addEventListener("scroll", positionInput);
  positionInput();

  // Also position on focus (keyboard opening)
  textarea.addEventListener("focus", () => {
    setTimeout(positionInput, 100);
    setTimeout(positionInput, 300);
  });
} else {
  // Non-iOS: just scroll to bottom on focus
  textarea.addEventListener("focus", () => {
    setTimeout(() => {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }, 300);
  });
}
