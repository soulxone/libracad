#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# LibraCAD — Local Docker Image Build Script
# ──────────────────────────────────────────────────────────────────────────────
#
# Builds a custom ERPNext Docker image with LibraCAD and all dependencies.
#
# Prerequisites:
#   - Docker Desktop running
#   - libracad pushed to GitHub at https://github.com/soulxone/libracad
#   - Run from the frappe_docker directory:
#       cd C:\Users\soulx\frappe_docker
#       bash /path/to/libracad/docker/build.sh
#
# ──────────────────────────────────────────────────────────────────────────────

set -e

# Configuration
IMAGE_NAME="${IMAGE_NAME:-custom-erpnext}"
IMAGE_TAG="${IMAGE_TAG:-libracad}"
FRAPPE_BRANCH="${FRAPPE_BRANCH:-version-15}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APPS_JSON="$SCRIPT_DIR/apps.json"

echo "========================================="
echo "  LibraCAD Docker Image Builder"
echo "========================================="
echo ""
echo "  Image:    ${IMAGE_NAME}:${IMAGE_TAG}"
echo "  Frappe:   ${FRAPPE_BRANCH}"
echo "  Apps:     $(cat "$APPS_JSON" | grep url | wc -l) apps"
echo ""

# Verify we're in or can find the frappe_docker directory
FRAPPE_DOCKER_DIR="${FRAPPE_DOCKER_DIR:-C:/Users/soulx/frappe_docker}"
if [ ! -f "$FRAPPE_DOCKER_DIR/images/custom/Containerfile" ]; then
    echo "ERROR: Cannot find frappe_docker at $FRAPPE_DOCKER_DIR"
    echo "Set FRAPPE_DOCKER_DIR to your frappe_docker path and retry."
    exit 1
fi

# Encode apps.json to base64
echo ">> Encoding apps.json..."
APPS_JSON_BASE64=$(base64 -w 0 "$APPS_JSON" 2>/dev/null || base64 "$APPS_JSON" | tr -d '\n')

# Build the image
echo ">> Building Docker image (this may take 10-20 minutes)..."
cd "$FRAPPE_DOCKER_DIR"

docker build \
    --platform linux/amd64 \
    --build-arg APPS_JSON_BASE64="$APPS_JSON_BASE64" \
    --build-arg FRAPPE_BRANCH="$FRAPPE_BRANCH" \
    -t "${IMAGE_NAME}:${IMAGE_TAG}" \
    -f images/custom/Containerfile \
    .

echo ""
echo "========================================="
echo "  Build Complete!"
echo "========================================="
echo ""
echo "  Image: ${IMAGE_NAME}:${IMAGE_TAG}"
echo ""
echo "  Next steps:"
echo "  1. Update your .env file:"
echo "       CUSTOM_IMAGE=${IMAGE_NAME}"
echo "       CUSTOM_TAG=${IMAGE_TAG}"
echo ""
echo "  2. Start containers:"
echo "       docker compose up -d"
echo ""
echo "  3. Install LibraCAD on your site:"
echo "       docker compose exec backend bench --site <site> install-app libracad"
echo "       docker compose exec backend bench --site <site> migrate"
echo "       docker compose restart backend"
echo ""
echo "  4. Access the Die Layout Editor at:"
echo "       https://<site>/app/die-layout-editor"
echo ""
