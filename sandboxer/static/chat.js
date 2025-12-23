/* Sandboxer - Chat Page JavaScript (KISS: all from SQLite) */

const sessionName = window.SANDBOXER_SESSION;
const messagesContainer = document.getElementById("chat-messages");
const composerStatus = document.getElementById("composer-status");
const textarea = document.getElementById("chat-textarea");
const sendBtn = document.getElementById("send-btn");
const toggleBtn = document.getElementById("toggle-btn");
const killBtn = document.getElementById("kill-btn");
const imgBtn = document.getElementById("img-btn");
const imgBtnMobile = document.getElementById("img-btn-mobile");
const imageInput = document.getElementById("image-input");

let isSending = false;
let lastRenderedHash = "";  // Simple hash to detect changes

// Toast helper
function showToast(message, type = "info") {
  const toast = document.getElementById("paste-toast");
  if (!toast) return;
  toast.textContent = message;
  toast.className = "paste-toast show " + type;
  setTimeout(() => toast.classList.remove("show"), 3000);
}

// Simple hash of messages to detect changes
function hashMessages(messages) {
  return messages.map(m => `${m.id}:${m.status}:${m.content?.length || 0}`).join("|");
}

// Render ALL messages from database (complete replace, KISS)
function renderAllMessages(messages) {
  // Clear and rebuild (simple, no incremental complexity)
  messagesContainer.innerHTML = "";
  let hasActiveMessage = false;
  let activeStatus = null;

  for (const msg of messages) {
    // Only render COMPLETE messages in history
    if (msg.status === 'complete') {
      const bubble = document.createElement("div");
      bubble.className = "chat-message " + msg.role;
      bubble.textContent = msg.content || "";
      messagesContainer.appendChild(bubble);
    } else {
      // Track active (thinking/streaming) status for status line
      hasActiveMessage = true;
      activeStatus = msg.status;
    }
  }

  // Update status line above composer
  if (hasActiveMessage && activeStatus) {
    composerStatus.textContent = activeStatus === 'thinking' ? 'thinking…' : 'streaming…';
    composerStatus.className = "composer-status active";
  } else {
    composerStatus.textContent = "";
    composerStatus.className = "composer-status";
  }

  return hasActiveMessage;
}

// Scroll to bottom
function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Load messages from SQLite (always fresh, no caching)
async function loadMessages() {
  try {
    const res = await fetch(`/api/chat-history?session=${encodeURIComponent(sessionName)}&limit=100`);
    const data = await res.json();

    if (data.messages) {
      const newHash = hashMessages(data.messages);
      if (newHash !== lastRenderedHash) {
        const wasAtBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop <= messagesContainer.clientHeight + 50;
        const hasActive = renderAllMessages(data.messages);
        lastRenderedHash = newHash;
        if (wasAtBottom) scrollToBottom();
        return hasActive;
      }
    }
  } catch (err) {
    console.error("Failed to load messages:", err);
  }
  return false;
}

// Send message to Claude
async function sendMessage() {
  const message = textarea.value.trim();
  if (!message || isSending) return;

  isSending = true;
  textarea.value = "";
  textarea.style.height = "auto";
  sendBtn.disabled = true;
  sendBtn.textContent = "…";

  try {
    // POST to start the request
    const res = await fetch("/api/chat-send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: sessionName, message }),
    });

    // Re-enable button immediately
    sendBtn.disabled = false;
    sendBtn.textContent = "→";
    isSending = false;

    // Consume response in background (so backend generator runs)
    const reader = res.body?.getReader();
    if (reader) {
      (async () => {
        try {
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        } catch (e) { /* ignore */ }
      })();
    }
  } catch (err) {
    console.error("Send error:", err);
    showToast("Failed to send", "error");
    sendBtn.disabled = false;
    sendBtn.textContent = "→";
    isSending = false;
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
    setTimeout(() => window.location.href = "/", 500);
  } catch (err) {
    showToast("Failed to kill session", "error");
  }
}

// Image upload
let pasteTimeout = null;

function triggerImageUpload() {
  const isMobile = window.matchMedia("(pointer: coarse)").matches;
  if (isMobile) {
    imageInput.click();
  } else {
    showToast("Ctrl+V to paste, or double-click to browse", "info");
    clearTimeout(pasteTimeout);
    pasteTimeout = setTimeout(() => showToast("Paste timed out", "info"), 10000);
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

    const res = await fetch("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: base64, filename: file.name || `upload_${Date.now()}.png` })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Upload failed");

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
if (sendBtn) {
  sendBtn.addEventListener("click", sendMessage);
  sendBtn.addEventListener("touchend", (e) => {
    e.preventDefault();
    sendMessage();
  });
}

const isMobile = window.matchMedia("(pointer: coarse)").matches;
textarea.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !isMobile && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

textarea.addEventListener("input", autoResize);
toggleBtn.addEventListener("click", toggleToCLI);
killBtn.addEventListener("click", killSession);
imgBtn.addEventListener("click", triggerImageUpload);
imgBtn.addEventListener("dblclick", () => imageInput.click());
if (imgBtnMobile) imgBtnMobile.addEventListener("click", () => imageInput.click());

imageInput.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) uploadImage(file);
  e.target.value = "";
});

document.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      e.preventDefault();
      const file = item.getAsFile();
      if (file) {
        showToast("Pasting image...", "info");
        uploadImage(file);
        clearTimeout(pasteTimeout);
        return;
      }
    }
  }
});

// Initialize
textarea.focus();
loadMessages().then(scrollToBottom);

// Poll with adaptive interval (faster when active)
let pollActive = false;
async function poll() {
  const hasActive = await loadMessages();
  pollActive = hasActive || isSending;
  setTimeout(poll, pollActive ? 500 : 1500);
}
poll();

// ═══ iOS Safari keyboard handling ═══

const inputArea = document.querySelector(".chat-composer");
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
              (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

if (isIOS && window.visualViewport && inputArea) {
  const vv = window.visualViewport;

  function positionInput() {
    const offsetTop = vv.offsetTop;
    const height = vv.height;
    inputArea.style.position = "fixed";
    inputArea.style.top = (offsetTop + height) + "px";
    inputArea.style.bottom = "auto";
    inputArea.style.transform = "translateY(-100%)";
    scrollToBottom();
  }

  vv.addEventListener("resize", positionInput);
  vv.addEventListener("scroll", positionInput);
  positionInput();

  textarea.addEventListener("focus", () => {
    setTimeout(positionInput, 100);
    setTimeout(positionInput, 300);
  });
} else {
  textarea.addEventListener("focus", () => {
    setTimeout(scrollToBottom, 300);
  });
}
