#!/usr/bin/env bash
#
# Write the profile the widget is signed with, around the author certificate
# the image was built with.
#
# That certificate is generated once and lives in the repository, not made here
# per build: a set refuses to replace a package signed by a different author,
# and refuses to uninstall it too. A certificate that changed with every build
# would strand the app on every TV it had ever reached. It is published on
# purpose and grants nothing; privileges come from the distributor certificate,
# which ships in every copy of Tizen Studio.
#
# Tizen Studio 5.0 moved certificate passwords into the desktop keyring:
# `tizen security-profiles add` writes a *.pwd lookup key into profiles.xml and
# the CLI then shells out to secret-tool, which a container cannot answer. Any
# password not ending in .pwd is still read the pre-5.0 way. This script writes
# the profile itself, with the passwords encrypted by the CLI's own CipherUtil.
set -euo pipefail

PROFILE="${1:?profile name}"
AUTHOR_PASS="${2:?author certificate password}"
AUTHOR_DIR="${3:-/author}"

AUTHOR_P12="${AUTHOR_DIR}/author.p12"
[ -f "${AUTHOR_P12}" ] || { echo "No author certificate at ${AUTHOR_P12}" >&2; exit 1; }
DIST_P12="${TIZEN_HOME}/tools/certificate-generator/certificates/distributor/tizen-distributor-signer.p12"
DIST_PASS=tizenpkcs12passfordsigner
PROFILES="${HOME}/tizen-studio-data/profile/profiles.xml"

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

# Both passwords in one JVM start; a second start costs about a second.
cat > "${WORK}/encrypt.js" <<'JS'
var C = Java.type("org.tizen.common.util.CipherUtil")
for (var i = 0; i < arguments.length; i++) print(C.getEncryptedString(arguments[i]))
JS
mapfile -t BLOBS < <("${TIZEN_HOME}/jdk/bin/jrunscript" \
    -cp "$(printf '%s:' "${TIZEN_HOME}"/tools/ide/lib-ncli/*.jar)" \
    -f "${WORK}/encrypt.js" "${AUTHOR_PASS}" "${DIST_PASS}")
# mapfile succeeds on an empty stream and set -e cannot see into the process
# substitution. Without the check below, a failed jrunscript would surface as
# "BLOBS[0]: unbound".
[ "${#BLOBS[@]}" -eq 2 ] || {
    echo "CipherUtil produced ${#BLOBS[@]} of the 2 encrypted passwords" >&2
    exit 1
}

mkdir -p "$(dirname "${PROFILES}")"
cat > "${PROFILES}" <<XML
<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<profiles active="${PROFILE}" version="3.1">
<profile name="${PROFILE}">
<profileitem ca="" distributor="0" key="${AUTHOR_P12}" password="${BLOBS[0]}" rootca=""/>
<profileitem ca="" distributor="1" key="${DIST_P12}" password="${BLOBS[1]}" rootca=""/>
<profileitem ca="" distributor="2" key="" password="" rootca=""/>
</profile>
</profiles>
XML
chmod 600 "${PROFILES}"

# Signed once here. An image that cannot sign fails while it is being built,
# not at somebody's first install.
mkdir -p "${WORK}/probe"
cat > "${WORK}/probe/config.xml" <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<widget xmlns="http://www.w3.org/ns/widgets" xmlns:tizen="http://tizen.org/ns/widgets"
        id="http://tizen-camera-pip/selftest" version="1.0.0">
    <tizen:application id="Selftest01.selftest" package="Selftest01" required_version="2.3"/>
    <content src="index.html"/>
    <name>selftest</name>
</widget>
XML
printf '<!DOCTYPE html>\n<title>selftest</title>\n' > "${WORK}/probe/index.html"

cd "${WORK}/probe"
tizen build-web -- . >/dev/null
tizen package -t wgt -s "${PROFILE}" -- .buildResult >/dev/null
test -n "$(find .buildResult -name '*.wgt' -print -quit)"
