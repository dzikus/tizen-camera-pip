#!/usr/bin/env bash
#
# Build, sign and install Tizen web apps from what is mounted at /work.
#
#   docker run --rm --network host -v "$PWD:/work:ro" -v "$PWD/dist:/out" IMAGE 192.168.1.50
#   docker run --rm -v "$PWD:/work:ro" -v "$PWD/dist:/out" IMAGE
#
# With no TV address it packages and stops. That is the CI path.
#
# A target is a directory holding config.xml, which gets built first, or a
# prebuilt .wgt, which gets unpacked. Either way the package is signed with this
# image's certificate before it reaches the set, and several targets can go in
# one run:
#
#   IMAGE 192.168.1.50 app
#   IMAGE 192.168.1.50 Jellyfin.wgt --package-id Moonfin001 Moonfin.wgt
#
# A target with no leading slash sits in the repository at /work. Downloaded
# packages usually live elsewhere; mount that directory and give the path:
#
#   docker run --rm --network host -v "$PWD:/work:ro" -v ~/Downloads:/pkgs:ro \
#       IMAGE 192.168.1.50 /pkgs/Jellyfin.wgt
#
# An option binds to the target that follows it:
#
#   --package-id ID          replace the ten-character package id in config.xml
#   --required-version V     replace required_version in config.xml
#   --replace                uninstall that application id before installing
set -euo pipefail

# The bundled JVM sizes its file descriptor table from the soft limit and aborts
# when the container default is large.
ulimit -n 4096

TV_IP="${TV_IP:-}"
if [ "$#" -gt 0 ]; then
    TV_IP="$1"
    shift
fi

TARGETS=()
OPT_ID=()
OPT_VERSION=()
OPT_REPLACE=()
pending_id=""
pending_version=""
pending_replace=""

while [ "$#" -gt 0 ]; do
    case "$1" in
        --package-id)
            pending_id="${2:?--package-id needs a value}"
            shift 2
            ;;
        --required-version)
            pending_version="${2:?--required-version needs a value}"
            shift 2
            ;;
        --replace)
            pending_replace=1
            shift
            ;;
        -*)
            echo "Unknown option: $1" >&2
            exit 2
            ;;
        *)
            TARGETS+=("$1")
            OPT_ID+=("${pending_id}")
            OPT_VERSION+=("${pending_version}")
            OPT_REPLACE+=("${pending_replace}")
            pending_id=""
            pending_version=""
            pending_replace=""
            shift
            ;;
    esac
done

if [ -n "${pending_id}${pending_version}${pending_replace}" ]; then
    echo "An option has to be followed by the target it applies to." >&2
    exit 2
fi

if [ "${#TARGETS[@]}" -eq 0 ]; then
    TARGETS=("${APP_DIR:-app}")
    OPT_ID=("")
    OPT_VERSION=("")
    OPT_REPLACE=("")
fi

WORK_DIRS=()
trap 'rm -rf "${WORK_DIRS[@]}"' EXIT

read_manifest() {
    python3 -c "
import sys
import xml.etree.ElementTree as ET
ns = {'t': 'http://tizen.org/ns/widgets'}
app = ET.parse(sys.argv[1]).getroot().find('t:application', ns)
print(app.get('id'), app.get('package'), app.get('required_version') or '?')" "$1"
}

rewrite_manifest() {
    local manifest="$1" new_id="$2" new_version="$3" old_package bad=""
    if [ -n "${new_id}" ]; then
        [ "${#new_id}" -eq 10 ] || bad=1
        case "${new_id}" in
            *[!A-Za-z0-9]*) bad=1 ;;
        esac
        if [ -n "${bad}" ]; then
            echo "A package id is ten letters and digits: ${new_id}" >&2
            exit 1
        fi
        old_package="$(read_manifest "${manifest}" | cut -d' ' -f2)"
        sed -i "s/${old_package}/${new_id}/g" "${manifest}"
    fi
    if [ -n "${new_version}" ]; then
        sed -i "s/required_version=\"[^\"]*\"/required_version=\"${new_version}\"/" "${manifest}"
    fi
}

