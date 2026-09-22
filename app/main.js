/*
 * Camera viewer for a Samsung Tizen TV, developed against a UE65NU8042 running
 * Tizen 4.0 with a public developer certificate.
 *
 * Two measured platform facts constrain everything below. Both contradict the
 * documentation, and both were measured on the device, not reasoned out.
 *
 *   tizen.tvwindow.show() unloads the app about 2.9s later whatever the
 *   arguments. Neither corner layout can work here.
 *
 *   exit() hands the screen back to whatever was in front. hide() leaves a
 *   frozen instance that the next launch resurrects mid-teardown.
 */

// One scope for the widget. The body is not re-indented.
(function () {

var DEFAULTS = {
    cameras: [],
    primaryCamera: 0,
    sound: true,

    leanWhenAppRunning: true,

    // The ids whose presence on screen puts the app into lean mode. Nothing is
    // discovered: this list is the whole of it, and the red key shows what is
    // installed. ignoreApps only hides entries from that screen.
    watchApps: [],
    ignoreApps: [],
    // How long the app list waits for the TV. Generous: the TV may be holding
    // the connection while it asks the viewer to allow the device.
    appListTimeoutMs: 30000,

    // Identity on the remote-control channel. The name is the row the TV shows
    // under Device Connection Manager, and it decides what has to be allowed
    // there. The token belongs to websocketsecure on 8002 and may well be
    // ignored on 8001. The app keeps the one it is handed in localStorage,
    // which an install leaves alone; this key pins one of your own.
    remoteName: 'camera-pip',
    remoteToken: null,
    // How long the foreground probe waits for every watched app to answer.
    // The measurements behind this number are at withBackgroundApp().
    soundProbeMs: 1500,

    // Both styles leave the leading tile to the player; they differ in where
    // the small ones go. tiled gives each its own space, overlay stacks them
    // over a full-screen lead.
    mosaicStyle: 'tiled',
    overlayTile: { w: 480, h: 270, margin: 48, gap: 24 },

    layout: 'fullscreen',

    corner: 'top-right',
    margin: 56,
    smallSize: { w: 600, h: 338 },
    largeSize: { w: 1180, h: 664 },
    startEnlarged: false,
    sourceWindow: { corner: 'top-right', margin: 56, w: 640, h: 360 },

    tvWindowZ: 'BEHIND',
    preferSource: null,
    forceSetSource: false,
    tvWindowFuse: true,
    tvWindowFuseTrips: 2,
    tvWindowSettleMs: 8000,

    dismissAfter: 45,          // seconds on screen; 0 = stay until dismissed
    inputGraceMs: 900,
    lifeBar: { show: true, position: 'top' },
    exitDelayMs: 1200,
    restoreApp: true,
    restoreTimeoutMs: 1500,

    actionUrl: null,
    actions: [],
    showLegend: 'auto',
    hintText: null,
    // The only characters in this file outside ascii, here and in appsFoot
    // below. The publishing gate allows exactly these five.
    keyGlyphs: {
        up: '▲', down: '▼', left: '◀', right: '▶',
        ok: 'OK', playpause: '⏯'
    },
    closeKeys: ['return', 'exit'],

    showClock: true,
    showHint: true,
    showName: true,
    showDot: true,

    // In appsFoot, %n is the entry count, %p the page and %t the page count.
    text: {
        camKey: 'camera',
        okKey: 'run',
        closeKey: 'close',
        appsTitle: 'Applications this TV knows',
        appsSub: 'Copy an id into watchApps in config.yaml',
        appsEmpty: 'Nothing installed that this TV will show.',
        appsFoot: '%n apps, page %p of %t   |   ◀ ▶ - page   |   ' +
                  'OK, RETURN or RED - close',
        appsFailed: 'The TV would not list its applications.',
        appsUnauthorized: 'The TV refused this app twice. Allow it under General - ' +
                          'External Device Manager - Device Connection Manager.',
        tagWatched: 'watched'
    },

    openWebhook: null,
    closeWebhook: null,

    debugUrl: null,
    // How often to sample free memory, in ms; 0 leaves it alone. Off by
    // default: at twice a second it is ninety lines a run, which pushes the
    // events out of a 240-line trace.
    memorySampleMs: 0,
    diagnoseOnly: false,
    diagnoseMs: 20000
};

var CFG = {};

function isPlainObject(v) {
    return !!v && typeof v === 'object' && !(v instanceof Array);
}

function mergeInto(target, source) {
    for (var k in source) {
        if (source.hasOwnProperty(k)) { target[k] = source[k]; }
    }
    return target;
}

(function mergeConfig() {
    var user = window.PIP_CONFIG || {};
    var k;
    mergeInto(CFG, DEFAULTS);
    // Unknown keys are carried through: dropping an option the user set is
    // worse than keeping a harmless one.
    for (k in user) {
        if (!user.hasOwnProperty(k)) { continue; }
        // One level deep. A config that renames two of the on-screen strings
        // keeps the rest of them, and a partial smallSize does not produce
        // 'undefinedpx'. Arrays are replaced outright - a shorter watchApps has
        // to mean a shorter watchApps.
        CFG[k] = (isPlainObject(DEFAULTS[k]) && isPlainObject(user[k]))
            ? mergeInto(mergeInto({}, DEFAULTS[k]), user[k])
            : user[k];
    }
})();

// Drained by each report, never resent whole: sending the entire log with
// every event put the same 240 lines out eight times a run.
var trace = [];

function log(msg) {
    // Nothing reads either of these without debugUrl: the trace goes out in
    // reports, and this set has no inspector to print to.
    if (!CFG.debugUrl) { return; }
    trace.push(new Date().getTime() % 100000 + ' ' + msg);
    if (trace.length > 240) { trace.shift(); }
    console.log('[CameraPip] ' + msg);
}

// Samsung's legacy Smart TV guidance, "Memory optimization for Smart TV Apps":
// XHR holds on to a lot while parsing. Whether destroy() exists on this WebKit
// is untested, and the guard costs nothing either way.
function releaseXhr(xhr) {
    try { if (xhr && xhr.destroy) { xhr.destroy(); } } catch (e) { /* not fatal */ }
}

function post(url, payload) {
    if (!url) { return; }
    try {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', url, true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.onreadystatechange = function () {
            if (xhr.readyState === 4) { releaseXhr(xhr); }
        };
        xhr.send(JSON.stringify(payload));
    } catch (e) {
        console.log('[CameraPip] post failed: ' + e.message);
    }
}

var minFreeMb = null;

function gcCapabilities() {
    var caps = [];
    if (typeof window.gc === 'function') { caps.push('window.gc'); }
    if (typeof window.CollectGarbage === 'function') { caps.push('window.CollectGarbage'); }
    if (typeof window.collectGarbage === 'function') { caps.push('window.collectGarbage'); }
    try {
        if (typeof webapis !== 'undefined' && webapis) {
            for (var k in webapis) {
                if (/mem|gc|garbage|resource/i.test(k)) { caps.push('webapis.' + k); }
            }
        }
    } catch (e) { /* enumerating a native object can throw */ }
    return caps;
}

// Dynamic Analyzer will not attach to these sets. System-wide free memory is
// the only number available, and the right one: resourced kills on system
// pressure, not on this app's footprint.
function freeMemMb() {
    try {
        var mb = Math.round(tizen.systeminfo.getAvailableMemory() / 1048576);
        if (minFreeMb === null || mb < minFreeMb) { minFreeMb = mb; }
        return mb;
    } catch (e) { return null; }
}

function report(event, extra) {
    if (!CFG.debugUrl) { return; }
    var payload = { event: event, trace: trace,
                    freeMb: freeMemMb(), minFreeMb: minFreeMb };
    for (var k in extra) { if (extra.hasOwnProperty(k)) { payload[k] = extra[k]; } }
    trace = [];
    post(CFG.debugUrl, payload);
}

/*
 * Every timer is registered here, and a relaunch clears the lot. An earlier
 * version armed a close-deadline timer that nothing cleared, and the next
 * launch inherited it and hid the window a second after it appeared.
 */
var timers = [];

function later(fn, ms) {
    var id = setTimeout(function () {
        var i = timers.indexOf(id);
        if (i > -1) { timers.splice(i, 1); }
        fn();
    }, ms);
    timers.push(id);
    return id;
}

function repeat(fn, ms) {
    var id = setInterval(fn, ms);
    timers.push(id);
    return id;
}

// An interval outlives its own id. Clearing one without unregistering it left a
// dead entry behind, and resetDismissTimer() arms a fresh one on every key
// press: the list only ever grew.
function stopTimer(id) {
    if (id === null || id === undefined) { return; }
    clearTimeout(id);
    clearInterval(id);
    var i = timers.indexOf(id);
    if (i > -1) { timers.splice(i, 1); }
}

function clearAllTimers() {
    for (var i = 0; i < timers.length; i++) {
        clearTimeout(timers[i]);
        clearInterval(timers[i]);
    }
    timers = [];
}

var TOKEN_KEY = 'pipRemoteToken';

/*
 * show() kills the app on this model, and the corner layouts have never been
 * run anywhere else. The fuse stops an experiment turning into an unbootable
 * loop: two deaths in a row and resolveLayout() falls back to fullscreen.
 */
var FUSE_KEY = 'pipTvWindowFailures';
var ATTEMPT_KEY = 'pipTvWindowAttempt';

/*
 * A launch aimed at a widget that is already on screen does not always arrive as
 * an appcontrol event: this set reloads the widget from scratch, and the fresh
 * run probes the foreground while WE are the foreground. Every watched app then
 * answers visible:false truthfully, and the verdict comes out "nobody is behind
 * us". Measured: with HBO Max running, six probes answered in 120-154 ms, all
 * negative, and the mosaic went up over it.
 *
 * The marker below survives exactly that: only a clean exit removes it.
 * Finding it means the run before this one was still on screen. Its verdict is
 * worth more than anything this run's probe can see.
 */
var ONSCREEN_KEY = 'pipOnScreen';
var ONSCREEN_MAX_AGE_MS = 120000;

// Sits in the same slot as an application id and is not one.
var VERDICT_UNKNOWN = 'unknown';

function noteOnScreen(appId) {
    try {
        window.localStorage.setItem(ONSCREEN_KEY, JSON.stringify(
            { at: new Date().getTime(), app: appId || null }));
    } catch (e) { /* no storage, no carry-over */ }
}

function clearOnScreen() {
    try { window.localStorage.removeItem(ONSCREEN_KEY); } catch (e) { /* ignore */ }
}

// undefined when there is nothing to carry; null is itself an answer, and means
// the previous run decided nothing was behind it.
function carriedVerdict() {
    try {
        var raw = window.localStorage.getItem(ONSCREEN_KEY);
        if (!raw) { return undefined; }
        var v = JSON.parse(raw);
        if (!v || new Date().getTime() - v.at > ONSCREEN_MAX_AGE_MS) { return undefined; }
        return v.app;
    } catch (e) { return undefined; }
}

function fuseFailures() {
    try { return parseInt(window.localStorage.getItem(FUSE_KEY) || '0', 10) || 0; }
    catch (e) { return 0; }
}

function fuseBlown() {
    return CFG.tvWindowFuse && fuseFailures() >= CFG.tvWindowFuseTrips;
}

function fuseNoteAttempt() {
    try {
        // A key left over from a previous run means that run did not survive.
        if (window.localStorage.getItem(ATTEMPT_KEY)) {
            var n = fuseFailures() + 1;
            window.localStorage.setItem(FUSE_KEY, String(n));
            log('video plane: previous attempt did not survive (' + n + ')');
            report('tvwindow-fuse', { failures: n });
        }
        window.localStorage.setItem(ATTEMPT_KEY, String(new Date().getTime()));
    } catch (e) { /* no storage, no fuse */ }
}

function fuseSurvived() {
    try {
        window.localStorage.removeItem(ATTEMPT_KEY);
        window.localStorage.setItem(FUSE_KEY, '0');
        log('video plane: attempt survived, fuse reset');
    } catch (e) { /* ignore */ }
}

function resolveLayout(wanted) {
    if (wanted !== 'camera-corner' && wanted !== 'source-corner') { return 'fullscreen'; }
    if (fuseBlown()) {
        log('layout ' + wanted + ' requested but the video-plane fuse is blown - using fullscreen');
        report('fuse-fallback', { wanted: wanted, failures: fuseFailures() });
        return 'fullscreen';
    }
    return wanted;
}

function sameSource(a, b) {
    return a && b && a.type === b.type && a.number === b.number;
}

function ensureLiveSource(done) {
    try {
        tizen.systeminfo.getPropertyValue('VIDEOSOURCE', function (info) {
            var connected = info.connected || [];
            if (!connected.length) { log('no connected video sources'); done(); return; }

            var current = null;
            try { current = tizen.tvwindow.getSource(); } catch (e) { /* ignore */ }

            var wanted = null, i;
            if (CFG.preferSource) {
                for (i = 0; i < connected.length; i++) {
                    if (sameSource(connected[i], CFG.preferSource)) { wanted = connected[i]; break; }
                }
            }
            if (!wanted) {
                var live = false;
                for (i = 0; i < connected.length; i++) {
                    if (sameSource(connected[i], current)) { live = true; break; }
                }
                wanted = live ? current : connected[0];
            }

            if (sameSource(wanted, current) && !CFG.forceSetSource) { done(); return; }
            tizen.tvwindow.setSource(wanted,
                function () { done(); },
                function (e) { log('setSource failed: ' + e.name); done(); },
                'MAIN');
        }, function (e) { log('VIDEOSOURCE failed: ' + e.name); done(); });
    } catch (e) {
        log('VIDEOSOURCE threw: ' + e.name);
        done();
    }
}

function videoPlaneRect() {
    if (view.layout !== 'source-corner') { return ['0px', '0px', '1920px', '1080px']; }
    var w = CFG.sourceWindow || {};
    var width = w.w || 640, height = w.h || 360, margin = w.margin || 56;
    var c = w.corner || 'top-right';
    var x = c.indexOf('left') > -1 ? margin : (1920 - width - margin);
    var y = c.indexOf('top') === 0 ? margin : (1080 - height - margin);
    return [x + 'px', y + 'px', width + 'px', height + 'px'];
}

function showVideoPlane(done) {
    var z = view.layout === 'source-corner' ? 'FRONT' : CFG.tvWindowZ;
    fuseNoteAttempt();
    try {
        tizen.tvwindow.show(
            function () {
                log('tvwindow shown (' + z + ')');
                later(fuseSurvived, CFG.tvWindowSettleMs);
                done(true);
            },
            function (e) { log('tvwindow.show failed: ' + e.name); done(false); },
            videoPlaneRect(), 'MAIN', z
        );
    } catch (e) {
        log('tvwindow.show threw: ' + e.name);
        done(false);
    }
}

/*
 * AVPlay on HLS with genuine AAC is the only audio route that works here.
 * HTML5 <audio> stalls on an endless stream, a bare MP3 fails to prepare, RTSP
 * never leaves IDLE, and go2rtc's default HLS muxes audio as audio/mpeg, which
 * AVPlay decodes but never outputs.
 *
 * AVPlay plays network media, not an external input, and does not trip the
 * teardown that makes tvwindow unusable.
 */

/*
 * `active` separates a stream that died mid-play, which restartPlayer retries,
 * from one that never started, which goes straight to onFail. Reading it
 * without `failed` is how an earlier version drew tiles over a stream that was
 * fine. `restarts` is handed out fresh per camera.
 */
var PLAYER_RESTARTS = 3;

var settleTimer = null;

var player = {
    opened: false,
    active: false,
    used: false,
    failed: false,
    restarts: 0,
    gen: 0
};

/*
 * Logged at boot, and the answers are on record for this set: avplay,
 * avplaystore and getPlayer are present, getAllPlayers is not. Two players from
 * getPlayer() both open, prepare and play - but without a video mixer the
 * second puts the first into PAUSED, and the mixer properties throw
 * TypeMismatchError here: they are B2B-only. One picture at a time, and the
 * mosaic draws its other tiles from MJPEG.
 */
function playerCapabilities() {
    var caps = [];
    try {
        if (typeof webapis === 'undefined' || !webapis) { return caps; }
        if (webapis.avplay) { caps.push('avplay'); }
        if (webapis.avplaystore) {
            caps.push('avplaystore');
            if (typeof webapis.avplaystore.getPlayer === 'function') {
                caps.push('getPlayer');
            }
            if (typeof webapis.avplaystore.getAllPlayers === 'function') {
                caps.push('getAllPlayers');
            }
        }
    } catch (e) { /* enumerating a native object can throw */ }
    return caps;
}

/*
 * Measured on the set: a 960x540 rect held the picture exactly inside it.
 * setDisplayRect works here, and the leading tile can be hardware video.
 *
 * Recomputed on every call, never captured: the lean verdict lands after the
 * player has started.
 */
// A stream that signals no pixel aspect is drawn at its coded ratio: a 16:9
// view encoded as 704x576 comes out at 1.22:1.
function cameraAspect(cam) {
    var a = cam && cam.aspect;
    if (!a) { return 0; }
    var parts = String(a).split(/[:\/x]/);
    if (parts.length === 2) {
        var w = parseFloat(parts[0]), h = parseFloat(parts[1]);
        return (w > 0 && h > 0) ? w / h : 0;
    }
    var n = parseFloat(a);
    return n > 0 ? n : 0;
}

function fitToAspect(r, aspect) {
    if (!aspect) { return r; }
    var w = r[2], h = r[3];
    if (w / h > aspect) { w = Math.round(h * aspect); }
    else { h = Math.round(w / aspect); }
    return [r[0] + Math.round((r[2] - w) / 2),
            r[1] + Math.round((r[3] - h) / 2), w, h];
}

function playerRect() {
    return fitToAspect(tileRects(cameraList().length)[0],
                       cameraAspect(currentCamera()));
}

// LETTER_BOX ignores a rect smaller than the screen here: full screen lands
// exactly, a mosaic tile does not.
function displayMethod(r) {
    // fitToAspect has already shaped the rect; the picture is stretched to it.
    if (cameraAspect(currentCamera())) { return 'PLAYER_DISPLAY_MODE_FULL_SCREEN'; }
    return (r[0] === 0 && r[1] === 0 && r[2] === SCREEN_W && r[3] === SCREEN_H)
        ? 'PLAYER_DISPLAY_MODE_LETTER_BOX'
        : 'PLAYER_DISPLAY_MODE_FULL_SCREEN';
}

function applyPlayerRect() {
    var r = playerRect();
    try {
        webapis.avplay.setDisplayMethod(displayMethod(r));
        webapis.avplay.setDisplayRect(r[0], r[1], r[2], r[3]);
    } catch (e) { log('setDisplayRect failed: ' + e.name); }
}

function startAvplayAt(url, onFail) {
    // open() and prepareAsync() are timed separately. They behave differently:
    // open() is synchronous and costs 12 to 50 ms, prepareAsync() is not and
    // costs 0.6 to 1.3 s. Only the second is worth overlapping with anything,
    // and it is most of the delay before a picture appears.
    var startedAt = new Date().getTime();
    var prepareFrom = 0;
    var prepared = false;
    var readyTimer = null;
    var gen = ++player.gen;

    function superseded(where) {
        if (gen === player.gen) { return false; }
        log('avplay: ' + where + ' from a superseded player, ignored');
        return true;
    }

    // Runs once, from whichever of the three routes below arrives first.
    function afterPrepare(via) {
        if (prepared || superseded('a prepare')) { return; }
        prepared = true;
        stopTimer(readyTimer);
        readyTimer = null;
        log('avplay: prepared via ' + via + ', ' +
            (new Date().getTime() - prepareFrom) + ' ms, total ' +
            (new Date().getTime() - startedAt) + ' ms');

        // Method before rect, and both again here: the rect is accepted in
        // READY state without being applied.
        var wanted = playerRect();
        var rectDiag = { wanted: wanted, via: via, method: displayMethod(wanted) };
        try {
            webapis.avplay.setDisplayMethod(rectDiag.method);
        } catch (e) { rectDiag.method += ' FAILED ' + e.name + ': ' + e.message; }
        try {
            webapis.avplay.setDisplayRect(wanted[0], wanted[1], wanted[2], wanted[3]);
            rectDiag.rect = 'ok';
        } catch (e) { rectDiag.rect = 'FAILED ' + e.name + ': ' + e.message; }
        try { rectDiag.state = webapis.avplay.getState(); } catch (e) { /* ignore */ }
        rectDiag.page = [SCREEN_W, SCREEN_H];
        try { rectDiag.screen = [window.screen.width, window.screen.height]; }
        catch (e) { /* ignore */ }
        try { rectDiag.stream = webapis.avplay.getCurrentStreamInfo(); }
        catch (e) { rectDiag.stream = 'FAILED ' + e.name; }
        report('avplay-rect', rectDiag);

        // The player now carries the picture in both branches: sound:false
        // mutes it and does not stop it being opened.
        takeMute(!view.sound);
        try { webapis.avplay.play(); } catch (e) { log('avplay: play() ' + e.name); }

        // Keep re-applying until PLAYING, then confirm once.
        stopTimer(settleTimer);
        var tries = 0;
        var lastErr = null;
        settleTimer = repeat(function () {
            if (gen !== player.gen) { stopTimer(settleTimer); settleTimer = null; return; }
            tries++;
            var st = '';
            try { st = webapis.avplay.getState(); } catch (e) { st = 'state? ' + e.name; }
            // Reported, never swallowed: a refusal here is the reason
            // the picture would sit in the wrong place. Re-read each tick:
            // a lean verdict arriving mid-settle then moves the picture.
            var now = playerRect();
            try {
                webapis.avplay.setDisplayRect(now[0], now[1], now[2], now[3]);
                lastErr = null;
            } catch (e) {
                lastErr = e.name + ': ' + e.message;
            }
            if (st === 'PLAYING' || tries > 20) {
                stopTimer(settleTimer);
                settleTimer = null;
                report('avplay-rect-settled',
                       { state: st, tries: tries, rect: now, rectError: lastErr });
            }
        }, 300);
        player.active = true;
        player.used = true;
        log('avplay: playing, sound ' + (view.sound ? 'on' : 'muted'));
        report('avplay-playing', {});
    }

    try {
        webapis.avplay.open(url);
        log('avplay: open() ' + (new Date().getTime() - startedAt) + ' ms');
        player.opened = true;

        applyPlayerRect();
        webapis.avplay.setListener({
            onbufferingstart: function () { log('avplay: buffering'); },
            onbufferingcomplete: function () {
                log('avplay: buffered');
                afterPrepare('buffered');
            },
            onstreamcompleted: function () { log('avplay: stream ended'); },
            onerror: function (e) {
                if (superseded('an error')) { return; }
                log('avplay error: ' + e);
                report('avplay-error', { error: String(e) });
                if (player.active) { restartPlayer(); return; }
                if (onFail) { onFail(); }
            },
            onevent: function () { /* not interesting */ }
        });
        prepareFrom = new Date().getTime();
        webapis.avplay.prepareAsync(function () {
            afterPrepare('callback');
        }, function (e) {
            if (superseded('a prepare failure')) { return; }
            log('avplay prepare failed: ' + e);
            report('avplay-prepare-failed', { error: String(e) });
            stopTimer(readyTimer);
            readyTimer = null;
            if (onFail) { onFail(); }
        });

        var waits = 0;
        var pushErr = null;
        readyTimer = repeat(function () {
            if (gen !== player.gen) { stopTimer(readyTimer); readyTimer = null; return; }
            waits++;
            var st = '';
            try { st = webapis.avplay.getState(); } catch (e) { /* not up yet */ }
            var r = playerRect();
            try {
                webapis.avplay.setDisplayMethod(displayMethod(r));
                webapis.avplay.setDisplayRect(r[0], r[1], r[2], r[3]);
                pushErr = null;
            } catch (e) { pushErr = e.name + ': ' + e.message; }
            if (st === 'READY' || st === 'PLAYING' || st === 'PAUSED') {
                afterPrepare('state ' + st);
            } else if (waits > 150) {
                stopTimer(readyTimer);
                readyTimer = null;
                log('avplay: no READY state after 30 s, last ' + (st || 'unknown'));
                report('avplay-never-ready',
                       { state: st || null, rect: r, rectError: pushErr });
            }
        }, 200);
    } catch (e) {
        log('avplay threw: ' + e.name);
        if (onFail) { onFail(); }
    }
}

// tv.audio mutes the whole set, not this app. Read once, put back in quit().
var mutedBefore = null;

function takeMute(mute) {
    try {
        if (mutedBefore === null) { mutedBefore = tizen.tvaudiocontrol.isMute(); }
        tizen.tvaudiocontrol.setMute(mute);
    } catch (e) { log('setMute failed: ' + e.name); }
}

function restoreMute() {
    if (mutedBefore === null) { return; }
    try { tizen.tvaudiocontrol.setMute(mutedBefore); } catch (e) { /* ignore */ }
    mutedBefore = null;
}

function stopAvplay() {
    // Closing a player that was never opened resets the video plane, and the TV
    // then falls back to its HDMI input instead of the app the viewer came from.
    if (!player.opened) { return; }
    player.gen++;
    player.opened = false;
    player.active = false;
    try { webapis.avplay.stop(); } catch (e) { /* ignore */ }
    try { webapis.avplay.close(); } catch (e) { /* ignore */ }
}

var card  = document.getElementById('card');
var life  = document.getElementById('life');
var clock = document.getElementById('clock');
var hint  = document.getElementById('hint');
var title = document.getElementById('title');
var bar   = document.getElementById('bar');
var barDot = document.getElementById('barDot');
var actionsEl = document.getElementById('actions');
var tilesEl = document.getElementById('tiles');
var appsEl = document.getElementById('apps');
var appsListEl = document.getElementById('appsList');
var appsFootEl = document.getElementById('appsFoot');
var appsTitleEl = document.getElementById('appsTitle');
var appsSubEl = document.getElementById('appsSub');

// Asked while this file is still parsing: once we own the screen every other
// app reports visible:false.
var fgProbe = { started: new Date().getTime(), answers: 0, expected: 0,
                asked: [], found: null };

function askIfVisible(id) {
    fgProbe.asked.push(id);
    fgProbe.expected++;
    var xhr = new XMLHttpRequest();
    // These all go to one host. Whether the engine runs them at once or queues
    // them behind a connection limit is not visible from in here. Both ends of
    // each request are timed.
    var sentAt = new Date().getTime() - fgProbe.started;
    try {
        xhr.open('GET', 'http://127.0.0.1:8001/api/v2/applications/' + id, true);
        xhr.timeout = 2000;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) { return; }
            var doneAt = new Date().getTime() - fgProbe.started;
            try {
                var body = JSON.parse(xhr.responseText);
                if (body && body.visible && !fgProbe.found) {
                    fgProbe.found = id;
                    fgProbe.foundAtMs = doneAt;
                }
            } catch (e) { /* an unparseable answer is no answer */ }
            log('probe ' + id + ': sent +' + sentAt + ' answered +' + doneAt +
                ' (' + (doneAt - sentAt) + ' ms)');
            fgProbe.answers++;
            releaseXhr(xhr);
        };
        xhr.ontimeout = xhr.onerror = function () {
            fgProbe.answers++;
            releaseXhr(xhr);
        };
        xhr.send();
    } catch (e) { fgProbe.answers++; }
}

