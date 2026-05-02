#!/bin/bash
# Build Windows ShareTool Tray App (requires Windows or dotnet with Windows SDK)
# Run this on Windows CMD or PowerShell:  powershell -ExecutionPolicy Bypass -File build-windows.ps1
# Or on macOS with dotnet 10+ installed:  ./build-windows.ps1

set -e
cd "$(dirname "$0")/.."

echo "=== Building Windows ShareTool Tray App ==="

# On macOS, check for dotnet
if command -v dotnet &> /dev/null; then
    echo "dotnet found: $(dotnet --version)"
fi

# Step 1: Build Go server for Windows
echo "--- Building Go server (Windows) ---"
cd go
GOOS=windows GOARCH=amd64 go build -o ../sharetool_windows_amd64.exe .
cd ..

# Step 2: Build Windows C# Tray App
echo "--- Building Windows C# Tray App ---"
cd app/ShareTool/ClipboardSync

# Try cross-compile on macOS
if dotnet --version &> /dev/null; then
    dotnet restore
    dotnet build -c Release -r win-x64 --self-contained false
    cp bin/Release/net8.0-windows/win-x64/ShareToolClipboardSync.exe ../../../sharetool_windows_tray.exe || true
    dotnet publish -c Release -r win-x64 --self-contained false -o ./publish || true
    if [ -f ./publish/ShareToolClipboardSync.exe ]; then
        cp ./publish/ShareToolClipboardSync.exe ../../../sharetool_windows_tray.exe
        echo "Windows tray app built: sharetool_windows_tray.exe"
    fi
else
    echo "dotnet not found. On Windows, run:"
    echo "  cd app/ShareTool/ClipboardSync"
    echo "  dotnet restore"
    echo "  dotnet build -c Release"
    echo "  copy bin\\Release\\net8.0-windows\\win-x64\\ShareToolClipboardSync.exe ..\\..\\sharetool_windows_tray.exe"
fi
