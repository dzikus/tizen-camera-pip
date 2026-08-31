#!/usr/bin/env python3
"""
Launch (or list) apps on a Samsung Tizen TV over its remote-control WebSocket.

This is the same channel the TV's own mobile remote uses. POST
/api/v2/applications/<id> is no use here: the set exposes only the most recently
installed sideloaded app and answers 404 for the rest.

Only websocket-client is required. No Home Assistant, no vendor SDK.

    python3 tools/tv-launch.py <TV_IP> list
    python3 tools/tv-launch.py <TV_IP> launch <APP_ID>
    python3 tools/tv-launch.py <TV_IP> key KEY_RED
    python3 tools/tv-launch.py <TV_IP> probe

The first connection makes the TV show an "allow this device?" prompt. That run
is refused whatever the viewer answers; allow it and run the command again. The
token that comes back is cached in ~/.tizen-camera-pip-token-<TV_IP> with the
dots of the address written as underscores, and later runs are silent.

The TV files each client under the name sent here, as a row in General >
External Device Manager > Device Connection Manager, and a denied row refuses
everything. TV_CLIENT_NAME picks the name. Check an identity without reading
anything off the screen:

    TV_CLIENT_NAME=camera-pip python3 tools/tv-launch.py <TV_IP> probe
"""

import base64
import json
import os
import ssl
import sys

import websocket

DEFAULT_CLIENT_NAME = "tizen-camera-pip"
CLIENT_NAME = os.environ.get("TV_CLIENT_NAME", DEFAULT_CLIENT_NAME)
TOKEN_FILE = os.path.expanduser("~/.tizen-camera-pip-token")


def _token_path(ip):
    # The default name keeps its original filename, which leaves a token that
    # already works where it is; other identities get a file of their own.
    base = f"{TOKEN_FILE}-{ip.replace('.', '_')}"
    return base if CLIENT_NAME == DEFAULT_CLIENT_NAME else f"{base}-{CLIENT_NAME}"


def _load_token(ip):
    try:
        with open(_token_path(ip)) as handle:
            return handle.read().strip()
    except OSError:
        return ""


def _save_token(ip, token):
    # 0600: this token authorises remote control of the TV. The open() mode
    # applies only on creation; chmod covers a file that already exists.
    path = _token_path(ip)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write(token)
    os.chmod(path, 0o600)


def connect(ip, timeout=10):
    """Open the remote channel, preferring the secure port."""
    name = base64.b64encode(CLIENT_NAME.encode()).decode()
    token = _load_token(ip)

    attempts = [
        (
            f"wss://{ip}:8002/api/v2/channels/samsung.remote.control"
            f"?name={name}" + (f"&token={token}" if token else ""),
            {"cert_reqs": ssl.CERT_NONE},
        ),
        (f"ws://{ip}:8001/api/v2/channels/samsung.remote.control?name={name}", None),
    ]

    last = None
    for url, sslopt in attempts:
        try:
            ws = websocket.create_connection(url, timeout=timeout, sslopt=sslopt)
        # websocket-client raises its own errors, socket errors and ssl errors
        # from this one call.
        except Exception as exc:
            last = f"{url.split('?')[0]} -> {exc}"
            continue

        raw = ws.recv()
        msg = json.loads(raw)
        if msg.get("event") == "ms.channel.connect":
            new_token = (msg.get("data") or {}).get("token")
            if new_token and new_token != token:
                _save_token(ip, str(new_token))
                print(f"[token saved for {ip}]", file=sys.stderr)
            return ws
        last = f"{url.split('?')[0]} -> unexpected: {raw[:160]}"
        ws.close()

    raise SystemExit(f"could not open the remote channel\n  last: {last}")


def list_apps(ws):
    ws.send(
        json.dumps(
            {
                "method": "ms.channel.emit",
                "params": {"event": "ed.installedApp.get", "to": "host"},
            }
        )
    )
    while True:
        msg = json.loads(ws.recv())
        if msg.get("event") == "ed.installedApp.get":
            return (msg.get("data") or {}).get("data", [])


def launch(ws, app_id, action_type="NATIVE_LAUNCH"):
    ws.send(
        json.dumps(
            {
                "method": "ms.channel.emit",
                "params": {
                    "event": "ed.apps.launch",
                    "to": "host",
                    "data": {"appId": app_id, "action_type": action_type},
                },
            }
        )
    )


def send_key(ws, key):
    ws.send(
        json.dumps(
            {
                "method": "ms.remote.control",
                "params": {
                    "Cmd": "Click",
                    "DataOfCmd": key,
                    "Option": "false",
                    "TypeOfRemote": "SendRemoteKey",
                },
            }
        )
    )


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        raise SystemExit(2)

    ip, action = sys.argv[1], sys.argv[2]
    if action in ("launch", "key") and len(sys.argv) < 4:
        raise SystemExit(f"{action} needs one more argument\n{__doc__}")

    ws = connect(ip)
    try:
        if action == "list":
            for app in list_apps(ws):
                print(f"{app.get('appId', ''):32} {app.get('name', '')}")
        elif action == "launch":
            launch(ws, sys.argv[3])
            print(f"launch sent: {sys.argv[3]}")
        elif action == "key":
            send_key(ws, sys.argv[3])
            print(f"key sent: {sys.argv[3]}")
        elif action == "probe":
            print(f"channel authorised for {CLIENT_NAME!r} on {ip}")
        else:
            raise SystemExit(f"unknown action: {action}")
    finally:
        ws.close()


if __name__ == "__main__":
    main()