(function probeForegroundNow() {
    (CFG.watchApps || []).forEach(function (id) {
        if (fgProbe.asked.indexOf(id) === -1) { askIfVisible(id); }
    });
})();

function withBackgroundApp(done) {
    if (CFG.leanWhenAppRunning === false) { done(null); return; }
    // With nothing to ask about, waiting out the deadline burns soundProbeMs at
    // the point where memory is tightest.
    if (!fgProbe.expected) { log('no watchApps configured'); done(null); return; }

    var deadline = fgProbe.started + (CFG.soundProbeMs || 1500);
    (function wait() {
        if (fgProbe.found ||
            fgProbe.answers >= fgProbe.expected ||
            new Date().getTime() >= deadline) {
            log('foreground probe: ' + fgProbe.answers + '/' + fgProbe.expected +
                ' answered, found=' + (fgProbe.found || 'none') +
                (fgProbe.foundAtMs ? ' @' + fgProbe.foundAtMs + 'ms' : ''));

            var verdict = fgProbe.found;
            var carried = verdict ? undefined : carriedVerdict();
            if (carried !== undefined) {
                // The run before this one never got to exit. It was still on
                // screen when this one started, and the probe could only see us.
                verdict = carried;
                log('foreground probe: restarted while on screen, carrying "' +
                    (carried || 'none') + '"');
            } else if (!verdict && fgProbe.answers < fgProbe.expected) {
                // An outstanding question is not the answer "nobody is on
                // screen", and it does not become one by being in the majority.
                // Measured with HBO Max on screen: Netflix answered in 65 ms and
                // the other five between 1006 and 1040 ms. A 900 ms deadline saw
                // one "not visible" and drew three MJPEG tiles over the app it
                // was meant to spare. Anything short of every probe answering
                // takes the cheap branch.
                verdict = VERDICT_UNKNOWN;
                log('foreground probe: ' +
                    (fgProbe.expected - fgProbe.answers) +
                    ' still unanswered, not an answer - staying lean');
            }
            done(verdict);
            return;
        }
        later(wait, 50);
    })();
}

