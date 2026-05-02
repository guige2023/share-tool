#!/bin/bash
# ShareTool Build Script
# Builds all platforms: macOS (arm64/amd64), Windows, Linux
# Usage: ./scripts/build.sh

set -e
cd "$(dirname "$0")/.."

echo "=== ShareTool Build Script ==="
echo "Go version: $(go version | awk '{print $3}')"
echo ""

# Build all Go platforms
echo "--- Building Go Server ---"
cd go

mkdir -p ../dist

GOOS=darwin GOARCH=arm64 go build -o ../dist/sharetool_darwin_arm64 .
echo "  darwin/arm64: dist/sharetool_darwin_arm64"

GOOS=darwin GOARCH=amd64 go build -o ../dist/sharetool_darwin_amd64 .
echo "  darwin/amd64: dist/sharetool_darwin_amd64"

GOOS=windows GOARCH=amd64 go build -o ../dist/sharetool_windows_amd64.exe .
echo "  windows/amd64: dist/sharetool_windows_amd64.exe"

GOOS=linux GOARCH=amd64 go build -o ../dist/sharetool_linux_amd64 .
echo "  linux/amd64: dist/sharetool_linux_amd64"

cd ..

echo ""
echo "--- Build Complete ---"
ls -lh dist/
echo ""
echo "Note: Windows C# tray app (ShareToolClipboardSync.exe) must be built"
echo "      on Windows with: dotnet build -c Release -r win-x64"
echo "      in app/ShareTool/ClipboardSync/"
