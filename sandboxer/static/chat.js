/* Sandboxer - Chat Page JavaScript */

const SESSION_NAME = window.SANDBOXER_SESSION || "";
const WORKDIR = window.SANDBOXER_WORKDIR || "/home/sandboxer";

// DOM Elements
const messagesContainer = document.getElementById("chatMessages");
const chatEmpty = document.getElementById("chatEmpty");
const chatInput = document.getElementById("chatInput");
const sendBtn = document.getElementById("send-btn");
const attachBtn = document.getElementById("attach-btn");
const fileInput = document.getElementById("file-input");
const clearBtn = document.getElementById("clear-btn");
const killBtn = document.getElementById("kill-btn");
const chatStatus = document.getElementById("chatStatus");
const toast = document.getElementById("toast");

// State
let isStreaming = false;
let lastMessageId = 0;
let pollInterval = null;

// ═══ Toast Notifications ═══

function showToast(message, type = "info") {
  if (!toast) return;
  toast.textContent = message;
  toast.className = `paste-toast ${type} show`;
  setTimeout(() => toast.classList.remove("show"), 3000);
}

// ═══ Auto-resize Textarea ═══

function autoResize() {
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, 150) + "px";
}

chatInput?.addEventListener("input", autoResize);

// ═══ Message Rendering ═══

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function formatMessage(text) {
  // Basic markdown-like formatting
  let html = escapeHtml(text);

  // Code blocks (```...```)
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code>${code.trim()}</code></pre>`;
  });

  // Inline code (`...`)
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Bold (**...** or __...__)
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");

  // Italic (*...* or _..._)
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(/_([^_]+)_/g, "<em>$1</em>");

  // Line breaks
  html = html.replace(/\n/g, "<br>");

  return html;
}

function createMessageElement(message) {
  const div = document.createElement("div");
  div.className = `chat-message ${message.role}`;
  div.dataset.messageId = message.id;

  if (message.status === "thinking" || message.status === "streaming") {
    div.classList.add("thinking");
  }

  if (message.role === "error") {
    div.classList.add("error");
  }

  div.innerHTML = formatMessage(message.content);
  return div;
}

function renderMessages(messages) {
  if (!messages || messages.length === 0) {
    chatEmpty.style.display = "";
    return;
  }

  chatEmpty.style.display = "none";

  messages.forEach(msg => {
    const existing = messagesContainer.querySelector(`[data-message-id="${msg.id}"]`);

    if (existing) {
      // Update existing message
      existing.innerHTML = formatMessage(msg.content);
      existing.className = `chat-message ${msg.role}`;
      if (msg.status === "thinking" || msg.status === "streaming") {
        existing.classList.add("thinking");
      }
    } else {
      // Check if this is a real message that replaces an optimistic one
      if (msg.id > 0 && msg.role === "user") {
        // Remove any optimistic user messages (negative IDs)
        messagesContainer.querySelectorAll('.chat-message.user[data-message-id^="-"]').forEach(el => el.remove());
      }

      // Add new message
      const el = createMessageElement(msg);
      messagesContainer.appendChild(el);
    }

    // Only track positive IDs for polling
    if (msg.id > 0) {
      lastMessageId = Math.max(lastMessageId, msg.id);
    }
  });

  scrollToBottom();
}

function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// ═══ API Calls ═══

async function loadMessages() {
  try {
    const res = await fetch(`/api/chat/messages?session=${encodeURIComponent(SESSION_NAME)}`);
    const data = await res.json();

    if (data.messages) {
      renderMessages(data.messages);
    }
  } catch (err) {
    console.error("Failed to load messages:", err);
  }
}

async function pollMessages() {
  if (!isStreaming) return;

  try {
    const res = await fetch(`/api/chat/poll?session=${encodeURIComponent(SESSION_NAME)}&since=${lastMessageId}`);
    const data = await res.json();

    if (data.messages && data.messages.length > 0) {
      renderMessages(data.messages);

      // Check if we got a complete assistant response
      const hasCompleteAssistant = data.messages.some(m => m.role === "assistant" && m.status === "complete");
      const hasActiveMessage = data.messages.some(m => m.status === "thinking" || m.status === "streaming");

      if (hasCompleteAssistant && !hasActiveMessage) {
        // Got the response, stop polling
        isStreaming = false;
        setStatus("");
        enableInput();
        stopPolling();
      }
    }
  } catch (err) {
    console.error("Poll error:", err);
  }
}

async function sendMessage(content) {
  if (!content.trim() || isStreaming) return;

  // Disable input while processing
  isStreaming = true;
  disableInput();
  setStatus("thinking");

  // Store the lastMessageId before optimistic render so polling works correctly
  const pollFromId = lastMessageId;

  // Optimistically add user message to UI (use negative temp ID to avoid conflicts)
  const tempUserMsg = {
    id: -Date.now(),  // Negative to not affect lastMessageId
    role: "user",
    content: content.trim(),
    status: "complete"
  };
  renderMessages([tempUserMsg]);

  try {
    const res = await fetch("/api/chat/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session: SESSION_NAME,
        message: content.trim()
      })
    });

    const data = await res.json();

    if (!data.ok) {
      throw new Error(data.error || "Failed to send message");
    }

    // Reset lastMessageId to poll from before the optimistic message
    lastMessageId = pollFromId;

    // Start polling for response
    startPolling();

  } catch (err) {
    console.error("Send error:", err);
    showToast("Failed to send: " + err.message, "error");
    isStreaming = false;
    setStatus("");
    enableInput();
  }
}

async function clearChat() {
  if (!confirm("Clear all messages in this chat?")) return;

  try {
    const res = await fetch("/api/chat/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: SESSION_NAME })
    });

    const data = await res.json();

    if (data.ok) {
      // Clear UI
      messagesContainer.querySelectorAll(".chat-message").forEach(el => el.remove());
      chatEmpty.style.display = "";
      lastMessageId = 0;
      showToast("Chat cleared", "success");
    }
  } catch (err) {
    showToast("Failed to clear chat", "error");
  }
}

async function killSession() {
  if (killBtn.classList.contains("confirm")) {
    await fetch("/kill?session=" + encodeURIComponent(SESSION_NAME));
    window.location.href = "/";
  } else {
    killBtn.classList.add("confirm");
    killBtn.textContent = "confirm?";
    setTimeout(() => {
      killBtn.classList.remove("confirm");
      killBtn.textContent = "×";
    }, 2000);
  }
}

// ═══ Polling ═══

function startPolling() {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(pollMessages, 500);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

// ═══ UI State ═══

function setStatus(status) {
  if (!chatStatus) return;

  if (status === "thinking") {
    chatStatus.textContent = "thinking";
    chatStatus.className = "chat-status thinking";
  } else {
    chatStatus.textContent = "";
    chatStatus.className = "chat-status";
  }
}

function disableInput() {
  chatInput.disabled = true;
  sendBtn.disabled = true;
}

function enableInput() {
  chatInput.disabled = false;
  sendBtn.disabled = false;
  chatInput.focus();
}

// ═══ File Upload ═══

async function uploadFile(file) {
  const reader = new FileReader();

  return new Promise((resolve, reject) => {
    reader.onload = async () => {
      try {
        const base64 = reader.result.split(",")[1];
        const filename = file.name || `file_${Date.now()}`;

        const res = await fetch("/api/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: base64, filename })
        });

        const data = await res.json();
        if (data.ok) {
          resolve(data.path);
        } else {
          reject(new Error(data.error || "Upload failed"));
        }
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

async function handleFileUpload(files) {
  if (!files || files.length === 0) return;

  const fileArray = Array.from(files);
  showToast(`Uploading ${fileArray.length} file(s)...`, "info");

  const paths = [];
  for (const file of fileArray) {
    try {
      const path = await uploadFile(file);
      paths.push(path);
    } catch (err) {
      showToast("Upload failed: " + err.message, "error");
    }
  }

  if (paths.length > 0) {
    // Add file paths to input
    const currentText = chatInput.value;
    const separator = currentText && !currentText.endsWith(" ") ? " " : "";
    chatInput.value = currentText + separator + paths.join(" ") + " ";
    chatInput.focus();
    autoResize();
    showToast(`Uploaded ${paths.length} file(s)`, "success");
  }
}

// ═══ Event Handlers ═══

// Send button
sendBtn?.addEventListener("click", () => {
  sendMessage(chatInput.value);
  chatInput.value = "";
  autoResize();
});

// Enter to send (Shift+Enter for newline)
chatInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage(chatInput.value);
    chatInput.value = "";
    autoResize();
  }
});

// Attach button
attachBtn?.addEventListener("click", () => {
  fileInput?.click();
});

// File input change
fileInput?.addEventListener("change", (e) => {
  handleFileUpload(e.target.files);
  e.target.value = "";
});

// Clear button
clearBtn?.addEventListener("click", clearChat);

// Kill button
killBtn?.addEventListener("click", killSession);

// Paste handler for images
chatInput?.addEventListener("paste", async (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;

  for (const item of items) {
    if (item.type.startsWith("image/")) {
      e.preventDefault();
      const file = item.getAsFile();
      if (file) {
        handleFileUpload([file]);
      }
      return;
    }
  }
});

// ═══ Initialization ═══

(function init() {
  // Load existing messages
  loadMessages();

  // Focus input
  chatInput?.focus();

  // Start background polling to catch any updates (relaxed for single-user)
  let bgPollInterval = setInterval(() => {
    if (!isStreaming && !document.hidden) {
      // Light polling when not actively streaming and tab visible
      fetch(`/api/chat/poll?session=${encodeURIComponent(SESSION_NAME)}&since=${lastMessageId}`)
        .then(res => res.json())
        .then(data => {
          if (data.messages && data.messages.length > 0) {
            renderMessages(data.messages);
          }
        })
        .catch(() => {});
    }
  }, 10000);  // 10s instead of 5s

  // Pause background polling when tab hidden
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearInterval(bgPollInterval);
    } else {
      // Resume and poll immediately
      if (!isStreaming) {
        fetch(`/api/chat/poll?session=${encodeURIComponent(SESSION_NAME)}&since=${lastMessageId}`)
          .then(res => res.json())
          .then(data => {
            if (data.messages && data.messages.length > 0) {
              renderMessages(data.messages);
            }
          })
          .catch(() => {});
      }
      bgPollInterval = setInterval(() => {
        if (!isStreaming && !document.hidden) {
          fetch(`/api/chat/poll?session=${encodeURIComponent(SESSION_NAME)}&since=${lastMessageId}`)
            .then(res => res.json())
            .then(data => {
              if (data.messages && data.messages.length > 0) {
                renderMessages(data.messages);
              }
            })
            .catch(() => {});
        }
      }, 10000);
    }
  });
})();