/*
 * `leading` indexes CFG.cameras and everything else derives from it, never the
 * other way round. `decided` says the lean verdict has arrived: a late player
 * failure reads it to know whether redrawing is its job or whether show() is
 * about to do it anyway. `corner` and `enlarged` mean nothing outside
 * camera-corner.
 */
var view = {
    layout: 'fullscreen',
    corner: 'top-right',
    enlarged: false,
    leading: 0,
    lean: false,
    decided: false,
    sound: true,
    behind: null
};

// config.xml asks for 1080p and the page is authored to match. A compositing
// layer costs the size of the framebuffer, not of the layout, and tile
// geometry is derived from these two - the CSS and the app-list screen are
// still written out at 1920x1080 and would have to change with it.
var SCREEN_W = window.innerWidth || 1920;
var SCREEN_H = window.innerHeight || 1080;

function allCameras() {
    return CFG.cameras || [];
}

function currentCamera() {
    var all = allCameras();
    return all[view.leading] || all[0] || {};
}

function cameraList() {
    var cams = CFG.cameras || [];
    if (view.lean && cams.length) { return [cams[view.leading] || cams[0]]; }
    return cams.slice(0, 4);
}

/*
 * The tile rectangles, leading tile first. In tiled, two or more cameras leave
 * part of the screen uncovered; paintAround() fills it.
 *
 *   overlay  leading camera full screen, the others as small tiles over it
 *   tiled    every camera in its own tile, the leading one no smaller
 */
