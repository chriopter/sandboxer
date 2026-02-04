#!/bin/bash
# Pull xterm.js and addons from CDN

set -e
cd "$(dirname "$0")/../sandboxer/static/vendor"

echo "Downloading xterm.js..."
curl -sO "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css"
curl -sO "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"
curl -sO "https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"
curl -sO "https://cdn.jsdelivr.net/npm/@xterm/addon-webgl@0.18.0/lib/addon-webgl.min.js"

echo "Done. Files:"
ls -la
