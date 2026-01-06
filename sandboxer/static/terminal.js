/* Sandboxer - Terminal Page JavaScript */

// Prevent beforeunload dialogs from iframe
window.onbeforeunload = null;
window.addEventListener("beforeunload", (e) => {
  delete e.returnValue;
});

// ─── iOS Safari viewport fix ───
// Set CSS variable to actual visible viewport height
function setViewportHeight() {
  const vh = window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty('--vh', `${vh}px`);
}

setViewportHeight();
window.visualViewport?.addEventListener('resize', setViewportHeight);
window.addEventListener('resize', setViewportHeight);

// ─── Fix iframe/xterm.js initial sizing ───
// xterm.js uses ResizeObserver on its container. By briefly changing
// the iframe dimensions, we force xterm to recalculate and fit properly.
// See: https://github.com/xtermjs/xterm.js/issues/4841
(function() {
  const iframe = document.getElementById("terminal-iframe");
  if (!iframe) return;

  function triggerRefit() {
    // Briefly change width to force layout recalc
    const originalWidth = iframe.style.width;
    iframe.style.width = "99.9%";
    requestAnimationFrame(() => {
      iframe.style.width = originalWidth || "100%";
    });
  }

  // Trigger after iframe loads
  iframe.addEventListener("load", () => {
    // Multiple attempts with delays for reliability
    setTimeout(triggerRefit, 100);
    setTimeout(triggerRefit, 500);
    setTimeout(triggerRefit, 1000);
  });

  // Also trigger on window resize for good measure
  let resizeTimeout;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(triggerRefit, 100);
  });
})();

// ─── Image Upload Handler ───

const SESSION_NAME = window.SANDBOXER_SESSION || "";

function showToast(message, type = "info") {
  const toast = document.getElementById("paste-toast");
  if (!toast) return;

  toast.textContent = message;
  toast.className = `paste-toast ${type} show`;

  setTimeout(() => {
    toast.classList.remove("show");
  }, 3000);
}

async function uploadFile(file) {
  const reader = new FileReader();

  return new Promise((resolve, reject) => {
    reader.onload = async () => {
      try {
        const base64 = reader.result.split(",")[1];
        const filename = file.name || `file_${Date.now()}`;

        const resp = await fetch("/api/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: base64, filename })
        });

        const data = await resp.json();
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

async function injectText(text) {
  await fetch("/api/inject", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session: SESSION_NAME, text })
  });
}

function focusTerminal() {
  const iframe = document.getElementById("terminal-iframe");
  if (iframe?.contentWindow) {
    iframe.contentWindow.focus();
  }
}

async function handleFile(file) {
  if (!file) return;

  showToast("Uploading...", "info");

  try {
    const path = await uploadFile(file);
    await injectText(path + " ");
    showToast(path, "success");
    // Re-focus terminal after upload completes
    setTimeout(focusTerminal, 100);
  } catch (err) {
    console.error("Upload failed:", err);
    showToast("Failed: " + err.message, "error");
    setTimeout(focusTerminal, 100);
  }
}

async function handleFiles(files) {
  if (!files || files.length === 0) return;

  showToast(`Uploading ${files.length} file(s)...`, "info");

  const paths = [];
  for (const file of files) {
    try {
      const path = await uploadFile(file);
      paths.push(path);
    } catch (err) {
      console.error("Upload failed:", err);
      showToast("Failed: " + err.message, "error");
    }
  }

  if (paths.length > 0) {
    await injectText(paths.join(" ") + " ");
    showToast(`Uploaded ${paths.length} file(s)`, "success");
  }
  setTimeout(focusTerminal, 100);
}

// File input handler
const fileInput = document.getElementById("image-input");
const pasteBtn = document.getElementById("paste-btn");

fileInput?.addEventListener("change", (e) => {
  const files = e.target.files;
  if (files && files.length > 0) {
    if (files.length === 1) {
      handleFile(files[0]);
    } else {
      handleFiles(files);
    }
  }
  e.target.value = ""; // Reset for next upload
});

// ─── Clipboard Paste Handler ───
// Click [img] button, then Ctrl+V to paste image from clipboard
// (Direct Ctrl+V is captured by ttyd terminal)

let pasteMode = false;

// Create hidden paste target
const pasteTarget = document.createElement("textarea");
pasteTarget.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;";
pasteTarget.setAttribute("aria-hidden", "true");
document.body.appendChild(pasteTarget);

pasteTarget.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;

  for (const item of items) {
    if (item.type.startsWith("image/")) {
      e.preventDefault();
      const file = item.getAsFile();
      if (file) {
        handleFile(file);
      }
      pasteMode = false;
      clearTimeout(pasteTimeout);
      // Focus handled by handleFile after upload completes
      return;
    }
  }
  // No image in clipboard - open file picker instead
  showToast("No file in clipboard - select file", "info");
  fileInput?.click();
  pasteMode = false;
  clearTimeout(pasteTimeout);
});

