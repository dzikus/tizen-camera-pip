FROM mcr.microsoft.com/devcontainers/python:3.15@sha256:6e261c4a01a94ab86485a6b9d08083c3e968ea51440c0c24b6efaa771c33312d

USER root
RUN apt-get update && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && rm /tmp/requirements.txt
USER vscode
