/* Sandboxer - Chat Page JavaScript (Polling-based sync) */

const sessionName = window.SANDBOXER_SESSION;
const messagesContainer = document.getElementById("chat-messages");
const textarea = document.getElementById("chat-textarea");
const sendBtn = document.getElementById("send-btn");
const toggleBtn = document.getElementById("toggle-btn");
const killBtn = document.getElementById("kill-btn");
const imgBtn = document.getElementById("img-btn");
const imgBtnMobile = document.getElementById("img-btn-mobile");
const imageInput = document.getElementById("image-input");

// Track rendered message IDs to avoid duplicates
const renderedMessageIds = new Set();
let latestMessageId = 0;
let isPolling = false;
let isSending = false;

// Toast helper
function showToast(message, type = "info") {
  const toast = document.getElementById("paste-toast");
  if (!toast) return;
  toast.textContent = message;
  toast.className = "paste-toast show " + type;
  setTimeout(() => toast.classList.remove("show"), 3000);
}

// Render a message from database (handles status: thinking/streaming/complete)
function renderMessage(msg) {
  const existingBubble = msg.id ? messagesContainer.querySelector(`[data-message-id="${msg.id}"]`) : null;

  // Update existing bubble if status/content changed
  if (existingBubble) {
    existingBubble.className = "chat-message " + msg.role;
    if (msg.status === 'thinking') {
      existingBubble.innerHTML = '<span is-="spinner" variant-="dots"></span> thinking';
      existingBubble.classList.add('thinking');
    } else if (msg.status === 'streaming') {
      existingBubble.textContent = msg.content || '';
      existingBubble.classList.add('streaming');
    } else {
      existingBubble.textContent = msg.content;
    }
    return existingBubble;
  }

  // Skip if already rendered and complete
  if (msg.id && renderedMessageIds.has(msg.id) && msg.status === 'complete') return null;
  if (msg.id) renderedMessageIds.add(msg.id);

  const bubble = document.createElement("div");
  bubble.className = "chat-message " + msg.role;
  if (msg.id) bubble.dataset.messageId = msg.id;

  // Render based on status
  if (msg.status === 'thinking') {
    bubble.innerHTML = '<span is-="spinner" variant-="dots"></span> thinking';
    bubble.classList.add('thinking');
  } else if (msg.status === 'streaming') {
    bubble.textContent = msg.content || '';
    bubble.classList.add('streaming');
  } else {
    bubble.textContent = msg.content;
  }

  messagesContainer.appendChild(bubble);
  return bubble;
}

// Scroll to bottom
function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Load initial history
async function loadHistory() {
  try {
    const res = await fetch(`/api/chat-history?session=${encodeURIComponent(sessionName)}`);
    const data = await res.json();

    if (data.messages) {
      for (const msg of data.messages) {
        renderMessage(msg);
        if (msg.id > latestMessageId) latestMessageId = msg.id;
      }
      scrollToBottom();
    }
  } catch (err) {
    console.error("Failed to load history:", err);
  }
}

// Poll for new messages (status: thinking/streaming/complete synced via DB)
async function pollMessages() {
  if (isPolling) return;
  isPolling = true;

  try {
    const res = await fetch(`/api/chat-poll?session=${encodeURIComponent(sessionName)}&since=${latestMessageId}`);
    const data = await res.json();

    let hasNewMessages = false;
    let hasActiveMessage = false;

    if (data.messages && data.messages.length > 0) {
      // Remove local pending elements when DB messages arrive
      document.querySelectorAll('.local-pending').forEach(el => el.remove());

      for (const msg of data.messages) {
        renderMessage(msg);
        if (msg.id > latestMessageId) {
          latestMessageId = msg.id;
          hasNewMessages = true;
        }
        // Check if there's an active (thinking/streaming) message
        if (msg.status === 'thinking' || msg.status === 'streaming') {
          hasActiveMessage = true;
        }
      }
      if (hasNewMessages) scrollToBottom();
    }

    if (data.latest_id) latestMessageId = Math.max(latestMessageId, data.latest_id);

    // Speed up polling when there's an active message
    window._chatActive = hasActiveMessage;
  } catch (err) {
    console.error("Poll error:", err);
  } finally {
    isPolling = false;
  }
}

// Send message to Claude - fire and forget, polling handles display
async function sendMessage() {
  const message = textarea.value.trim();
  if (!message || isSending) return;

  isSending = true;
  textarea.value = "";
  textarea.style.height = "auto";
  sendBtn.disabled = true;
  sendBtn.textContent = "…";
  scrollToBottom();

  try {
    // Just POST, don't wait for response stream - polling will show everything
    fetch("/api/chat-send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: sessionName, message }),
    }).catch(err => {
      console.error("Send error:", err);
      showToast("Failed to send", "error");
    });

    // Poll immediately to show user message + thinking state from DB
    await pollMessages();

  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = "➤";
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
  // Also handle touch for mobile reliability
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
loadHistory();

// Poll with adaptive interval (faster when active messages)
function schedulePoll() {
  const interval = (window._chatActive || isSending) ? 500 : 1500;
  setTimeout(async () => {
    await pollMessages();
    schedulePoll();
  }, interval);
}
schedulePoll();

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
