#!/usr/bin/env bash
#
# Build, sign and install Tizen web apps on a Samsung TV in developer mode.
#
# Everything runs inside this repository's own image, published by its CI.
# Docker is all this host needs. The image signs with the SDK's PUBLIC
# distributor certificate. Public-level privileges such as tv.window need no
# more.
#
# Usage:
#   ./build-install.sh <TV_IP> [target ...]
#
# A target is a widget directory in this repository or a prebuilt .wgt anywhere
# on this machine. Options bind to the target that follows: --package-id,
# --required-version, --replace. See docker/entrypoint.sh.
#
# Example:
#   ./build-install.sh 192.168.1.50                        # the camera app
#   ./build-install.sh 192.168.1.50 <dir>                  # another widget here
#   ./build-install.sh 192.168.1.50 ~/Downloads/App.wgt    # somebody else's build
#
# Prerequisites on the TV:
#   Apps -> 12345 -> Developer mode ON -> enter this host's IP -> restart TV
#
set -euo pipefail

TV_IP="${1:-}"

if [ -z "$TV_IP" ]; then
    echo "Usage: $0 <TV_IP> [target ...]" >&2
    exit 1
fi
shift

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ARGS=()
MOUNTS=()
MOUNTED=""
for arg in "$@"; do
    case "$arg" in
        *.wgt)
            if [ ! -f "$arg" ]; then
                echo "No such package: $arg" >&2
                exit 1
            fi
            dir="$(cd "$(dirname "$arg")" && pwd)"
            ARGS+=("$dir/$(basename "$arg")")
            case ":${MOUNTED}:" in
                *":${dir}:"*) ;;
                *)
                    MOUNTS+=(-v "$dir:$dir:ro")
                    MOUNTED="${MOUNTED}:${dir}"
                    ;;
            esac
            ;;
        *)
            ARGS+=("$arg")
            ;;
    esac
done

if [ "${#ARGS[@]}" -eq 0 ] && [ ! -f "$REPO_ROOT/app/config.xml" ]; then
    echo "No config.xml in 'app' - is that a Tizen web app directory?" >&2
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

echo "==> TV:      $TV_IP"
echo "==> Targets: ${ARGS[*]:-app}"
echo "==> Image:   $IMAGE"
echo

docker run --rm --network host \
    -v "$REPO_ROOT:/work:ro" \
    -v "$REPO_ROOT/dist:/out" \
    "${MOUNTS[@]}" \
    "$IMAGE" "$TV_IP" "${ARGS[@]}"

echo
echo "==> Done. The .wgt is in dist/"