resolve() {
    case "$1" in
        /*) printf '%s\n' "$1" ;;
        *)  printf '/work/%s\n' "$1" ;;
    esac
}

prepare_source() {
    local src build="$2"
    src="$(resolve "$1")"
    if [ ! -f "${src}/config.xml" ]; then
        echo "No config.xml under ${src} - mount the repository at /work." >&2
        exit 1
    fi
    cp -r "${src}" "${build}/app"
    rewrite_manifest "${build}/app/config.xml" "$3" "$4"
    cd "${build}/app"
    if [ -f config.yaml ]; then
        python3 /work/tools/yaml2config.py config.yaml config.js
    fi
    tizen build-web -- . >/dev/null
    PKG_DIR="${build}/app/.buildResult"
}

prepare_package() {
    local src build="$2"
    src="$(resolve "$1")"
    if [ ! -f "${src}" ]; then
        echo "No such package: ${src}" >&2
        exit 1
    fi
    unzip -q "${src}" -d "${build}/app"
    rm -f "${build}/app/author-signature.xml" "${build}/app"/signature*.xml
    rewrite_manifest "${build}/app/config.xml" "$3" "$4"
    PKG_DIR="${build}/app"
}

connect_tv() {
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
    echo "==> Installing on ${TV_NAME}"
}

TV_NAME=""
[ -n "${TV_IP}" ] && connect_tv

FAILED=0

for i in "${!TARGETS[@]}"; do
    TARGET="${TARGETS[$i]}"
    BUILD="$(mktemp -d)"
    WORK_DIRS+=("${BUILD}")

    echo "==> ${TARGET}"
    case "${TARGET}" in
        *.wgt) prepare_package "${TARGET}" "${BUILD}" "${OPT_ID[$i]}" "${OPT_VERSION[$i]}" ;;
        *)     prepare_source  "${TARGET}" "${BUILD}" "${OPT_ID[$i]}" "${OPT_VERSION[$i]}" ;;
    esac

    read -r APP_ID _ REQUIRED < <(read_manifest "${PKG_DIR}/config.xml")
    echo "    ${APP_ID}, needs Tizen ${REQUIRED}"

    tizen package -t wgt -s "${TIZEN_PROFILE}" -- "${PKG_DIR}" >/dev/null

    WGT="$(find "${PKG_DIR}" -maxdepth 1 -name '*.wgt' -print -quit)"
    if [ -z "${WGT}" ]; then
        echo "Packaging produced no .wgt" >&2
        exit 1
    fi

    # The .wgt is named after <name> in config.xml, which may contain spaces,
    # and both sdb and tizen install choke on those.
    SAFE="$(dirname "${WGT}")/$(basename "${WGT}" | tr ' ' '_')"
    if [ "${SAFE}" != "${WGT}" ]; then
        mv "${WGT}" "${SAFE}"
        WGT="${SAFE}"
    fi

    if [ -d /out ]; then
        # -f: an earlier run under a different image may have left a .wgt there
        # owned by root.
        cp -f "${WGT}" /out/
        echo "    package: /out/$(basename "${WGT}")"
    else
        echo "    package: $(basename "${WGT}") - mount /out to keep it"
    fi

    [ -n "${TV_IP}" ] || continue

    if [ -n "${OPT_REPLACE[$i]}" ]; then
        echo "    removing ${APP_ID} first"
        tizen uninstall -p "${APP_ID}" -t "${TV_NAME}" >/dev/null 2>&1 || true
    fi

    # tizen install exits 0 even when the platform log says the install failed.
    # The text it printed is the only signal.
    INSTALL_OUT="$(tizen install -n "$(basename "${WGT}")" \
        -- "$(dirname "${WGT}")" -t "${TV_NAME}" 2>&1 || true)"

    case "${INSTALL_OUT}" in
        *"successfully installed"*)
            echo "    installed"
            continue
            ;;
    esac

    FAILED=1
    printf '%s\n' "${INSTALL_OUT}" | grep -v 'installing\[' >&2

    case "${INSTALL_OUT}" in
        *"install failed[118012]"*)
            cat >&2 <<EOF

    118012: the set turned down the certificate on ${APP_ID}. Two causes have
    been seen, and they need opposite answers:

      - that id is already on the set under a different author certificate.
        Try --replace, or delete the app on the TV under Apps and run again.
      - the set turns that package id down outright, whether or not anything
        is installed under it. A two-file widget carrying the id is refused
        in well under a second while the same widget under a fresh id
        installs. Pass --package-id with another ten characters.
EOF
            ;;
        *"install failed[118019]"*)
            cat >&2 <<EOF

    118019: the package asks for Tizen ${REQUIRED} and this set is older.
    --required-version lowers what it asks for, which gets it installed; an
    app built against a newer platform can still fail once it runs.
EOF
            ;;
    esac
done

exit "${FAILED}"