function tileRects(count) {
    var style = CFG.mosaicStyle || 'overlay';
    var W = SCREEN_W, H = SCREEN_H;

    if (style === 'tiled') {
        if (count <= 1) { return [[0, 0, W, H]]; }
        if (count === 2) {
            return [[0, H / 4, W / 2, H / 2], [W / 2, H / 4, W / 2, H / 2]];
        }
        if (count === 3) {
            return [[0, H / 6, W * 2 / 3, H * 2 / 3],
                    [W * 2 / 3, H / 6, W / 3, H / 3],
                    [W * 2 / 3, H / 2, W / 3, H / 3]];
        }
        return [[0, H / 6, W * 2 / 3, H * 2 / 3],
                [W * 2 / 3, 0,       W / 3, H / 3],
                [W * 2 / 3, H / 3,   W / 3, H / 3],
                [W * 2 / 3, H * 2 / 3, W / 3, H / 3]];
    }

    // Config geometry is authored against 1920x1080. Scale it if the page is
    // not that size.
    var s = W / 1920;
    var t = CFG.overlayTile || {};
    var w = (t.w || 480) * s;
    var h = (t.h || 270) * s;
    var margin = (t.margin || 48) * s;
    var gap = (t.gap || 24) * s;
    var rects = [[0, 0, W, H]];
    for (var i = 1; i < count; i++) {
        rects.push([W - w - margin, margin + (i - 1) * (h + gap), w, h]);
    }
    return rects;
}

function tileOrder(count, lead) {
    var order = [lead];
    for (var i = 0; i < count; i++) { if (i !== lead) { order.push(i); } }
    return order;
}

function releaseTiles() {
    // Dropping the elements does not close the MJPEG connections; the camera
    // server runs out of concurrent streams and the tiles go black.
    var imgs = tilesEl.getElementsByTagName('img');
    for (var i = 0; i < imgs.length; i++) {
        imgs[i].onerror = null;
        imgs[i].src = '';
    }
    // Not innerHTML = '': replaced nodes are closed but stay resident (Samsung's
    // legacy "Managing Memory"), and this runs on every camera switch.
    while (tilesEl.firstChild) {
        // Assigned, not discarded: Samsung's note says an unassigned
        // removeChild result is never finalised.
        var gone = tilesEl.removeChild(tilesEl.firstChild);
        gone = null;
    }
}

/*
 * Paints the screen except the leading rectangle, as four strips around it.
 *
 * A background on #tiles cannot do this. That element spans the whole screen,
 * the player draws in the plane UNDER the graphics plane, and a transparent
 * lead tile over a painted parent shows the parent's paint.
 */
function paintAround(rect) {
    var x = rect[0], y = rect[1], w = rect[2], h = rect[3];
    var strips = [
        [0, 0, SCREEN_W, y],
        [0, y + h, SCREEN_W, SCREEN_H - y - h],
        [0, y, x, h],
        [x + w, y, SCREEN_W - x - w, h]
    ];
    for (var i = 0; i < strips.length; i++) {
        var s = strips[i];
        if (s[2] <= 0 || s[3] <= 0) { continue; }
        var d = document.createElement('div');
        d.className = 'backdrop';
        d.style.left = s[0] + 'px';
        d.style.top = s[1] + 'px';
        d.style.width = s[2] + 'px';
        d.style.height = s[3] + 'px';
        tilesEl.appendChild(d);
    }
}

function buildMosaic() {
    var cams = cameraList();
    var rects = tileRects(cams.length);
    // The lead's index within the VISIBLE list, which lean mode has narrowed to
    // one entry.
    var order = tileOrder(cams.length, view.lean ? 0 : view.leading);
    releaseTiles();
    paintAround(rects[0]);

    for (var slot = 0; slot < order.length; slot++) {
        var camIdx = order[slot];
        var cam = cams[camIdx];
        var r = rects[slot];
        var isLead = (slot === 0);

        var tile = document.createElement('div');
        // The lead is the player's rectangle in both styles. Nothing paints
        // there, and that tile costs no software decoding.
        tile.className = 'tile' + (isLead ? ' lead' : '');
        tile.style.left = r[0] + 'px';
        tile.style.top = r[1] + 'px';
        tile.style.width = r[2] + 'px';
        tile.style.height = r[3] + 'px';

        // createElement, not new Image(): the same legacy note says the
        // constructor is not finalised automatically. Both build the same
        // element, and following it costs nothing.
        if (!isLead && cam.mjpegUrl) {
            var img = document.createElement('img');
            var src = cam.mjpegUrl;
            img.src = src + (src.indexOf('?') > -1 ? '&' : '?') + '_t=' + new Date().getTime();
            tile.appendChild(img);
        }

        var wantDot = isLead && CFG.showDot;
        if (CFG.showName || wantDot) {
            var name = document.createElement('div');
            name.className = 'name';
            if (wantDot) {
                var dot = document.createElement('span');
                dot.className = 'dot';
                name.appendChild(dot);
            }
            if (CFG.showName) {
                name.appendChild(document.createTextNode(cam.name || ('Camera ' + (camIdx + 1))));
            }
            tile.appendChild(name);
        }

        tilesEl.appendChild(tile);
    }
}

