/* Sandboxer - Terminal Page JavaScript */

// Prevent beforeunload dialogs from iframe
window.onbeforeunload = null;
window.addEventListener("beforeunload", (e) => {
  delete e.returnValue;
});

// ─── Force Terminal Resize on Load ───
// xterm.js needs a resize trigger to fit the container properly
window.addEventListener("load", () => {
  // Trigger resize after iframe loads to force xterm.js to refit
  setTimeout(() => {
    window.dispatchEvent(new Event("resize"));
  }, 500);

  // Also trigger when iframe loads
  const iframe = document.getElementById("terminal-iframe");
  if (iframe) {
    iframe.addEventListener("load", () => {
      setTimeout(() => {
        window.dispatchEvent(new Event("resize"));
      }, 300);
    });
  }
});

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
  } catch (err) {
    console.error("Upload failed:", err);
    showToast("Failed: " + err.message, "error");
  }
}

// File input handler
const fileInput = document.getElementById("image-input");
const pasteBtn = document.getElementById("paste-btn");

pasteBtn?.addEventListener("click", () => fileInput?.click());
fileInput?.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) handleFile(file);
  e.target.value = ""; // Reset for next upload
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

// ─── Mobile Keyboard Handler ───
// Scroll viewport when virtual keyboard appears (iOS Safari fix)

if (window.visualViewport) {
  const iframe = document.getElementById("terminal-iframe");
  const termBar = document.querySelector(".term-bar");

  function handleViewportResize() {
    const viewport = window.visualViewport;
    const keyboardHeight = window.innerHeight - viewport.height;

    if (keyboardHeight > 100) {
      // Keyboard is open - adjust layout
      document.body.style.height = viewport.height + "px";
      if (iframe) {
        iframe.style.height = (viewport.height - (termBar?.offsetHeight || 0)) + "px";
      }
      // Scroll to top to ensure terminal is visible
      window.scrollTo(0, viewport.offsetTop);
    } else {
      // Keyboard is closed - reset
      document.body.style.height = "";
      if (iframe) {
        iframe.style.height = "";
      }
    }
  }

  window.visualViewport.addEventListener("resize", handleViewportResize);
  window.visualViewport.addEventListener("scroll", handleViewportResize);
}
