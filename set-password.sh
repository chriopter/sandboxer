#!/bin/bash
# Set password protection for Sandboxer
# Usage: ./set-password.sh [password]
# If no password provided, prompts interactively

set -e

PASSWORD_FILE="/etc/sandboxer/password"

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

# Create directory if needed
mkdir -p "$(dirname "$PASSWORD_FILE")"

# Generate SHA256 hash and save
HASH=$(echo -n "$PASSWORD" | sha256sum | cut -d' ' -f1)
echo "sha256:$HASH" > "$PASSWORD_FILE"
chmod 600 "$PASSWORD_FILE"

echo "Password set. Restart sandboxer for changes to take effect:"
echo "  sudo systemctl restart sandboxer"
