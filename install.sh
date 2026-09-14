#!/bin/bash
# Tabby Ghostty Frontend - Installation Script
set -e

echo "=== Tabby Ghostty Frontend Installer ==="
echo

if ! command -v npm &> /dev/null; then
    echo "Error: npm is not installed. Please install Node.js first."
    exit 1
fi

echo "Installing dependencies..."
npm install --legacy-peer-deps

echo "Building plugin..."
npm run build

TABBY_PLUGINS_DIR="$HOME/.config/tabby/plugins"
mkdir -p "$TABBY_PLUGINS_DIR"

PLUGIN_DIR="$TABBY_PLUGINS_DIR/node_modules/tabby-ghostty-frontend"
echo "Installing to: $PLUGIN_DIR"

rm -rf "$PLUGIN_DIR"
mkdir -p "$PLUGIN_DIR"
cp -r dist package.json "$PLUGIN_DIR/"

echo
echo "=== Installation complete! ==="
echo "Restart Tabby. See README for how the Ghostty frontend is activated."
