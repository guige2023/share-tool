#!/bin/bash
# Build macOS app (requires Xcode on macOS)
# Run this ON macOS with Xcode installed

set -e
cd "$(dirname "$0")/.."

echo "=== Building macOS ShareTool App ==="

# Verify XcodeGen is installed
if ! command -v xcodegen &> /dev/null; then
    echo "ERROR: xcodegen not found. Install: brew install xcodegen"
    exit 1
fi

# Verify Go is installed
if ! command -v go &> /dev/null; then
    echo "ERROR: Go not found. Install from https://go.dev"
    exit 1
fi

# Step 1: Build Go server for macOS
echo "--- Building Go server (macOS) ---"
cd go
GOOS=darwin GOARCH=amd64 go build -o ../sharetool_darwin_amd64 .
GOOS=darwin GOARCH=arm64 go build -o ../sharetool_darwin_arm64 .
cd ..

# Step 2: Generate Xcode project
echo "--- Generating Xcode project ---"
cd app/ShareTool
xcodegen generate

# Step 3: Build macOS app
echo "--- Building macOS app ---"
xcodebuild -project ShareTool.xcodeproj \
    -scheme ShareTool \
    -configuration Release \
    -derivedDataPath build \
    CODE_SIGN_IDENTITY="-" \
    CODE_SIGNING_REQUIRED=NO \
    CODE_SIGNING_ALLOWED=NO \
    build

# Step 4: Locate built app
APP_PATH="build/Build/Products/Release/ShareTool.app"
if [ ! -d "$APP_PATH" ]; then
    APP_PATH="ShareTool.xcodeproj/../build/Build/Products/Release/ShareTool.app"
fi
echo ""
echo "=== Built: $APP_PATH ==="
echo ""

# Step 5: Copy Go binary into app bundle
APP_BUNDLE=$(find build -name "ShareTool.app" -type d 2>/dev/null | head -1)
if [ -n "$APP_BUNDLE" ]; then
    mkdir -p "$APP_BUNDLE/Contents/ShareTool-bin"
    cp ../sharetool_darwin_amd64 "$APP_BUNDLE/Contents/ShareTool-bin/sharetool"
    chmod +x "$APP_BUNDLE/Contents/ShareTool-bin/sharetool"
    echo "Copied sharetool binary into app bundle"
fi

# Step 6: Package as DMG
echo "--- Packaging as DMG ---"
VOLUME="ShareTool-macos"
DMG_PATH="../ShareTool-macos.dmg"
if [ -d "/Volumes/$VOLUME" ]; then
    hdiutil detach "/Volumes/$VOLUME" 2>/dev/null || true
fi
hdiutil create -size 200m -volname "$VOLUME" -fs HFS+ -format UDRW ./temp.dmg
mkdir -p /Volumes/$VOLUME
hdiutil attach ./temp.dmg -mountpoint /Volumes/$VOLUME -noverify
if [ -n "$APP_BUNDLE" ]; then
    cp -r "$APP_BUNDLE" /Volumes/$VOLUME/
fi
hdiutil detach /Volumes/$VOLUME
hdiutil convert ./temp.dmg -format UDZO -o "$DMG_PATH"
rm ./temp.dmg
echo "=== DMG created: $DMG_PATH ==="
