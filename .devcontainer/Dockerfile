FROM mcr.microsoft.com/devcontainers/python:3.15@sha256:eb39f07323784af4c7558396808ceb01dacbe6dd7c63614f34d0235d0344a0ff

USER root
RUN apt-get update && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && rm /tmp/requirements.txt
USER vscode