pasteTarget.addEventListener("blur", () => {
  if (pasteMode) {
    pasteMode = false;
  }
});

// [img] button handler
let pasteTimeout;
const isMobile = window.matchMedia("(pointer: coarse)").matches;

pasteBtn?.addEventListener("click", (e) => {
  e.preventDefault();

  if (isMobile) {
    // Mobile: open file picker directly
    fileInput?.click();
  } else {
    // Desktop: enable paste mode
    pasteMode = true;
    pasteTarget.focus();
    showToast("Ctrl+V to paste, or double-click to browse", "info");

    clearTimeout(pasteTimeout);
    pasteTimeout = setTimeout(() => {
      if (pasteMode) {
        pasteMode = false;
        focusTerminal();
      }
    }, 3000);
  }
});

// Desktop: double-click opens file browser
pasteBtn?.addEventListener("dblclick", (e) => {
  e.preventDefault();
  pasteMode = false;
  clearTimeout(pasteTimeout);
  fileInput?.click();
});

// ─── SSH Button Handler ───

const sshBtn = document.getElementById("ssh-btn");

sshBtn?.addEventListener("click", async () => {
  const host = window.location.hostname;
  const cmd = `ssh -t sandboxer@${host} "sudo tmux attach -t '${SESSION_NAME}'"`;

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
});

// ─── Kill Button Handler ───

const killBtn = document.getElementById("kill-btn");
let killTimeout = null;

killBtn?.addEventListener("click", async () => {
  if (killBtn.classList.contains("confirm")) {
    clearTimeout(killTimeout);
    await fetch("/kill?session=" + encodeURIComponent(SESSION_NAME));
    window.location.href = "/";
  } else {
    killBtn.classList.add("confirm");
    killBtn.textContent = "confirm?";
    killTimeout = setTimeout(() => {
      killBtn.classList.remove("confirm");
      killBtn.textContent = "×";
    }, 2000);
  }
});

// ─── Mobile Touch Bar ───

const touchBar = document.querySelector(".composer-touch-bar");
let activeModifiers = { ctrl: false, alt: false };

async function sendKey(key) {
  // Apply modifiers
  let finalKey = key;
  if (activeModifiers.ctrl) {
    finalKey = "C-" + key.toLowerCase();
  } else if (activeModifiers.alt) {
    finalKey = "M-" + key.toLowerCase();
  }

  await fetch("/api/send-key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session: SESSION_NAME, key: finalKey })
  });

  // Clear modifiers after use (unless it's a modifier key itself)
  if (!["ctrl", "alt"].includes(key.toLowerCase())) {
    activeModifiers.ctrl = false;
    activeModifiers.alt = false;
    touchBar?.querySelectorAll(".mod-btn").forEach(btn => btn.classList.remove("active"));
  }

  focusTerminal();
}

