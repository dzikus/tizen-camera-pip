#!/usr/bin/env bash
#
# Build, sign and install a Tizen web app on a Samsung TV in developer mode.
#
# Everything runs inside this repository's own image, published by its CI.
# Docker is all this host needs. The image signs with the SDK's PUBLIC
# distributor certificate. Public-level privileges such as tv.window need no
# more.
#
# Usage:
#   ./build-install.sh <TV_IP> [APP_DIR]
#
# Example:
#   ./build-install.sh 192.168.1.50          # the camera app
#   ./build-install.sh 192.168.1.50 <dir>    # any other widget directory here
#
# Prerequisites on the TV:
#   Apps -> 12345 -> Developer mode ON -> enter this host's IP -> restart TV
#
set -euo pipefail

TV_IP="${1:-}"
APP_DIR="${2:-app}"

if [ -z "$TV_IP" ]; then
    echo "Usage: $0 <TV_IP> [APP_DIR]" >&2
    exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -f "$REPO_ROOT/$APP_DIR/config.xml" ]; then
    echo "No config.xml in '$APP_DIR' - is that a Tizen web app directory?" >&2
    exit 1
fi

# Read the image name off the remote, never hard-coded. A fork then uses the
# one its own CI published.
IMAGE="${TIZEN_IMAGE:-}"
if [ -z "$IMAGE" ]; then
    REMOTE="$(git -C "$REPO_ROOT" config --get remote.origin.url 2>/dev/null || true)"
    case "$REMOTE" in
        *github.com*)
            SLUG="${REMOTE##*github.com[:/]}"
            IMAGE="ghcr.io/${SLUG%.git}/tizen-cli:latest"
            IMAGE="${IMAGE,,}"
            ;;
        *)
            IMAGE=tizen-cli:local
            ;;
    esac
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1 &&
   ! docker pull -q "$IMAGE" >/dev/null 2>&1; then
    if [ -n "${TIZEN_IMAGE:-}" ]; then
        echo "$IMAGE cannot be pulled and was set explicitly." >&2
        exit 1
    fi
    echo "==> $IMAGE is not published yet; building it from docker/, once"
    IMAGE=tizen-cli:local
    docker image inspect "$IMAGE" >/dev/null 2>&1 ||
        docker build -t "$IMAGE" "$REPO_ROOT/docker"
fi

mkdir -p "$REPO_ROOT/dist"

echo "==> TV:    $TV_IP"
echo "==> App:   $APP_DIR"
echo "==> Image: $IMAGE"
echo

docker run --rm --network host \
    -v "$REPO_ROOT:/work:ro" \
    -v "$REPO_ROOT/dist:/out" \
    "$IMAGE" "$TV_IP" "$APP_DIR"

echo
echo "==> Done. The .wgt is in dist/"
