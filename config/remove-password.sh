#!/bin/bash
# Remove password protection from Sandboxer
# Usage: ./remove-password.sh

set -e

PASSWORD_FILE="/etc/sandboxer/password"

if [ -f "$PASSWORD_FILE" ]; then
    rm "$PASSWORD_FILE"
    echo "Password protection removed. Restart sandboxer:"
    echo "  sudo systemctl restart sandboxer"
else
    echo "No password file found. Sandboxer is already unprotected."
fi
