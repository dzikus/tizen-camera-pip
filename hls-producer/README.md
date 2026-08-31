# hls-producer

One ffmpeg per camera, an nginx to serve the segments, and a shared tmpfs. The
producers run on the camera host, not next to the app; the compose file is an
example because it carries addresses and credentials.

The measurements that led here are under "Time to picture" in the top-level
README. This file is what to do about them on your own cameras. Two things have
to be true, and neither is about the TV.

## A keyframe every second

Segments close on keyframes. The keyframe interval is the smallest useful
segment, and until the first one arrives a joining player has nothing at all. On
a Dahua the interval is `Video.GOP` divided by `Video.FPS`:

```bash
curl -g --digest -u user:pass \
  'http://<camera>/cgi-bin/configManager.cgi?action=getConfig&name=Encode' \
  | grep -E 'Video.(FPS|GOP)='
curl -g --digest -u user:pass \
  'http://<camera>/cgi-bin/configManager.cgi?action=setConfig&Encode[0].MainFormat[0].Video.GOP=5'
```

Set `GOP` to that stream's `FPS`, not to a fixed number: the streams here run at
5, 20 and 25 fps, and one value would mean a keyframe five times a second on
some of them, spending bitrate for nothing. And only on the streams a player
joins. On a recording stream it costs picture quality and speeds up nothing.

## A playlist with segments already written

ffmpeg keeps as many as `-hls_list_size` asks for, and the player fetches its
buffer instead of waiting for it to exist:

```bash
ffmpeg -rtsp_transport tcp -i rtsp://<host>:8554/<stream> \
  -map 0:v:0 -map 0:a:0? -c:v copy \
  -af aresample=async=1 -c:a aac -b:a 128k -ar 44100 -ac 2 \
  -f hls -hls_time 1 -hls_list_size 6 \
  -hls_flags delete_segments+omit_endlist+independent_segments \
  -hls_segment_type mpegts -hls_segment_filename /hls/cam_%05d.ts /hls/cam.m3u8
```

`-c:v copy`, with no re-encoding: the cost is one process per camera and a
little RAM. Serve `/hls` with any static web server; nginx is enough. Read from a
restream instead of the camera if you have one, since a doorbell station has
few RTSP sessions to give. Put `/hls` on tmpfs, because every segment is
rewritten each second all day.

## The stack

`docker-compose.yaml.example` is a working version of all of it: one producer
per camera, one nginx on port 8090, a shared tmpfs, and a service that asserts
the camera settings once at start, which stops a factory reset quietly undoing
them. Copy it to `docker-compose.yaml`, copy `.env.example` to `.env`, and edit
both.
