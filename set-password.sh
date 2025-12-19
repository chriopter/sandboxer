#!/bin/bash
# Set password protection for Sandboxer via Caddy basic auth
# Usage: ./set-password.sh [password]
# If no password provided, prompts interactively

set -e

CADDYFILE="/etc/caddy/Caddyfile"

if [ "$1" ]; then
    PASSWORD="$1"
else
    read -s -p "Enter password: " PASSWORD
    echo
    read -s -p "Confirm password: " PASSWORD2
    echo
    if [ "$PASSWORD" != "$PASSWORD2" ]; then
        echo "Passwords don't match"
        exit 1
    fi
fi

if [ -z "$PASSWORD" ]; then
    echo "Password cannot be empty"
    exit 1
fi

# Generate bcrypt hash
HASH=$(caddy hash-password --plaintext "$PASSWORD")

# Backup current config
cp "$CADDYFILE" "$CADDYFILE.bak"

# Remove existing basicauth block if present, then add new one
python3 << PYEOF
import re

with open("$CADDYFILE", "r") as f:
    content = f.read()

# Remove existing basicauth block (including comment)
content = re.sub(r'\n\s*# Basic auth.*?\n\s*basicauth /\* \{[^}]+\}\n', '\n', content, flags=re.DOTALL)

# Add basicauth after :8080 {
content = content.replace(':8080 {', ''':8080 {
    # Basic auth - user: admin
    basicauth /* {
        admin $HASH
    }
''', 1)

with open("$CADDYFILE", "w") as f:
    f.write(content)
PYEOF

# Reload Caddy
systemctl reload caddy

echo "Password protection enabled. Login: admin / <your password>"
