#!/bin/bash
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "${CYAN}┌────────────────────────────────────────┐${NC}"
echo -e "${CYAN}│        Installing Nimbus Focus         │${NC}"
echo -e "${CYAN}└────────────────────────────────────────┘${NC}"

# Check OS
OS="$(uname -s)"
ARCH="$(uname -m)"

if [ "$OS" != "Darwin" ]; then
    echo -e "${RED}Error: This install script only supports macOS. For Windows, please download the installer from the site.${NC}"
    exit 1
fi

VERSION="1.2.13"

if [ "$ARCH" = "arm64" ]; then
    URL="https://github.com/murderszn/nimbus/releases/latest/download/Nimbus-${VERSION}-mac-arm64.dmg"
    echo -e "${BLUE}Detected macOS Apple Silicon (arm64)...${NC}"
else
    URL="https://github.com/murderszn/nimbus/releases/latest/download/Nimbus-${VERSION}-mac-x64.dmg"
    echo -e "${BLUE}Detected macOS Intel (x64)...${NC}"
fi

FILENAME="Nimbus-${VERSION}.dmg"
TEMP_DIR="$(mktemp -d)"

echo -e "${BLUE}Downloading Nimbus v${VERSION}...${NC}"
curl -L -# -o "${TEMP_DIR}/${FILENAME}" "$URL"

echo -e "${BLUE}Mounting DMG...${NC}"
hdiutil attach "${TEMP_DIR}/${FILENAME}" -mountpoint "${TEMP_DIR}/mnt" -quiet

echo -e "${BLUE}Installing to /Applications...${NC}"
# Use sudo only if needed, but try standard cp first (if user has permission, e.g. for user-level app install or they run bash with permissions)
if cp -R "${TEMP_DIR}/mnt/Nimbus.app" "/Applications/Nimbus.app" 2>/dev/null; then
    echo -e "${GREEN}Copied Nimbus.app successfully.${NC}"
else
    echo -e "${BLUE}Requesting administrator permissions to copy to /Applications...${NC}"
    sudo cp -R "${TEMP_DIR}/mnt/Nimbus.app" "/Applications/Nimbus.app"
fi

echo -e "${BLUE}Unmounting DMG...${NC}"
hdiutil detach "${TEMP_DIR}/mnt" -quiet

# Clean up
rm -rf "${TEMP_DIR}"

echo -e "${GREEN}✓ Nimbus has been installed successfully to /Applications!${NC}"
echo -e "${GREEN}🚀 Launching Nimbus...${NC}"
open -a Nimbus
