#!/usr/bin/env bash
#
# Build, sign and install a Tizen web app from the repository mounted at /work.
#
#   docker run --rm --network host -v "$PWD:/work:ro" -v "$PWD/dist:/out" IMAGE 192.168.1.50
#   docker run --rm -v "$PWD:/work:ro" -v "$PWD/dist:/out" IMAGE
#
# With no TV address it packages and stops. That is the CI path.
set -euo pipefail

# The bundled JVM sizes its file descriptor table from the soft limit and aborts
# when the container default is large.
ulimit -n 4096

TV_IP="${1:-${TV_IP:-}}"
APP_DIR="${2:-${APP_DIR:-app}}"
SRC="/work/${APP_DIR}"

if [ ! -f "${SRC}/config.xml" ]; then
    echo "No ${APP_DIR}/config.xml under /work - mount the repository there." >&2
    exit 1
fi

BUILD="$(mktemp -d)"
trap 'rm -rf "${BUILD}"' EXIT
cp -r "${SRC}" "${BUILD}/app"
cd "${BUILD}/app"

if [ -f config.yaml ]; then
    python3 /work/tools/yaml2config.py config.yaml config.js
fi

echo "==> Building ${APP_DIR}"
tizen build-web -- .

echo "==> Signing with the ${TIZEN_PROFILE} profile"
tizen package -t wgt -s "${TIZEN_PROFILE}" -- .buildResult

WGT="$(find .buildResult -name '*.wgt' -print -quit)"
if [ -z "${WGT}" ]; then
    echo "Packaging produced no .wgt" >&2
    exit 1
fi

# The .wgt is named after <name> in config.xml, which may contain spaces, and
# both sdb and tizen install choke on those.
SAFE="$(dirname "${WGT}")/$(basename "${WGT}" | tr ' ' '_')"
if [ "${SAFE}" != "${WGT}" ]; then
    mv "${WGT}" "${SAFE}"
    WGT="${SAFE}"
fi

if [ -d /out ]; then
    # -f: an earlier run under a different image may have left a .wgt there
    # owned by root.
    cp -f "${WGT}" /out/
    echo "==> Package: /out/$(basename "${WGT}")"
else
    echo "==> Package: $(basename "${WGT}") - mount /out to keep it"
fi

if [ -z "${TV_IP}" ]; then
    exit 0
fi

echo "==> Connecting to ${TV_IP}"
sdb connect "${TV_IP}" >/dev/null || true

TV_NAME=""
for _ in 1 2 3 4 5; do
    TV_NAME="$(sdb devices | awk 'NR > 1 && $2 == "device" { print $3; exit }')"
    [ -n "${TV_NAME}" ] && break
    sleep 1
done

if [ -z "${TV_NAME}" ]; then
    echo "Nothing answered at ${TV_IP}. Is developer mode on, with this host's IP entered there?" >&2
    exit 1
fi

# tizen install exits 0 even when the platform log says the install failed. The
# text it printed is the only signal.
INSTALL_OUT=""
install_wgt() {
    INSTALL_OUT="$(tizen install -n "$(basename "${WGT}")" \
        -- "$(dirname "${WGT}")" -t "${TV_NAME}" 2>&1 || true)"
    printf '%s\n' "${INSTALL_OUT}"
    case "${INSTALL_OUT}" in
        *"successfully installed"*) return 0 ;;
        *) return 1 ;;
    esac
}

echo "==> Installing on ${TV_NAME}"
if install_wgt; then
    exit 0
fi

# 118012 is the set rejecting a certificate. Measured: it fires both for an
# update whose author differs from the installed package, and for a distributor
# chain the set does not trust. In the first case it also refuses to uninstall.
# Nothing can be done about that from here.
case "${INSTALL_OUT}" in
    *"install failed[118012]"*) ;;
    *) exit 1 ;;
esac

APP_ID="$(python3 -c "
import xml.etree.ElementTree as ET
ns = {'t': 'http://tizen.org/ns/widgets'}
print(ET.parse('config.xml').getroot().find('t:application', ns).get('id'))")"
cat >&2 <<EOF

${APP_ID} is already on the set, signed by a different certificate than this
image carries. Tizen will neither replace nor uninstall it. Delete it on the TV
- Apps, then the app, then Delete - and run this again.

This image always signs with the same author certificate. Once that is done it
does not come back.
EOF
exit 1
