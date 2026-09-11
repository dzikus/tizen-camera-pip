# tizen-camera-pip

[![checks](https://github.com/dzikus/tizen-camera-pip/actions/workflows/checks.yml/badge.svg?branch=main)](https://github.com/dzikus/tizen-camera-pip/actions/workflows/checks.yml)
[![codeql](https://github.com/dzikus/tizen-camera-pip/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/dzikus/tizen-camera-pip/actions/workflows/codeql.yml)
[![scorecard](https://api.scorecard.dev/projects/github.com/dzikus/tizen-camera-pip/badge)](https://scorecard.dev/viewer/?uri=github.com/dzikus/tizen-camera-pip)
[![release](https://img.shields.io/github/v/release/dzikus/tizen-camera-pip?sort=semver)](https://github.com/dzikus/tizen-camera-pip/releases/latest)
[![license](https://img.shields.io/github/license/dzikus/tizen-camera-pip)](LICENSE)

<a href="https://www.buymeacoffee.com/dzikus" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>

Puts a camera on a Samsung Tizen TV when something happens: the doorbell rings,
someone walks up the drive. No Android TV box, no extra hardware. When the app
closes, the TV goes back to what was on before. A live input carries on, and an
app like Netflix resumes where it was.

Developed and measured on a Samsung UE65NU8042 (2018, Tizen 4.0), sideloaded
with an ordinary public developer certificate. The doorbell here is a Dahua VTO
and the streams come from go2rtc inside Frigate, but nothing in the app depends
on that. Home Assistant is optional: it launches the app on a trigger and
answers the webhook the on-screen actions post to, and anything that can do
those two things works in its place.

## What the app does

One to four cameras, composed into a mosaic on the TV itself, never on a
server. The leading camera is drawn large and its sound plays; the arrow keys
move the lead and the sound follows it.

If another app is on screen when the camera appears, the app drops to a single
camera and plays it through the hardware video decoder instead of drawing it.
That decides whether the other app survives, and it is the constraint most of
the design comes from.

## Requirements

- A Samsung Tizen TV in developer mode
- go2rtc, or anything serving HLS with AAC audio and MJPEG over HTTP
- Docker, for the Tizen CLI; no local Tizen Studio install is needed

## Which TVs

Tested on one set: UE65NU8042, 2018, Tizen 4.0. Every measurement in this
README comes from that TV.

What decides whether a set installs the widget is the distributor certificate
it was signed with. This set accepts the old chain (`Tizen Public Distributor
Signer`, expired 2022) and rejects the renewed one (`Tizen Studio Public
Signer`, valid to 2032) with `install failed[118012]`. Same package id, same
build, only the certificate changed. Reports from Tizen 8.0 firmware show the
reverse: the old chain rejected with `install failed[118, -12]`. We have no
newer set here, and we do not know where the cutoff is.

Expect this to install on sets of a similar age, and to fail with a certificate
error on much newer ones. The app itself is not model-specific.

If your set rejects it, open an issue. Producing a second build signed with the
renewed chain is a small change. To add it we need: TV model, Tizen version
from Settings, and confirmation that the build installed and ran. Please do not
report an untested guess - it would go into this README as a fact.

## Install

Enable developer mode on the TV: Apps, then 12345, then Developer mode on, then
enter the IP of the machine you build from, then restart the TV.

```bash
cp app/config.example.yaml app/config.yaml   # then edit it
./build-install.sh <TV_IP>
```

The first run builds the image in `docker/`, which takes a few minutes and a
264 MB download; after that it is reused. Everything - compiling the
configuration, building, signing, installing - happens inside it. Docker is all
this host needs.

The image signs with a `dev` profile backed by the SDK's public distributor
certificate, which is all that public-level privileges such as `tv.window`
require. No Samsung partner account is involved.

To build the widget without a TV, run the image with no address:

```bash
docker run --rm -v "$PWD:/work:ro" -v "$PWD/dist:/out" tizen-cli:local
```

The image installs prebuilt packages as well as the widget in this repository.
A target is a widget directory here or a `.wgt` anywhere on this machine, and
several of them go in one run:

```bash
./build-install.sh <TV_IP> app --replace ~/Downloads/Jellyfin.wgt
```

An option binds to the target after it. `--package-id` replaces the
ten-character package id, `--required-version` replaces the platform floor the
manifest asks for, and `--replace` uninstalls that application id first. A
released `.wgt` carries whoever built it in its signature, or carries no
signature at all; either way it is unpacked, stripped and signed with this
image's certificate before it reaches the set.

`docker/author.p12` is in this repository on purpose, and every build of the
image signs with it. A set refuses to replace a package signed by a different
author - `install failed[118012]`. An image that minted its own certificate per
build would do that to everyone on every release. The key grants nothing:
privileges come from the distributor certificate, which ships in every copy of
Tizen Studio.

If a widget signed elsewhere is already installed under the same id, remove it
first. `--replace` does that, and it worked here on a package carrying somebody
else's author signature; where it does not, delete the app on the TV. Once,
either way.

The same code comes back for a second reason: a set that turns a package id
down outright, with nothing installed under it. A two-file widget carrying such
an id was refused in well under a second while the same widget under a fresh id
installed, on one certificate throughout. `--package-id` gives it ten other
characters.

Launch it over the remote-control WebSocket. This is the one step outside the
container, and it needs `websocket-client`:

```bash
pip install websocket-client
python3 tools/tv-launch.py <TV_IP> launch CamPip0001.CameraPip
```

The id is `CamPip0001.CameraPip`. The `.wgt` is named after `<name>` in
`config.xml`, and launching that name silently does nothing.

The first WebSocket connection makes the TV ask whether to allow the device.
Authorisation is a TV setting, not a step in the protocol: the client
name appears under General, External Device Manager, Device Connection Manager,
Device List, and a denied row refuses everything. The connection that raises the
prompt is refused whatever the viewer answers, and accepting it authorises the
next one. The app reconnects once by itself.

`remoteToken` does not have to be filled in. The app is handed a token on
`ms.channel.connect` and keeps it in `localStorage`, which an install leaves
alone. The config key pins one of your own. To find it, read it out of the
debug trace - `app channel: token issued` - which needs `debugUrl` set.

The TV's own REST API launches it as well: `POST /api/v2/applications/<id>`
answers 200 and the widget comes up, measured with this one sideloaded app
installed. The WebSocket takes the same id and is what this project uses.

### On an event, from Home Assistant

The same channel, called by an automation instead of by hand:

```yaml
- action: media_player.play_media
  target:
    entity_id: media_player.<TV>
  data:
    media_content_type: app
    media_content_id: CamPip0001.CameraPip
```

The `media_player` entity has to come from an integration that speaks the
remote-control WebSocket. This setup runs `samsungtv_smart` 0.14.5, the custom
integration installed through HACS; the built-in `samsungtv` integration is
untested here. The example fires only while the TV is on, and guards the call
with a state condition.

`homeassistant/tizen_camera_pip.yaml.example` is a working package: that call on
a doorbell trigger, and a webhook that answers the on-screen actions.

## Configuration

`app/config.yaml` is the source of truth. The build compiles it into the
`config.js` that the app loads, because Tizen 4's WebKit has no YAML parser.
Never edit `config.js` by hand. Both files are git-ignored to keep local
addresses out of the repository; `app/config.example.yaml` is the reference.

Each camera takes three URLs, because each is for a different job:

| key | used for |
|---|---|
| `videoUrl` | H.264 and AAC, decoded in hardware. The player uses this everywhere: full screen in lean mode, and in the leading tile of the mosaic |
| `mjpegUrl` | the small mosaic tiles, which are the only pictures the app decodes itself |
| `hlsUrl` | a fallback for a camera with no `videoUrl` |

The other forty-three keys are documented where they are set, in
`app/config.example.yaml`.

### Actions

The app posts the action id and the layout it is in. It knows nothing about
gates or doors:

```yaml
actionUrl: "http://ha.local:8123/api/webhook/camera_pip_action"
actions:
  - id: gate
    label: "Open gate"
    key: up
    closeAfter: true
```

```json
{ "action": "gate", "layout": "fullscreen" }
```

What the id means is decided by whatever receives it, and the same app works on
any setup. `key` binds an action to a physical button. Actions without a `key`
are selected with up and down, and run with the D-pad centre.

### The remote

Samsung's slim remotes have no colour buttons on the body. Every action here is
on the D-pad and RETURN; the red key only opens the id list, and
`tools/tv-launch.py <TV_IP> key KEY_RED` sends it without a button.

| button | what it does |
|---|---|
| left, right | move the leading camera |
| up, down | select an action that has no key of its own |
| D-pad centre | run the selected action, or close when there is none |
| a key bound in `actions` | run that action, ahead of anything above |
| red | show the known app ids |
| RETURN | close |

The selection is on up and down, not left and right, because with a second
camera configured left and right are already spoken for, and an action without a
key of its own could otherwise never be reached.

`closeKeys` chooses which keys close the app; play and pause are not among them
by default. `inputGraceMs` ignores every key for the first 900 ms after launch.

## Layouts

`fullscreen` is the only layout this TV allows, and it never touches the video
plane. `camera-corner` and `source-corner` are implemented and configurable, for
TVs that may tolerate `tvwindow`, but on this model they fall back. The fallback
is automatic: a fuse in `localStorage` notices when a run dies shortly after
touching the video plane, and after two such deaths in a row the app stops
trying (`tvWindowFuse`, `tvWindowFuseTrips`, `tvWindowSettleMs`).

## Diagnostics

`sdb shell` is closed on this TV in ordinary developer mode. There is no `dlog`
and no Web Inspector. The app reports over HTTP instead:

```bash
python3 tools/debug-listener.py 8099
# then set debugUrl in config.yaml
```

Without `debugUrl` the app logs nothing at all, since the trace only ever leaves
in a report and there is no inspector here to print to. Every report carries
`freeMb` and `minFreeMb`.

`memorySampleMs` samples free memory continuously and is off by default: at 500
it is about ninety lines a run, which pushes the events out of the trace. Turn
it on to measure. A sudden jump upwards of two or three hundred megabytes is not
the collector catching up; it is the background app being killed and its memory
reclaimed.

`diagnoseOnly: true` puts the app on screen with no tiles, no player and no
connections, samples memory, reports and exits. It is the baseline to compare
anything else against.

## Two ways to put a picture on this screen

The rest of this README is what was measured on the device, and where the design
above comes from.

MJPEG in an `<img>` decodes every frame in software, turns it into a texture and
repaints a full screen compositing layer. H.264 through AVPlay goes to the
hardware decoder and lands on the video plane, where the frames never enter the
app's memory at all.

Measured, one full-screen camera, system free memory at its lowest:

| what is on screen | free memory | background app |
|---|---|---|
| nothing (empty page) | 355 MB, flat | survives |
| one MJPEG tile plus AVPlay audio | 187 MB | killed |
| one MJPEG tile, no player | 139 MB | killed |
| one H.264 stream through AVPlay | 335 MB, rising | survives |

Tizen's `resourced` daemon kills background applications when free memory runs
short, least recently used first, and it spares the foreground by design. An
MJPEG tile drives memory into that range within about two seconds. Lowering the
source resolution or frame rate does almost nothing, because the cost is the
compositing layer, and that is the size of the framebuffer, not of the stream.

The app uses the player wherever it can: full screen in lean mode, and in the
leading tile of the mosaic. Only the small tiles are MJPEG, and they are only
drawn when nothing is running behind us.

Shrinking the framebuffer was tried and reverted. It saved about 4.5 MB against
the 200 MB the transport costs, and the app-list screen needs the pixels.

## What is not possible on this model

A picture-in-picture overlay over a live input. `tizen.tvwindow.show()`
composites the live picture behind the app's HTML exactly as documented, and
then the platform unloads the app about 2.9 seconds later:

```
show() ok
+2.94s   visibilitychange  ->  document.hidden = true
+2.97s   pagehide, persisted = false      (a teardown, not a resumable freeze)
         JavaScript stops and never resumes
```

There is no error and no crash. It is the platform's policy that the source is
now the foreground, and the app that was over it gets backgrounded. That is the
same behaviour behind the familiar "Tizen app closes when you switch inputs".
Handling `visibilitychange` does not help: it arrives 27 ms before an
uncancellable `pagehide`, and `persisted = false` means the teardown cannot
become a resume.

Measured identical across every variant tried: transparent and opaque pages,
1920x1080, 1919x1079 and 640x360 rects, `BEHIND` and `FRONT`, re-issuing
`show()` on a timer, `setSource()` first. `type:'PIP'` is not accepted at all,
since the `WindowType` enum is `MAIN` only. Samsung's own unmodified TVWindow
and OverlayPiP samples, built with the same certificate, die the same way.

A partner certificate does not help. `show()` returns success, not
`SecurityError`, and no permission gate is involved; a partner certificate
raises privilege level, and this is lifecycle policy. A sweep of the Samsung
developer forum, Stack Overflow and GitHub found no report of a partner
certificate keeping a `tvwindow` overlay alive. The setups where an overlay
does survive run on signage and hospitality panels, where the policy is
inverted. Ruled out on the device: `prelaunch.support` metadata, the `tv.pip`
feature declaration, and the `tv.audio` and `tv.channel` privileges.

A tiled mosaic of several hardware pictures. `webapis.avplaystore.getPlayer()`
does hand out multiple players, and both open, prepare and play, but there is
one video plane: without a video mixer the second player puts the first into
`PAUSED`. The mixer properties `USE_VIDEOMIXER` and `SET_MIXEDFRAME` are
documented "only for product B2B" and throw `TypeMismatchError` on this set.
One hardware picture at a time.

`setDisplayRect()` does work, with `PLAYER_DISPLAY_MODE_FULL_SCREEN`. Given a
960x540 rectangle the picture stayed inside it, confirmed on screen. Under
`PLAYER_DISPLAY_MODE_LETTER_BOX` the same call is accepted and reports no
error, and a rectangle smaller than the screen is ignored. The leading mosaic
tile is the player, positioned into that tile.

A stream that signals no pixel aspect is drawn at its coded ratio: a 16:9 view
encoded as 704x576 comes out at 1.22:1. Per camera, `aspect` gives the real
ratio and the picture is fitted to it.

## What the TV will tell an app

| question | answer |
|---|---|
| `tizen.org/feature/tv.pip` | `true`, and misleading |
| `tv.window` privilege level | public; a developer certificate is enough |
| the TV's own REST API from inside the app | reachable, on `127.0.0.1:8001` |
| the remote-control WebSocket from inside the app | reachable, opens in about 100 ms |
| which app is on screen | `/api/v2/applications/<id>` carries a `visible` flag |
| free system memory | `tizen.systeminfo.getAvailableMemory()`, synchronous |
| a way to force garbage collection | none, on any name |

Reading `running: true` from the REST API does not mean the TV returned to that
app. The process can be alive while the screen sits on an HDMI input. Confirm
what happened by looking at the screen.

## Deciding whether to go lean

Before drawing anything, the app asks the TV whether any application from
`watchApps` is visible. This is a race, because once the app owns the screen
every other app reports `visible:false`. The question goes out as early as
JavaScript can run, one request per id, and the verdict is taken on the first
`visible:true`. Answers have been measured between 65 and 1040 ms.

`watchApps` is the whole list. On-device discovery was tried and removed:
`getAppsContext()` answers in over a second, which loses the race, and it
returns platform services, not the app on screen. There is no learned
storage and no fallback: an app missing from `watchApps` gets the full mosaic
and may be killed for it.

Press the red key to see what to put there: the applications the TV lists, minus
the platform's own entries and background workers, each with its id. The screen
has no timeout; OK, RETURN or the red key closes it.

A store application carries two ids and only one of them answers. The installed
package form, `RN1MCdNq8t.Netflix`, reports `visible:false` even with Netflix on
screen; the launchable numeric form, `11101200001`, is the one that answers. The
red-key screen lists the numeric form. A sideloaded app has one id and it
answers: `AprZAARz4r.Jellyfin` reported `visible:true` while it was on screen.

Unless every watched app has replied by the deadline, the result is treated as
unknown and the app stays lean. One fast "not visible" while five probes are
still outstanding is not an answer: measured with a streaming app on screen,
one replied in 65 ms and the other five between 1006 and 1040 ms, and a 900 ms
deadline drew tiles over the running app and killed it. `soundProbeMs` has to
cover the slow first REST call after a launch. Only the tiles wait on it; the
player starts before the probe.

## Leaving the screen

Call `exit()`, never `hide()`. `exit()` hands the screen straight back to
whatever was in front, with no Smart Hub bar and no black frame. `hide()` leaves
the app resident but frozen, executing no timers, and the next launch resurrects
that frozen instance mid-teardown. That was the original "the window opens and
instantly vanishes" bug.

Only close AVPlay if it was actually opened. Calling `stop()` or `close()` on a
player that never started resets the video plane, and the TV then falls back to
its HDMI input instead of returning to the previous app.

## Sound

AVPlay on an HLS stream whose audio is genuinely AAC. It is the only transport
that produces sound here. RTSP never leaves `IDLE`; a bare MP3 stream fails to
prepare; an HTML5 `<audio>` element on a live stream stalls with `MediaError 4`;
go2rtc's progressive `stream.mp4` plays for about four seconds and freezes; and
go2rtc's default HLS carries audio as `audio/mpeg`, which AVPlay decodes but
never outputs.

The Dahua VTO was switched from PCM to AAC with

```bash
curl -g 'http://<vto>/cgi-bin/configManager.cgi?action=setConfig&Encode[0].MainFormat[0].Audio.Compression=AAC'
```

`curl -g` matters, because brackets are curl globs.

Every branch plays the same URL, and every stream carries video and audio
together. Lean mode shows the player full screen; the mosaic puts it in the
leading tile and draws the small tiles beside it. Only the rectangle depends on
the lean verdict, and it can be moved afterwards. The player still starts
before the verdict arrives.

The cameras send AAC at 8 to 16 kHz, which AVPlay will not output. The audio is
resampled to 44.1 kHz stereo on the way through. The doorbell also sits near
-60 dB and is amplified; the others are not.

## Time to picture

For a doorbell the gap between the ring and the picture is what matters. Three
causes decide it:

- AVPlay collects several seconds of media before it reports playing.
- go2rtc's HLS window is hardcoded to two segments, and a joining player waits
  for the rest to be produced in real time.
- HLS segments close on keyframes, and the doorbell emitted one every ten
  seconds (`Video.GOP=50` at `Video.FPS=5`).

A launch either landed just after a keyframe and got its buffer in one
ten-second segment, or waited up to ten seconds for the next one. Measured
starts of 1.7 / 3.9 / 6.9 / 7.9 s are exactly that. Setting `GOP = FPS` alone
made it worse and consistent, 9.1 to 9.5 s, because one-second segments must
then be collected one at a time.

The fix is a playlist with segments already written, which go2rtc cannot be
configured to serve. A small ffmpeg producer per camera does, reading go2rtc's
restream instead of the camera, which opens no extra RTSP session:

| doorbell source | time to playing |
|---|---|
| go2rtc, 10 s keyframes | 1 697 - 11 862 ms, a lottery |
| go2rtc, 1 s keyframes | 9 094 - 9 536 ms |
| own producer, 1 s keyframes | **785 - 1 308 ms** |

Playlist depth barely matters past four segments; six is used, which keeps the
picture close to the live edge. Switching cameras is a close and reopen and
costs the same again, 0.8 to 2.2 s over six presses, and the arrows work in
lean mode too.

Doing the same on your own cameras is `hls-producer/README.md`: the keyframe
interval, the playlist depth, and a working stack.

## License

GPL-3.0. The full text is in `LICENSE`.

## References

- [TVWindow API](https://developer.samsung.com/smarttv/develop/api-references/tizen-web-device-api-references/tvwindow-api.html)
- [Showing PiP Overlays](https://developer.samsung.com/smarttv/develop/guides/pip-picture-in-picture/showing-pip-overlays.html)
- [Multitasking and application lifecycle](https://developer.samsung.com/smarttv/develop/guides/fundamentals/multitasking.html)
- [SamsungDForum/TVWindow sample](https://github.com/SamsungDForum/TVWindow)
- [Samsung/Tizen.NET issue 289, app closes on input switch](https://github.com/Samsung/Tizen.NET/issues/289)
- [go2rtc](https://github.com/AlexxIT/go2rtc)
- [Frigate](https://github.com/blakeblackshear/frigate)