touchBar?.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;

  const key = btn.dataset.key;
  const mod = btn.dataset.mod;

  if (mod) {
    // Toggle modifier
    activeModifiers[mod] = !activeModifiers[mod];
    btn.classList.toggle("active", activeModifiers[mod]);
  } else if (key) {
    sendKey(key);
  }
});

// ─── Mobile Text Input Bar ───

const mobileInput = document.getElementById("mobile-text-input");
const mobileSendBtn = document.getElementById("mobile-send-btn");

async function sendMobileText() {
  const text = mobileInput?.value || "";

  // Send text if any
  if (text) {
    await fetch("/api/inject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: SESSION_NAME, text: text })
    });
  }

  // Always send Enter
  await fetch("/api/send-key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session: SESSION_NAME, key: "Enter" })
  });

  mobileInput.value = "";
}

mobileInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    sendMobileText();
  }
});

mobileSendBtn?.addEventListener("click", sendMobileText);

// Mobile attach button - opens file picker
const mobileAttachBtn = document.getElementById("mobile-attach-btn");
mobileAttachBtn?.addEventListener("click", () => {
  fileInput?.click();
});

// ─── Mobile Touch Scroll Handler ───
// IMPORTANT: This is the solution for mobile scrolling on iOS Safari.
// xterm.js/ttyd touch scroll doesn't work, so we use a transparent overlay
// that captures swipe gestures and sends them to tmux copy-mode via API.
// DO NOT DELETE - this took significant research to solve.

const touchOverlay = document.getElementById("touch-overlay");

if (touchOverlay && window.matchMedia("(pointer: coarse)").matches) {
  let touchStartY = 0;
  let touchStartX = 0;
  let touchStartTime = 0;
  let lastScrollTime = 0;
  let hasMoved = false;
  const SCROLL_THRESHOLD = 15;
  const SCROLL_COOLDOWN = 60;
  const TAP_THRESHOLD = 10; // max movement for a tap
  const TAP_TIME = 300; // max time for a tap

  touchOverlay.addEventListener("touchstart", (e) => {
    touchStartY = e.touches[0].clientY;
    touchStartX = e.touches[0].clientX;
    touchStartTime = Date.now();
    hasMoved = false;
  }, { passive: true });

  touchOverlay.addEventListener("touchmove", (e) => {
    if (!touchStartY) return;

    const deltaY = touchStartY - e.touches[0].clientY;
    const deltaX = touchStartX - e.touches[0].clientX;

    // Check if this is a scroll gesture
    if (Math.abs(deltaY) > TAP_THRESHOLD || Math.abs(deltaX) > TAP_THRESHOLD) {
      hasMoved = true;
    }

    const now = Date.now();
    if (now - lastScrollTime < SCROLL_COOLDOWN) return;

    if (Math.abs(deltaY) > SCROLL_THRESHOLD) {
      // Swipe up (deltaY > 0) = show older content = scroll down in tmux
      const dir = deltaY > 0 ? "down" : "up";

      fetch("/api/tmux-scroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: SESSION_NAME, direction: dir })
      });

      touchStartY = e.touches[0].clientY;
      lastScrollTime = now;
    }
  }, { passive: true });

  touchOverlay.addEventListener("touchend", (e) => {
    const elapsed = Date.now() - touchStartTime;

    // If it was a tap (not a scroll), pass it through to the terminal
    if (!hasMoved && elapsed < TAP_TIME) {
      // Temporarily hide overlay to let click through
      touchOverlay.style.pointerEvents = "none";
      setTimeout(() => {
        touchOverlay.style.pointerEvents = "auto";
      }, 100);

      // Simulate click on iframe at touch position
      const iframe = document.getElementById("terminal-iframe");
      if (iframe) {
        iframe.focus();
        // Try to focus xterm inside iframe
        try {
          iframe.contentWindow?.focus();
        } catch (e) {}
      }
    }

    touchStartY = 0;
    touchStartX = 0;
  }, { passive: true });
}