/*
 * With an app behind us the picture goes through the hardware decoder instead
 * of the graphics plane. Measured floors with one full-screen camera: 335 MB
 * free through AVPlay against 139 MB through an <img>: every MJPEG frame is
 * decoded in software and repaints a full-screen layer.
 *
 * One URL serves every branch. The player is full screen in lean mode and sits
 * in the leading tile of the mosaic; the tiles around it are drawn beside it,
 * not over it. Only the rectangle depends on the lean verdict, and a rectangle
 * can be moved after the fact. The player starts before the verdict instead of
 * waiting for it. Measured: prepareAsync 0.6 to 1.3 s, the probe 65 to 1040 ms,
 * overlapping instead of queueing.
 */
function playerUrl() {
    var cam = currentCamera();
    return (cam && (cam.videoUrl || cam.hlsUrl)) || null;
}

// reopening marks the attempt that follows a stream dying mid-play, where the
// answer to a failure is restartPlayer's budget, not the mosaic.
function startPlayer(reopening) {
    var url = playerUrl();
    player.failed = false;
    if (!url || typeof webapis === 'undefined' || !webapis.avplay) {
        var why = url ? 'no avplay on this set' : 'camera has no videoUrl or hlsUrl';
        log('player not started: ' + why);
        report('player-unavailable', { reason: why, camera: view.leading });
        player.failed = true;
        if (view.decided) { showMosaic(); }
        return;
    }
    startAvplayAt(url, function () {
        if (reopening) { restartPlayer(); return; }
        player.failed = true;
        log('player did not start');
        // The failure can land either side of the verdict; only redraw once the
        // verdict exists, otherwise show() does it in a moment anyway.
        if (view.decided) { showMosaic(); }
    });
}

/*
 * Owns recovery from a stream that died after it was playing, including the
 * reopens that themselves fail. The budget is per camera: switchLead() and a
 * fresh launch both hand out a new one.
 */
function restartPlayer() {
    if (player.restarts < PLAYER_RESTARTS) {
        player.restarts++;
        log('avplay: stream died while playing, reopening (' + player.restarts + ')');
        report('avplay-restart', { attempt: player.restarts });
        stopAvplay();
        later(function () { startPlayer(true); }, 500);
        return;
    }

    log('avplay: ' + player.restarts + ' reopens did not bring the stream back');
    report('avplay-gave-up', { restarts: player.restarts, lean: view.lean });
    player.failed = true;
    if (view.decided) { showMosaic(); }
}

function updateTitle() {
    var labelled = !view.lean;
    title.textContent = (CFG.showName && !labelled) ? (currentCamera().name || '') : '';
    barDot.style.display = (CFG.showDot && !labelled) ? '' : 'none';
}

function showMosaic() {
    view.decided = true;
    updateTitle();

    // Lean mode draws no tiles, whether the player is running or has failed.
    // MJPEG is the one thing that gets the app behind us killed, and sparing it
    // is the whole reason for lean mode; a dark screen with that app still
    // alive is the better outcome.
    if (view.lean) {
        releaseTiles();
        log(player.failed ? 'lean: no player, leaving the screen dark'
                          : 'lean: hardware video, no MJPEG');
        applyPlayerRect();
        return;
    }

    buildMosaic();
    applyPlayerRect();
}

function switchLead(delta) {
    // Allowed in lean mode too, which it was not while a switch meant 1.7 to
    // 11.9 seconds of black screen. Every camera now has a playlist deep enough
    // that a press costs about what a launch does.
    var all = allCameras();
    if (all.length < 2) { return false; }
    view.leading = (view.leading + delta + all.length) % all.length;
    player.restarts = 0;
    var cam = all[view.leading] || {};
    log('leading camera -> ' + view.leading + ' (' + (cam.name || '') + ')');

    // A full close and reopen. An earlier version called webapis.avplay
    // .changeURL() to avoid it; that method is not in the AVPlay API at all and
    // threw TypeMismatchError on every press: the reopen below was doing the
    // work regardless. Measured at 0.8 to 2.2 s over six presses, the same as a
    // launch; the spread is which segment of the playlist the reopen lands on,
    // not anything this code decides.
    stopAvplay();
    startPlayer();
    // showMosaic(), not buildMosaic(): in lean mode there are no tiles to
    // rebuild and the player stays uncovered, full screen.
    showMosaic();
    resetDismissTimer();
    return true;
}

var dismissAt   = 0;
var tickTimer   = null;
var clockTimer  = null;
var launchedAt  = 0;

function usesVideoPlane() {
    return view.layout === 'camera-corner' || view.layout === 'source-corner';
}

function setClass(name, on) {
    var cls = card.className.replace(new RegExp('\\s*\\b' + name + '\\b', 'g'), '');
    card.className = on ? cls + ' ' + name : cls;
}

function layout() {
    if (view.layout !== 'camera-corner') {
        // source-corner also draws the camera full-bleed; the live picture sits
        // over it in the TV's own window.
        setClass('full', true);
        card.style.top = card.style.left = '0px';
        card.style.right = card.style.bottom = 'auto';
        card.style.width = '1920px';
        card.style.height = '1080px';
        return;
    }

    setClass('full', false);
    var size = view.enlarged ? CFG.largeSize : CFG.smallSize;
    card.style.width  = size.w + 'px';
    card.style.height = size.h + 'px';
    card.style.top = card.style.bottom = card.style.left = card.style.right = 'auto';
    if (view.corner.indexOf('top') === 0) { card.style.top = CFG.margin + 'px'; }
    else                             { card.style.bottom = CFG.margin + 'px'; }
    if (view.corner.indexOf('left') > -1) { card.style.left = CFG.margin + 'px'; }
    else                             { card.style.right = CFG.margin + 'px'; }
}

function pad(n) { return n < 10 ? '0' + n : '' + n; }

