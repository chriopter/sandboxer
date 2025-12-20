/* Sandboxer - Terminal Page JavaScript */

// Prevent beforeunload dialogs from iframe
window.onbeforeunload = null;
window.addEventListener("beforeunload", (e) => {
  delete e.returnValue;
});

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

async function uploadImage(file) {
  const reader = new FileReader();

  return new Promise((resolve, reject) => {
    reader.onload = async () => {
      try {
        const base64 = reader.result.split(",")[1];
        const ext = file.type.split("/")[1]?.split(";")[0] || "png";
        const filename = `image_${Date.now()}.${ext}`;

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
    reader.onerror = () => reject(new Error("Failed to read image"));
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
  if (!file || !file.type.startsWith("image/")) {
    showToast("Not an image", "error");
    return;
  }

  showToast("Uploading...", "info");

  try {
    const path = await uploadImage(file);
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

// File input handler
const fileInput = document.getElementById("image-input");
const pasteBtn = document.getElementById("paste-btn");

fileInput?.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) handleFile(file);
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
  // No image - open file picker instead
  showToast("No image in clipboard - select file", "info");
  fileInput?.click();
  pasteMode = false;
  clearTimeout(pasteTimeout);
});

pasteTarget.addEventListener("blur", () => {
  if (pasteMode) {
    pasteMode = false;
  }
});

// Override [img] button to enable paste mode
let pasteTimeout;
pasteBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  pasteMode = true;
  pasteTarget.focus();
  showToast("Ctrl+V to paste, or click again to browse", "info");

  // Auto-return focus to terminal after 3 seconds
  clearTimeout(pasteTimeout);
  pasteTimeout = setTimeout(() => {
    if (pasteMode) {
      pasteMode = false;
      focusTerminal();
    }
  }, 3000);
});

// Second click opens file browser
pasteBtn?.addEventListener("dblclick", (e) => {
  e.preventDefault();
  pasteMode = false;
  clearTimeout(pasteTimeout);
  fileInput?.click();
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
      killBtn.textContent = "[kill]";
    }, 2000);
  }
});
