#!/bin/bash
# Remove password protection from Sandboxer
# Usage: ./remove-password.sh

set -e

CADDYFILE="/etc/caddy/Caddyfile"

# Backup current config
cp "$CADDYFILE" "$CADDYFILE.bak"

# Remove basicauth block
python3 << 'PYEOF'
import re

with open("/etc/caddy/Caddyfile", "r") as f:
    content = f.read()

# Remove basicauth block (including comment)
content = re.sub(r'\n\s*# Basic auth.*?\n\s*basicauth /\* \{[^}]+\}\n', '\n', content, flags=re.DOTALL)

with open("/etc/caddy/Caddyfile", "w") as f:
    f.write(content)
PYEOF

systemctl reload caddy

echo "Password protection removed"