function updateClock() {
    if (!CFG.showClock) { clock.textContent = ''; return; }
    var d = new Date();
    clock.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function resetDismissTimer() {
    stopTimer(tickTimer);
    tickTimer = null;
    if (!CFG.dismissAfter) { life.style.transform = 'scaleX(1)'; return; }

    dismissAt = new Date().getTime() + CFG.dismissAfter * 1000;
    tickTimer = repeat(function () {
        var left = dismissAt - new Date().getTime();
        if (left <= 0) { quit('timeout'); return; }
        life.style.transform = 'scaleX(' + (left / (CFG.dismissAfter * 1000)) + ')';
    }, 200);
}

function show() {
    layout();

    if (!CFG.cameras || !CFG.cameras.length) {
        log('no cameras configured');
        // Nothing to draw, and the screen still has to go back by itself.
        setClass('visible', true);
        resetDismissTimer();
        return;
    }

    view.leading = Math.min(CFG.primaryCamera || 0, CFG.cameras.length - 1);
    setClass('avplay', true);
    setClass('mosaic', true);
    setClass('full', true);
    setClass('visible', true);
    view.sound = (CFG.sound !== false);

    // Started before the probe answers. The verdict decides the player's
    // rectangle and nothing else about it, and a rectangle can be moved once
    // the verdict arrives. Nothing here has to wait for it.
    view.decided = false;
    player.restarts = 0;
    startPlayer();

    withBackgroundApp(function (appId) {
        view.lean = !!appId;
        view.behind = appId || null;
        // Left behind on purpose. Only quit() removes it: a run that is
        // restarted, not closed, leaves the next one this answer.
        noteOnScreen(appId);
        if (appId) {
            log('app behind us (' + appId + ') - showing one camera to spare it');
        }
        report('decision', { backgroundApp: appId || null, lean: view.lean,
                             tiles: cameraList().length, sound: view.sound });
        showMosaic();
        if (CFG.memorySampleMs) {
            // 500 is the useful value when measuring: at one sample per second
            // the real floor fell between two readings.
            repeat(function () {
                log('free ' + freeMemMb() + ' MB');
            }, CFG.memorySampleMs);
        }
    });

    updateClock();
    stopTimer(clockTimer);
    clockTimer = null;
    if (CFG.showClock) { clockTimer = repeat(updateClock, 1000); }
    resetDismissTimer();
}

// The action legend: which entries are bound to a key, which are reachable
// with up and down, and which of those is highlighted. `selected` indexes
// `free`, not CFG.actions, and means nothing without it.
var actions = { selected: 0, bound: {}, free: [] };

var KEY_GLYPH = CFG.keyGlyphs || DEFAULTS.keyGlyphs;

function hasActions() {
    return !!(CFG.actionUrl && CFG.actions && CFG.actions.length > 0);
}

function boundKeyOf(action) {
    var k = (action.key || '').toLowerCase();
    return KEY_GLYPH.hasOwnProperty(k) ? k : null;
}

function freeActions() {
    var out = [];
    if (!hasActions()) { return out; }
    for (var i = 0; i < CFG.actions.length; i++) {
        if (!boundKeyOf(CFG.actions[i])) { out.push(i); }
    }
    return out;
}

function keyBindings() {
    var map = {};
    if (!hasActions()) { return map; }
    for (var i = 0; i < CFG.actions.length; i++) {
        var k = boundKeyOf(CFG.actions[i]);
        if (k && !map.hasOwnProperty(k)) { map[k] = i; }
    }
    return map;
}

function showLegend() {
    if (CFG.showLegend === true || CFG.showLegend === false) { return CFG.showLegend; }
    return hasActions();
}

function renderActions() {
    actions.bound = keyBindings();
    actions.free  = freeActions();
    if (!hasActions() || !showLegend()) { return; }

    setClass('has-actions', true);
    while (actionsEl.firstChild) { actionsEl.removeChild(actionsEl.firstChild); }

    for (var i = 0; i < CFG.actions.length; i++) {
        var action = CFG.actions[i];
        var key = boundKeyOf(action);
        var el = document.createElement('div');
        el.className = 'act' + (key ? ' bound' : (i === actions.free[actions.selected] ? ' sel' : ''));
        if (key) {
            var glyph = document.createElement('span');
            glyph.className = 'k';
            glyph.textContent = KEY_GLYPH[key];
            el.appendChild(glyph);
        }
        el.appendChild(document.createTextNode(action.label || action.id));
        el.setAttribute('data-idx', String(i));
        actionsEl.appendChild(el);
    }
}

function highlightActions() {
    var nodes = actionsEl.getElementsByClassName('act');
    for (var i = 0; i < nodes.length; i++) {
        var idx = parseInt(nodes[i].getAttribute('data-idx'), 10);
        var cls = nodes[i].className.replace(/\s*sel\s*/g, ' ');
        nodes[i].className = (actions.free.length && idx === actions.free[actions.selected]) ? cls + ' sel' : cls;
    }
}

function moveSelection(delta) {
    if (actions.free.length < 2) { return false; }
    actions.selected = (actions.selected + delta + actions.free.length) % actions.free.length;
    highlightActions();
    resetDismissTimer();
    return true;
}

function markAction(idx, state) {
    var nodes = actionsEl.getElementsByClassName('act');
    for (var i = 0; i < nodes.length; i++) {
        if (parseInt(nodes[i].getAttribute('data-idx'), 10) !== idx) { continue; }
        nodes[i].className = nodes[i].className.replace(/\s*(busy|done|fail)\s*/g, ' ') + ' ' + state;
    }
}

function runActionAt(idx) {
    if (!hasActions() || idx == null || !CFG.actions[idx]) { return false; }

    var action = CFG.actions[idx];
    log('action: ' + action.id);
    markAction(idx, 'busy');
    resetDismissTimer();

    var xhr = new XMLHttpRequest();
    var settled = false;

    function finish(ok) {
        if (settled) { return; }
        settled = true;
        markAction(idx, ok ? 'done' : 'fail');
        if (ok && action.closeAfter) {
            later(function () { quit('action:' + action.id); }, 900);
        }
    }

    try {
        xhr.open('POST', CFG.actionUrl, true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.timeout = 5000;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) { return; }
            finish(xhr.status >= 200 && xhr.status < 300);
            releaseXhr(xhr);
        };
        xhr.ontimeout = xhr.onerror = function () {
            finish(false);
            releaseXhr(xhr);
        };
        xhr.send(JSON.stringify({ action: action.id, layout: view.layout }));
    } catch (e) {
        log('action failed: ' + e.name);
        finish(false);
    }
    return true;
}

function runSelected() {
    if (!actions.free.length) { return false; }
    return runActionAt(actions.free[actions.selected]);
}

var quitting = false;

function quit(reason) {
    if (quitting) { return; }
    quitting = true;
    log('closing (' + reason + ')');
    // A closed run leaves nothing to carry: whatever comes next is a real
    // launch and its own probe can see past us.
    clearOnScreen();

    // clearAllTimers() already covers tickTimer and clockTimer; both went
    // through repeat().
    clearAllTimers();
    stopAvplay();
    restoreMute();
    setClass('avplay', false);
    setClass('mosaic', false);
    if (tilesEl) { releaseTiles(); }

    var behind = appBehindUs();
    post(CFG.closeWebhook, { reason: reason, layout: view.layout, restore: behind });
    report('close', { reason: reason, layout: view.layout, restore: behind,
                      restoreApp: CFG.restoreApp !== false });

    setClass('visible', false);

    /*
     * A plain wait, not a getState() poll: after close() the call throws, which
     * reads as "already released" and we leave too early. Exiting while AVPlay
     * still holds the video plane drops the TV to its HDMI input with the Smart
     * Hub bar instead of returning to the app the viewer came from.
     */
    // setTimeout, not later(): this one must not be cancellable by
    // clearAllTimers(), or the exit would never happen.
    var delay = player.used ? (CFG.exitDelayMs || 1200) : 260;
    setTimeout(function () {
        if (CFG.restoreApp !== false && behind) { restoreThenExit(behind); }
        else { exitNow(); }
    }, delay);
}

function exitNow() {
    try { tizen.application.getCurrentApplication().exit(); }
    catch (e) { log('exit threw: ' + e.name); }
}

function appBehindUs() {
    if (fgProbe.found) { return fgProbe.found; }
    return (view.behind && view.behind !== VERDICT_UNKNOWN) ? view.behind : null;
}

var restoring = false;

function restoreThenExit(appId) {
    var startedAt = new Date().getTime();
    var left = false;
    var timeout = CFG.restoreTimeoutMs || 1500;

    function leave(how) {
        if (left) { return; }
        left = true;
        var ms = new Date().getTime() - startedAt;
        log('restore ' + appId + ': ' + how + ', ' + ms + ' ms');
        report('restore', { app: appId, how: how, ms: ms });
        setTimeout(exitNow, 150);
    }

    restoring = true;
    var xhr = new XMLHttpRequest();
    try {
        xhr.open('POST', 'http://127.0.0.1:8001/api/v2/applications/' + appId, true);
        xhr.timeout = timeout;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) { return; }
            leave('HTTP ' + xhr.status);
            releaseXhr(xhr);
        };
        xhr.ontimeout = xhr.onerror = function () {
            leave('no answer');
            releaseXhr(xhr);
        };
        xhr.send();
    } catch (e) {
        leave('threw ' + e.name);
    }
    setTimeout(function () { leave('deadline'); }, timeout + 100);
}

document.addEventListener('visibilitychange', function () {
    if (document.hidden && restoring) {
        log('hidden while restoring - leaving now');
        exitNow();
    }
});

var KEY = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40,
    CENTER: 13, OK: 65376,
    RETURN: 10009, EXIT: 10182,
    PLAY_PAUSE: 10252, PLAY: 415, PAUSE: 19,
    RED: 403
};

var NAME_OF = {};
NAME_OF[KEY.UP] = 'up';
NAME_OF[KEY.DOWN] = 'down';
NAME_OF[KEY.LEFT] = 'left';
NAME_OF[KEY.RIGHT] = 'right';
NAME_OF[KEY.CENTER] = 'ok';
NAME_OF[KEY.OK] = 'ok';
NAME_OF[KEY.RETURN] = 'return';
NAME_OF[KEY.EXIT] = 'exit';
NAME_OF[KEY.PLAY_PAUSE] = 'playpause';
NAME_OF[KEY.PLAY] = 'playpause';
NAME_OF[KEY.PAUSE] = 'playpause';

function isCloseKey(named) {
    var keys = CFG.closeKeys || [];
    return named && keys.indexOf(named) > -1;
}

function toggleSize() {
    if (view.layout !== 'camera-corner') { return false; }
    view.enlarged = !view.enlarged;
    layout();
    resetDismissTimer();
    return true;
}

// Reset first: in fullscreen there is no corner to move, and the press still
// has to restart the countdown.
function moveCorner(vertical, horizontal) {
    resetDismissTimer();
    if (view.layout !== 'camera-corner') { return; }
    var parts = view.corner.split('-');
    view.corner = (vertical || parts[0]) + '-' + (horizontal || parts[1]);
    layout();
}

