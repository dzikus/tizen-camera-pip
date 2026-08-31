# Tizen CLI, a signing profile and sdb: everything needed to turn the widget in
# this repository into a signed .wgt and put it on the TV.

ARG UBUNTU_VERSION=26.04
FROM ubuntu:${UBUNTU_VERSION}

# 6.1's org.tizen.common.builder calls org.eclipse.core.runtime.Plugin, which no
# jar in its own web-cli package provides. tizen build-web cannot run there.
ARG TIZEN_VERSION=6.0
ARG TIZEN_SHA256=56e9365e75a60323cc3fc36a91a25bd4fe18dd4bc97f01c0219dd4699e86edb5
ARG TIZEN_PROFILE=dev
ARG AUTHOR_PASS=camera-pip

# AUTHOR_PASS stays an ARG: only the RUN that writes the profile needs it.
ENV DEBIAN_FRONTEND=noninteractive \
    HOME=/home/ubuntu \
    TIZEN_HOME=/home/ubuntu/tizen-studio \
    TIZEN_PROFILE=${TIZEN_PROFILE} \
    PATH=/home/ubuntu/tizen-studio/tools:/home/ubuntu/tizen-studio/tools/ide/bin:${PATH}

# No JDK: the installer carries one and the CLI prefers it over any system java.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        libpng16-16 \
        pciutils \
        python3 \
        python3-yaml \
        unzip \
        wget \
        zip \
    && rm -rf /var/lib/apt/lists/*

RUN install -d -o ubuntu -g ubuntu /author

USER ubuntu
WORKDIR /home/ubuntu

# The cache mount keeps the 264 MB installer out of the layer, where editing
# this file cannot invalidate it, and -c resumes an interrupted download.
#
# ulimit: the bundled JDK sizes its file descriptor table from the soft limit
# and aborts on the container default. installer.sh ignores java's exit code.
# Without the final test the build would carry on and produce an image with no
# tizen in it.
RUN --mount=type=cache,target=/dl,uid=1000,gid=1000 \
    wget -q -c -O "/dl/tizen-cli-${TIZEN_VERSION}.bin" \
      "http://download.tizen.org/sdk/Installer/tizen-studio_${TIZEN_VERSION}/web-cli_Tizen_Studio_${TIZEN_VERSION}_ubuntu-64.bin" \
    && echo "${TIZEN_SHA256}  /dl/tizen-cli-${TIZEN_VERSION}.bin" | sha256sum -c - \
    && install -m 755 "/dl/tizen-cli-${TIZEN_VERSION}.bin" /tmp/tizen-cli.bin \
    && ulimit -n 4096 \
    && /tmp/tizen-cli.bin --accept-license "${TIZEN_HOME}" \
    && rm /tmp/tizen-cli.bin \
    && test -x "${TIZEN_HOME}/tools/ide/bin/tizen"

COPY --chown=ubuntu:ubuntu signing-profile.sh entrypoint.sh /home/ubuntu/

# Generated once and kept in the repository. signing-profile.sh says why.
COPY --chown=ubuntu:ubuntu author.p12 /author/author.p12

RUN ulimit -n 4096 \
    && /home/ubuntu/signing-profile.sh "${TIZEN_PROFILE}" "${AUTHOR_PASS}" /author

WORKDIR /work
ENTRYPOINT ["/home/ubuntu/entrypoint.sh"]