function bindKeys() {
    var names = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'ColorF0Red'];
    for (var i = 0; i < names.length; i++) {
        try { tizen.tvinputdevice.registerKey(names[i]); } catch (e) { /* optional */ }
    }

    document.addEventListener('keydown', function (ev) {
        var named = NAME_OF[ev.keyCode];

        if (new Date().getTime() - launchedAt < CFG.inputGraceMs) {
            log('key ' + ev.keyCode + ' ignored (startup grace)');
            return;
        }

        if (quitting) { return; }

        if (apps.open) {
            if (ev.keyCode === KEY.LEFT)  { turnAppPage(-1); return; }
            if (ev.keyCode === KEY.RIGHT) { turnAppPage(1); return; }
            if (ev.keyCode === KEY.RED || named === 'ok' || isCloseKey(named)) {
                closeAppList();
            }
            return;
        }
        if (ev.keyCode === KEY.RED) { openAppList(); return; }

        if (named && actions.bound.hasOwnProperty(named)) { runActionAt(actions.bound[named]); return; }
        if (isCloseKey(named)) { quit('remote:' + named); return; }

        switch (ev.keyCode) {
            case KEY.CENTER:
            case KEY.OK:
                // Falls through to closing when it has no other job, the
                // normal case here.
                if (!runSelected() && !toggleSize()) { quit('remote:ok'); }
                break;
            case KEY.LEFT:
                if (!switchLead(-1) && !moveSelection(-1)) { moveCorner(null, 'left'); }
                break;
            case KEY.RIGHT:
                if (!switchLead(1) && !moveSelection(1)) { moveCorner(null, 'right'); }
                break;
            // Up and down carry the selection, not left and right: with a second
            // camera configured switchLead() always answers first, and an
            // unbound action could never be reached.
            case KEY.UP:
                if (!moveSelection(-1)) { moveCorner('top', null); }
                break;
            case KEY.DOWN:
                if (!moveSelection(1)) { moveCorner('bottom', null); }
                break;
            default:
                resetDismissTimer();
        }
    });
}

function renderHint() {
    var canSwitch = CFG.cameras && CFG.cameras.length > 1;
    var camSwitchHint = canSwitch
        ? KEY_GLYPH.left + KEY_GLYPH.right + ' - ' + txt('camKey') + ' &nbsp;|&nbsp; '
        : '';
    if (CFG.hintText !== null && CFG.hintText !== undefined) {
        hint.innerHTML = camSwitchHint + CFG.hintText;
    } else if (actions.free.length) {
        hint.innerHTML = camSwitchHint + KEY_GLYPH.ok + ' - ' + txt('okKey') +
                         ' &nbsp;|&nbsp; RETURN - ' + txt('closeKey');
    } else {
        hint.innerHTML = 'RETURN - ' + txt('closeKey');
    }
    hint.style.display = CFG.showHint ? '' : 'none';
}

// The red-key screen: whether it is up, which page of it, and what the TV
// answered.
var apps = { open: false, page: 0, found: [] };

function txt(key) {
    return (CFG.text || DEFAULTS.text)[key];
}

/*
 * The two line boxes are laid out first and the font sizes derived from them.
 * Their heights then provably add up to less than the row. Deriving the fonts
 * first and computing line heights from those left two pixels of headroom on
 * the eight-row grid this screen had then, and the id line - the whole point of
 * the screen - fell outside .app's overflow and disappeared.
 */
var APP_COLS = 4;
var APP_ROWS = 6;

function appListGeometry(n) {
    var cols = Math.min(Math.ceil(n / APP_ROWS) || 1, APP_COLS);
    var rows = Math.min(Math.ceil(n / cols) || 1, APP_ROWS);
    // tagSpace is not derived: room for the "watched" tag on the right.
    var padX = 72, top = 214, bottom = 118, gap = 14, tagSpace = 150;
    var areaW = 1920 - padX * 2;
    var areaH = 1080 - top - bottom;
    var rowH = Math.floor(Math.min((areaH - gap * (rows - 1)) / rows, 168));
    var used = rowH * rows + gap * (rows - 1);

    var padY = Math.round(rowH * 0.12);
    var inner = rowH - padY * 2;
    var nameLine = Math.floor(inner * 0.54);
    var idLine = Math.floor(inner * 0.40);

    return {
        rows: rows, cols: cols, gap: gap, padX: padX, padY: padY, rowH: rowH,
        tagSpace: tagSpace,
        perPage: rows * cols,
        colW: Math.floor((areaW - gap * (cols - 1)) / cols),
        top: Math.round(top + (areaH - used) / 2),
        nameLine: nameLine, idLine: idLine,
        nameFont: Math.min(Math.floor(nameLine / 1.25), 46),
        idFont: Math.min(Math.floor(idLine / 1.25), 34)
    };
}

// Read from the platform, never written in: a rebuild under a different id must
// not list this app to itself on the screen meant for choosing other apps.
var OWN_PACKAGE = (function () {
    try {
        return (tizen.application.getCurrentApplication().appInfo.id || '')
            .split('.')[0] || null;
    } catch (e) { return null; }
})();

function isSystemApp(id) {
    if (!id) { return true; }
    if ((CFG.ignoreApps || []).indexOf(id) > -1) { return true; }
    if (OWN_PACKAGE && id.indexOf(OWN_PACKAGE) === 0) { return true; }
    if (id.indexOf('org.tizen.') === 0 ||
        id.indexOf('com.samsung.') === 0) { return true; }
    // Platform services carry a bare name - ise-default-tv, comss, rcr-device,
    // ContentServiceManager. Anything a viewer watches is either all digits
    // (11101200001 is Netflix) or package.Name.
    if (id.indexOf('.') === -1 && !/^[0-9]+$/.test(id)) { return true; }
    return false;
}

/*
 * Of 63 entries this TV reported, 14 were background workers -
 * DisneyPlusPreviewService, HBO Max Worker, SpotifyRecomendationsService and
 * others. Every one of them says as much in its id or its name.
 */
function isBackgroundWorker(app) {
    return /service|worker/i.test((app.id || '') + ' ' + (app.name || ''));
}

function remoteName() {
    return CFG.remoteName || DEFAULTS.remoteName;
}

function remoteToken() {
    if (CFG.remoteToken) { return String(CFG.remoteToken); }
    try { return window.localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
}

/*
 * Authorisation on this channel is a TV setting, not a step in the protocol.
 * The name sent here becomes a row under General > External Device Manager >
 * Device Connection Manager > Device List, each row Allowed or Denied, and
 * Access Notification decides whether the set asks again. The connection that
 * raises the prompt is refused whatever the viewer answers: accepting it
 * authorises the NEXT one. One connection can never succeed on the run that
 * asks, and the fix is one reconnect, not carrying anything across.
 *
 * The token is a websocketsecure/8002 mechanism (openhab.org, samsungtv
 * binding: "Protocol websocket only works with port 8001", "Protocol
 * websocketsecure only works with port 8002"), and 8002 needs a certificate
 * WebKit will not accept here. This TV does hand a token out on 8001, and one
 * is still sent and kept - but it is not what authorises us, and the note that
 * once claimed otherwise was reading a second attempt as a token working.
 */
function fetchInstalledApps(done) {
    var settled = false;
    var retrying = false;
    var attempts = 0;
    var timeout = null;

    function finish(list, reason) {
        if (settled) { return; }
        settled = true;
        stopTimer(timeout);
        done(list, reason);
    }

    function armDeadline() {
        stopTimer(timeout);
        // Long enough for someone to pick up the remote and answer the prompt.
        timeout = later(function () { finish(null, 'timeout'); },
                        CFG.appListTimeoutMs || 30000);
    }

    function connect(token) {
        var ws;
        attempts++;
        retrying = false;
        log('app channel: connecting as "' + remoteName() + '"' +
            (token ? ' with a token' : ' without a token') +
            (attempts > 1 ? ', attempt ' + attempts : ''));

        try {
            ws = new WebSocket('ws://127.0.0.1:8001/api/v2/channels/' +
                               'samsung.remote.control?name=' + btoa(remoteName()) +
                               (token ? '&token=' + token : ''));
        } catch (err) {
            finish(null, 'failed');
            return;
        }

        // The request waits for ms.channel.connect, not for the socket: while
        // the set is asking the viewer it holds the channel unauthorised, and
        // anything sent on open is dropped and never repeated.
        ws.onmessage = function (ev) {
            var msg = null;
            try { msg = JSON.parse(ev.data); } catch (err) { return; }
            if (!msg) { return; }

            if (msg.event === 'ms.channel.unauthorized') {
                if (attempts < 2) {
                    log('app channel: refused - reconnecting');
                    retrying = true;
                    try { ws.close(); } catch (err) { /* already going */ }
                    armDeadline();
                    later(function () { connect(''); }, 800);
                } else {
                    log('app channel: refused twice - allow "' + remoteName() +
                        '" under Device Connection Manager on the TV');
                    finish(null, 'unauthorized');
                }
                return;
            }

            if (msg.event === 'ms.channel.connect') {
                var fresh = (msg.data || {}).token;
                if (fresh && String(fresh) !== token) {
                    try { window.localStorage.setItem(TOKEN_KEY, String(fresh)); }
                    catch (err) { /* no storage, and nothing depends on it */ }
                    log('app channel: token issued -> remoteToken: "' +
                        String(fresh) + '"');
                }
                log('app channel authorised on attempt ' + attempts);
                ws.send(JSON.stringify({ method: 'ms.channel.emit',
                                         params: { event: 'ed.installedApp.get', to: 'host' } }));
                return;
            }

            if (msg.event !== 'ed.installedApp.get') {
                log('app channel: ' + msg.event);
                return;
            }

            var raw = (msg.data || {}).data || [];
            var out = [];
            for (var i = 0; i < raw.length; i++) {
                // Carry the whole entry, not just id and name. Two installs can
                // share a name - this TV lists "HBO Max" twice - and whatever
                // separates them is in the fields that trimming threw away.
                var entry = raw[i];
                entry.id = raw[i].appId;
                out.push(entry);
            }
            try { ws.close(); } catch (err) { /* already going */ }
            finish(out);
        };

        ws.onerror = function () {
            log('app channel: error');
            if (retrying) { return; }
            finish(null, 'failed');
        };
        ws.onclose = function (ev) {
            log('app channel closed' + (ev && ev.code ? ' (' + ev.code + ')' : ''));
            if (retrying) { return; }
            finish(null, 'closed');
        };
    }

    armDeadline();
    connect(remoteToken());
}

function renderAppList() {
    while (appsListEl.firstChild) {
        appsListEl.removeChild(appsListEl.firstChild);
    }
    appsTitleEl.textContent = txt('appsTitle');
    appsSubEl.textContent = txt('appsSub');
    appsFootEl.textContent = '';

    fetchInstalledApps(function (list, reason) {
        // No fallback to getAppsInfo. It answers with package ids, and a store
        // application does not match on that form: with Netflix playing,
        // RN1MCdNq8t.Netflix reads visible:false while 11101200001 reads
        // visible:true. Showing an error
        // is preferable to handing over ids that will never match.
        //
        // A refusal, a timeout and an empty answer each get their own message.
        // Each needs something different done about it.
        if (!list) {
            appsFootEl.textContent = reason === 'unauthorized'
                ? txt('appsUnauthorized') : txt('appsFailed');
            // Reported here too: the successful path reports, and the failing
            // one used to sit on its trace until the app closed - no trace at
            // the moment one was needed.
            report('apps-failed', { reason: reason || 'timeout',
                                    name: remoteName(),
                                    hadToken: !!remoteToken() });
            return;
        }
        useAppList(list);
    });
}

function useAppList(list) {
    var shown = [];
    for (var i = 0; i < list.length; i++) {
        if (isSystemApp(list[i].id)) { continue; }
        if (isBackgroundWorker(list[i])) { continue; }
        shown.push(list[i]);
    }
    // Equal names have to compare equal: this TV lists HBO Max twice, and a
    // comparator that answers 1 both ways round leaves their order to the engine.
    shown.sort(function (a, b) {
        var an = (a.name || a.id).toLowerCase();
        var bn = (b.name || b.id).toLowerCase();
        if (an === bn) { return 0; }
        return an < bn ? -1 : 1;
    });

    apps.found = shown;
    log('app list: ' + shown.length + ' of ' + list.length);
    report('apps', { count: shown.length, apps: shown });
    drawAppList();
}

function drawAppList() {
    var watched = CFG.watchApps || [];
    var g = appListGeometry(apps.found.length);

    while (appsListEl.firstChild) {
        appsListEl.removeChild(appsListEl.firstChild);
    }

    if (!apps.found.length) {
        appsFootEl.textContent = txt('appsEmpty');
        return;
    }

    var pages = Math.ceil(apps.found.length / g.perPage);
    if (apps.page >= pages) { apps.page = 0; }
    if (apps.page < 0) { apps.page = pages - 1; }
    var first = apps.page * g.perPage;
    var page = apps.found.slice(first, first + g.perPage);

    for (var i = 0; i < page.length; i++) {
        var id = page[i].id;
        var isWatched = watched.indexOf(id) > -1;
        var col = Math.floor(i / g.rows);
        var row = i % g.rows;

        var el = document.createElement('div');
        el.className = 'app' + (isWatched ? ' watched' : '');
        el.style.left = Math.round(g.padX + col * (g.colW + g.gap)) + 'px';
        el.style.top = Math.round(g.top + row * (g.rowH + g.gap)) + 'px';
        el.style.width = Math.round(g.colW) + 'px';
        el.style.height = Math.round(g.rowH) + 'px';
        el.style.padding = g.padY + 'px ' +
            (isWatched ? g.tagSpace : 20) + 'px 0 20px';

        var nameEl = document.createElement('span');
        nameEl.className = 'aname';
        nameEl.style.fontSize = g.nameFont + 'px';
        nameEl.style.height = g.nameLine + 'px';
        nameEl.style.lineHeight = g.nameLine + 'px';
        nameEl.textContent = page[i].name || id;
        el.appendChild(nameEl);

        var idEl = document.createElement('span');
        idEl.className = 'aid';
        idEl.style.fontSize = g.idFont + 'px';
        idEl.style.height = g.idLine + 'px';
        idEl.style.lineHeight = g.idLine + 'px';
        idEl.textContent = id;
        el.appendChild(idEl);

        if (isWatched) {
            var tag = document.createElement('span');
            tag.className = 'tag';
            tag.textContent = txt('tagWatched');
            el.appendChild(tag);
        }

        appsListEl.appendChild(el);
    }

    appsFootEl.textContent = txt('appsFoot')
        .replace('%n', apps.found.length)
        .replace('%p', apps.page + 1)
        .replace('%t', pages);
}

function turnAppPage(delta) {
    apps.page += delta;
    drawAppList();
}

function openAppList() {
    if (apps.open) { return; }
    apps.open = true;
    apps.page = 0;
    stopTimer(tickTimer);
    tickTimer = null;
    life.style.display = 'none';
    renderAppList();
    appsEl.className = 'open';
    log('app list shown');
}

function closeAppList() {
    if (!apps.open) { return; }
    apps.open = false;
    appsEl.className = '';
    while (appsListEl.firstChild) {
        appsListEl.removeChild(appsListEl.firstChild);
    }
    var lb = CFG.lifeBar || {};
    if (lb.show !== false) { life.style.display = ''; }
    resetDismissTimer();
}

function start() {
    quitting = false;
    launchedAt = new Date().getTime();
    view.enlarged = !!CFG.startEnlarged;
    view.corner = CFG.corner;
    actions.selected = 0;

    view.layout = resolveLayout(CFG.layout);
    log('layout: ' + view.layout);

    post(CFG.openWebhook, { layout: view.layout });

    if (usesVideoPlane()) {
        ensureLiveSource(function () {
            showVideoPlane(function (ok) {
                if (!ok) { view.layout = 'fullscreen'; }
                show();
                report('open', { layout: view.layout });
            });
        });
    } else {
        show();
        report('open', { layout: view.layout });
    }
}

function boot() {
    renderActions();

    renderHint();

    barDot.style.display = CFG.showDot ? '' : 'none';
    // With all three off the bar is an empty gradient.
    bar.style.display = (CFG.showDot || CFG.showName || CFG.showClock) ? '' : 'none';

    var lb = CFG.lifeBar || {};
    if (lb.show === false) {
        life.style.display = 'none';
    } else if ((lb.position || 'top') === 'top') {
        life.style.top = '0px';
        life.style.bottom = 'auto';
    } else {
        life.style.bottom = '0px';
        life.style.top = 'auto';
    }

    bindKeys();

    log('gc available: ' + (gcCapabilities().join(', ') || 'none'));
    log('players: ' + (playerCapabilities().join(', ') || 'none'));
    log('own package: ' + (OWN_PACKAGE || 'unknown'));

    if (CFG.diagnoseOnly) {
        // Baseline: on screen with no tiles, no player and no connections, to
        // separate the cost of taking the foreground from the cost of what we
        // draw. Measured flat at 355-379 MB.
        var ms = CFG.diagnoseMs || 20000;
        log('diagnostic run, no streams, ' + ms + ' ms');
        repeat(function () { log('free ' + freeMemMb() + ' MB'); }, 500);
        later(function () {
            report('diagnose', { layout: resolveLayout(CFG.layout),
                                 gc: gcCapabilities() });
            later(function () {
                try { tizen.application.getCurrentApplication().exit(); }
                catch (e) { /* done */ }
            }, 300);
        }, ms);
        return;
    }

    start();
}

window.onload = boot;

// The app exits on close and never hides. This only fires for a genuine
// second trigger.
window.addEventListener('appcontrol', function () {
    if (quitting) { return; }
    log('relaunched');
    clearAllTimers();
    // The player is still PLAYING from the first launch, and open() on it
    // throws. The foreground probe is deliberately not repeated: we are
    // foreground by now, and a fresh one would answer "nothing behind us" and
    // turn lean mode off.
    stopAvplay();
    start();
});

}());
