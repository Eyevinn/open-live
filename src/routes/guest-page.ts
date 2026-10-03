import type { FastifyPluginAsync } from 'fastify';

/**
 * Guest page served by the open-live backend itself (issue #382, guest calling
 * v1). It shares this backend's origin with the guest join / WHIP / return-feed
 * routes, so the browser makes same-origin calls — no CORS, and one set of paths
 * for the OSC ingress gate to let through (osaas-app#6143).
 *
 * The invite link is `https://<backend>/guest/<inviteId>#<token>`: the token
 * sits in the URL fragment so it never reaches server or proxy access logs. The
 * page reads it from `location.hash`, calls `POST /api/v1/guests/:inviteId/join`
 * with it as a bearer token, publishes camera+mic to the returned `whipUrl`
 * (WHIP), and plays the return feeds from `feeds[].url` (WHEP). Once live, the
 * guest picks what they hear (program minus themselves, or full program) with
 * `PUT …/session/return`, and the page polls `GET …/session/return` so a change
 * the crew makes shows up here too. On a return-only slot (its source is not
 * WHIP, e.g. an SRT encoder) the page never asks for a camera or microphone and
 * only plays the return; it learns which from `GET /api/v1/guests/:inviteId/slot`
 * before touching any device.
 *
 * When the join lists a `fast` feed and the mode is `program-minus`, the guest
 * hears the fast feed's audio and sees the picture feed's video with the
 * picture's own audio muted. The fast feed is always mix-minus, so in `program`
 * the guest hears the picture's audio instead. The two feeds stay on separate
 * PeerConnections so the browser cannot lip-sync the fast audio back to the
 * picture.
 *
 * This route is a plain static HTML document (no build step): the whole page is
 * embedded as a string constant so the `tsc`-only build carries it into `dist/`
 * without any asset-copy step. It is intentionally NOT under `/api/v1`, so the
 * shared-API-key onRequest gate in `server.ts` lets it through unauthenticated
 * (the page holds no secret — the token lives only in the caller's URL fragment,
 * which the server never receives).
 */

// Content-Security-Policy for the guest page. The global Helmet policy
// (`default-src 'none'`) is meant for the JSON API and would block this page's
// own inline script/style and its media playback, so we override it here to the
// minimum this page needs: same-origin everything, inline script/style for the
// self-contained document, blob:/mediastream: media for the WebRTC <video> and
// <audio> elements, and same-origin connect for the join/WHIP/WHEP fetches (WebRTC ICE
// itself is not governed by connect-src).
const GUEST_PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self' blob: mediastream:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const GUEST_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="robots" content="noindex" />
  <title>Join the broadcast</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      background: #101014; color: #f4f4f6; min-height: 100vh;
    }
    header { padding: 16px 20px; border-bottom: 1px solid #26262e; }
    header h1 { margin: 0; font-size: 18px; font-weight: 600; }
    main { max-width: 720px; margin: 0 auto; padding: 20px; }
    .videos { position: relative; margin-top: 12px; }
    video {
      width: 100%; background: #000; border-radius: 12px; display: block;
      aspect-ratio: 16 / 9; object-fit: cover;
    }
    #return { margin-top: 12px; }
    .hint { color: #a0a0ad; font-size: 13px; margin: 6px 2px 0; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
    .field { flex: 1 1 220px; }
    label { display: block; font-size: 12px; color: #a0a0ad; margin-bottom: 4px; }
    select {
      width: 100%; padding: 10px; border-radius: 8px; border: 1px solid #33333d;
      background: #1a1a20; color: #f4f4f6; font-size: 14px;
    }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 20px; }
    button {
      flex: 1 1 auto; padding: 14px 18px; font-size: 15px; font-weight: 600;
      border: 0; border-radius: 10px; cursor: pointer; color: #fff;
    }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    #golive { background: #2f9e44; }
    #rejoin { background: #2f9e44; }
    #mute { background: #364fc7; }
    #mute.muted { background: #c92a2a; }
    #leave { background: #495057; }
    #banner {
      margin-top: 16px; padding: 12px 14px; border-radius: 10px; font-size: 14px;
      background: #1a1a20; border: 1px solid #33333d;
    }
    #banner.live { background: #133a1e; border-color: #2f9e44; }
    #banner.onair { background: #3a1313; border-color: #c92a2a; }
    #banner.error { background: #3a1313; border-color: #c92a2a; }
    #banner.left { background: #1a1a20; border-color: #33333d; }
    #muted-indicator {
      display: none; margin-top: 12px; padding: 12px 14px; border-radius: 10px;
      background: #c92a2a; color: #fff; font-weight: 700; text-align: center;
      letter-spacing: 0.5px;
    }
    #muted-indicator.show { display: block; }
    #device-alert {
      margin-top: 12px; padding: 12px 14px; border-radius: 10px;
      background: #c92a2a; color: #fff; font-weight: 700;
    }
    #device-alert button { margin-top: 10px; width: 100%; background: #fff; color: #c92a2a; }
    .badge {
      display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px;
      font-weight: 700; margin-left: 8px; vertical-align: middle;
    }
    .badge.onair { background: #c92a2a; }
    #return-mode { margin-top: 16px; border: 1px solid #33333d; border-radius: 10px; padding: 10px 14px; }
    #return-mode legend { font-size: 12px; color: #a0a0ad; padding: 0 4px; }
    #return-mode label { display: flex; align-items: center; gap: 8px; font-size: 14px; color: #f4f4f6; margin: 6px 0; }
    #self-warning {
      margin-top: 8px; padding: 10px 12px; border-radius: 8px; font-size: 13px;
      background: #3a2e13; border: 1px solid #f08c00;
    }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <header><h1>Join the broadcast <span id="onair-badge" class="badge onair hidden">ON AIR</span></h1></header>
  <main>
    <div id="banner">Checking your camera and microphone&hellip;</div>
    <div id="muted-indicator">You are muted</div>
    <div id="device-alert" class="hidden" role="alert">
      <div id="device-alert-text"></div>
      <button id="device-retry">Reconnect</button>
    </div>

    <div class="videos">
      <video id="preview" autoplay playsinline muted></video>
      <div id="preview-hint" class="hint">This is your camera preview. It is muted here so you don't hear yourself.</div>
      <video id="return" autoplay playsinline class="hidden"></video>
      <audio id="return-audio" autoplay></audio>
      <div id="return-hint" class="hint hidden">Return feed from the studio.</div>
    </div>

    <fieldset id="return-mode" class="hidden">
      <legend>What you hear</legend>
      <label><input type="radio" name="return-mode" id="mode-program-minus" value="program-minus" /> Program without you</label>
      <label><input type="radio" name="return-mode" id="mode-program" value="program" /> Full program (you hear yourself, delayed)</label>
      <div id="self-warning" class="hidden">You will hear your own voice about half a second late, which makes talking hard. Switch to &ldquo;Program without you&rdquo; before you speak on air.</div>
    </fieldset>

    <div id="pickers" class="row">
      <div class="field">
        <label for="cam">Camera</label>
        <select id="cam"></select>
      </div>
      <div class="field">
        <label for="mic">Microphone</label>
        <select id="mic"></select>
      </div>
    </div>

    <div class="actions">
      <button id="golive">Go live</button>
      <button id="rejoin" class="hidden">Rejoin</button>
      <button id="mute" class="hidden">Mute mic</button>
      <button id="leave" class="hidden">Leave</button>
    </div>
  </main>

  <script>
  (function () {
    "use strict";

    // ---- Config from the URL: /guest/<inviteId>#<token> --------------------
    var parts = location.pathname.split("/").filter(Boolean);
    var inviteId = parts[parts.length - 1] || "";
    var token = (location.hash || "").replace(/^#/, "");
    var apiBase = location.origin;
    // A public STUN server for srflx candidate discovery. TURN, when configured,
    // is negotiated by the WHIP/WHEP server side; this only helps the browser
    // find its own reflexive address behind NAT.
    var ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

    // ---- Elements ----------------------------------------------------------
    var banner = document.getElementById("banner");
    var mutedIndicator = document.getElementById("muted-indicator");
    var onairBadge = document.getElementById("onair-badge");
    var preview = document.getElementById("preview");
    var previewHint = document.getElementById("preview-hint");
    var returnVideo = document.getElementById("return");
    var returnAudio = document.getElementById("return-audio");
    var returnHint = document.getElementById("return-hint");
    var camSel = document.getElementById("cam");
    var micSel = document.getElementById("mic");
    var pickers = document.getElementById("pickers");
    var goLiveBtn = document.getElementById("golive");
    var rejoinBtn = document.getElementById("rejoin");
    var muteBtn = document.getElementById("mute");
    var leaveBtn = document.getElementById("leave");
    var returnModeBox = document.getElementById("return-mode");
    var modeInputs = {
      "program-minus": document.getElementById("mode-program-minus"),
      "program": document.getElementById("mode-program")
    };
    var selfWarning = document.getElementById("self-warning");
    var deviceAlert = document.getElementById("device-alert");
    var deviceAlertText = document.getElementById("device-alert-text");
    var deviceRetryBtn = document.getElementById("device-retry");

    // ---- State -------------------------------------------------------------
    var localStream = null;
    var publishPc = null;
    var publishResource = null;
    var returnPc = null;
    var returnResource = null;
    var fastPc = null;
    var fastResource = null;
    // Whether a fast feed is listed and has not failed, and the mode whose audio
    // is playing. routeReturnAudio picks what the guest hears from these.
    var fastAvailable = false;
    var audioMode = "program-minus";
    var muted = false;
    var live = false;
    var left = false;
    // The studio connection has dropped for good (the publish peer connection
    // reached "failed", or stayed "disconnected" past the grace window). While
    // true the live banner is replaced by a "connection lost" warning and the
    // Rejoin button is offered. returnLost is the softer equivalent for the
    // return feed: the guest stops hearing the studio, but the studio still
    // gets them, so it only shows a hint.
    var publishLost = false;
    var returnLost = false;
    // "disconnected" often recovers by itself; wait this long before warning.
    var DISCONNECT_GRACE_MS = 5000;
    var publishDisconnectTimer = null;
    // The publish connection's sender for each kind ("audio", "video"), so a
    // new device can be swapped in with replaceTrack, without renegotiating.
    var senders = {};
    // Counts device requests per kind, so only the newest one is used.
    var deviceSeq = { audio: 0, video: 0 };
    // Kinds whose track has ended (device unplugged, taken by another app) or
    // that the browser has muted (no media coming from the device).
    var trackEnded = {};
    var trackMuted = {};
    // Kinds whose last reconnect failed.
    var reconnectFailed = {};
    var DEVICE_NAMES = { audio: "microphone", video: "camera" };
    // The return mode the page shows, and the poll that keeps it in step with
    // the server. modeSeq counts local changes so a poll answer that started
    // before one is dropped instead of undoing it.
    var returnMode = null;
    var modeSeq = 0;
    var modePending = 0;
    var modePoll = null;
    var MODE_POLL_MS = 5000;
    // A mode change that has not answered by then is given up, so a stalled
    // request on a bad connection cannot hold off the poll for good.
    var MODE_PUT_TIMEOUT_MS = 10000;
    // 401s in a row from the return-mode routes. The server also answers 401
    // when its database errors for a moment, so the page only treats the guest
    // as gone (kicked, invite revoked) after MODE_MAX_REFUSALS of them.
    var modeRefusals = 0;
    var MODE_MAX_REFUSALS = 3;

    function setBanner(text, cls) {
      banner.textContent = text;
      banner.className = cls || "";
    }

    function show(el) { el.classList.remove("hidden"); }
    function hide(el) { el.classList.add("hidden"); }

    // Map a join error status to a readable message (issue #382 states).
    function joinErrorMessage(status, payload) {
      if (status === 401) return "This invite link is invalid or has expired. Ask the producer for a new link.";
      if (status === 409) {
        var msg = (payload && payload.error) ? payload.error : "";
        if (/expired/i.test(msg)) return "This invite has expired. Ask the producer for a new link.";
        if (/not active|ended/i.test(msg)) return "The production has ended.";
        return "Your slot is not available right now. Ask the producer for help.";
      }
      if (status === 503) return "Guest calling is not enabled on this server.";
      return "Could not join the broadcast (error " + status + "). Please try again.";
    }

    // ---- Device setup ------------------------------------------------------
    function selectedConstraints() {
      var camId = camSel.value;
      var micId = micSel.value;
      return {
        video: camId ? { deviceId: { exact: camId } } : true,
        audio: micId ? { deviceId: { exact: micId } } : true
      };
    }

    function fillDevicePickers() {
      return navigator.mediaDevices.enumerateDevices().then(function (devices) {
        // Keep the device in use selected; rebuilding the list would
        // otherwise show the first one.
        var camInUse = deviceIdOf("video");
        var micInUse = deviceIdOf("audio");
        camSel.innerHTML = "";
        micSel.innerHTML = "";
        var camN = 0, micN = 0;
        devices.forEach(function (d) {
          if (d.kind === "videoinput") {
            var o = document.createElement("option");
            o.value = d.deviceId; o.textContent = d.label || ("Camera " + (++camN));
            if (camInUse && d.deviceId === camInUse) o.selected = true;
            camSel.appendChild(o);
          } else if (d.kind === "audioinput") {
            var o2 = document.createElement("option");
            o2.value = d.deviceId; o2.textContent = d.label || ("Microphone " + (++micN));
            if (micInUse && d.deviceId === micInUse) o2.selected = true;
            micSel.appendChild(o2);
          }
        });
      });
    }

    function startPreview() {
      var old = localStream;
      return navigator.mediaDevices.getUserMedia(selectedConstraints()).then(function (stream) {
        if (old) old.getTracks().forEach(function (t) { t.stop(); });
        localStream = stream;
        preview.srcObject = stream;
        trackEnded = {};
        trackMuted = {};
        reconnectFailed = {};
        stream.getTracks().forEach(function (t) {
          if (t.muted) trackMuted[t.kind] = true;
          watchTrack(t);
        });
        updateDeviceAlert();
        // Re-apply the current mute state to the fresh audio track.
        applyMuteToTrack();
        return fillDevicePickers();
      });
    }

    function trackOf(kind) {
      if (!localStream) return null;
      return localStream.getTracks().filter(function (t) { return t.kind === kind; })[0] || null;
    }

    function deviceIdOf(kind) {
      var t = trackOf(kind);
      var settings = t && t.getSettings ? t.getSettings() : null;
      return settings && settings.deviceId;
    }

    // A track ends when its device goes away (unplugged, taken by another app,
    // permission revoked) and is muted while the device sends nothing. Either
    // way the studio stops getting that medium, so tell the guest. Stopping a
    // track ourselves does not fire "ended".
    function watchTrack(t) {
      if (!t.addEventListener) return;
      t.addEventListener("ended", function () {
        if (trackOf(t.kind) !== t || left) return;
        trackEnded[t.kind] = true;
        updateDeviceAlert();
        // The device list has likely changed (unplugged, or a new default).
        fillDevicePickers().catch(function () {});
      });
      t.addEventListener("mute", function () {
        if (trackOf(t.kind) !== t || left) return;
        trackMuted[t.kind] = true;
        updateDeviceAlert();
      });
      t.addEventListener("unmute", function () {
        if (trackOf(t.kind) !== t) return;
        trackMuted[t.kind] = false;
        updateDeviceAlert();
      });
    }

    function failingKinds() {
      return ["video", "audio"].filter(function (k) {
        return trackEnded[k] || trackMuted[k] || reconnectFailed[k];
      });
    }

    function updateDeviceAlert() {
      var kinds = left ? [] : failingKinds();
      // While publishing, the live banner must not claim the studio gets a
      // medium it does not. When the studio connection itself is lost, leave
      // the "connection lost" warning in place instead of the live banner.
      if (live && !publishLost && Object.keys(senders).length) {
        setBanner(kinds.length ? "You are live." : "You are live. The studio can see and hear you.", "live");
      }
      if (!kinds.length) { hide(deviceAlert); return; }
      var names = kinds.map(function (k) { return DEVICE_NAMES[k]; }).join(" and ");
      var text;
      if (kinds.some(function (k) { return reconnectFailed[k]; })) {
        text = "Could not reconnect your " + names + ". Check that it is plugged in and not in use by another app, or pick another one below.";
      } else {
        text = "Your " + names + " stopped working.";
        if (live) {
          var cannot = kinds.length > 1 ? "see or hear" : (kinds[0] === "audio" ? "hear" : "see");
          text += " The studio cannot " + cannot + " you.";
        }
        text += " Reconnect it, or pick another one below.";
      }
      deviceAlertText.textContent = text;
      deviceRetryBtn.textContent = "Reconnect " + names;
      deviceRetryBtn.disabled = false;
      show(deviceAlert);
    }

    // Opens the picked device of one kind and puts it in place of the current
    // track, in the preview and, once live, in the publish connection.
    function switchDevice(kind) {
      var seq = ++deviceSeq[kind];
      var sel = kind === "audio" ? micSel : camSel;
      var exact = {};
      exact[kind] = sel.value ? { deviceId: { exact: sel.value } } : true;
      return navigator.mediaDevices.getUserMedia(exact).catch(function (err) {
        // The picked device may be the one that went away: take the default.
        if (!sel.value) throw err;
        var any = {};
        any[kind] = true;
        return navigator.mediaDevices.getUserMedia(any);
      }).then(function (stream) {
        var fresh = stream.getTracks().filter(function (t) { return t.kind === kind; })[0];
        if (seq !== deviceSeq[kind] || left || !localStream || !fresh) {
          stream.getTracks().forEach(function (t) { t.stop(); });
          return;
        }
        var sender = senders[kind];
        var swapped = sender ? sender.replaceTrack(fresh).catch(function (err) {
          fresh.stop();
          throw err;
        }) : Promise.resolve();
        return swapped.then(function () {
          if (seq !== deviceSeq[kind] || left || !localStream) {
            fresh.stop();
            // If a newer pick failed before this one landed, nothing else will
            // move the sender off this stopped track: send the one in use.
            var current = trackOf(kind);
            if (sender && sender.track === fresh && current) sender.replaceTrack(current).catch(function () {});
            return;
          }
          var old = trackOf(kind);
          var rest = localStream.getTracks().filter(function (t) { return t.kind !== kind; });
          localStream = new MediaStream(rest.concat([fresh]));
          preview.srcObject = localStream;
          if (old) old.stop();
          watchTrack(fresh);
          applyMuteToTrack();
          trackEnded[kind] = false;
          trackMuted[kind] = !!fresh.muted;
          reconnectFailed[kind] = false;
          updateDeviceAlert();
          return fillDevicePickers();
        });
      }).catch(function (err) {
        if (seq !== deviceSeq[kind] || left) return;
        // A superseded request may have put its own track, since stopped,
        // on the sender: send the track in use again.
        var current = trackOf(kind);
        if (senders[kind] && current && senders[kind].track !== current) {
          senders[kind].replaceTrack(current).catch(function () {});
        }
        reconnectFailed[kind] = true;
        updateDeviceAlert();
        throw err;
      });
    }

    function reconnectDevices() {
      deviceRetryBtn.disabled = true;
      Promise.all(failingKinds().map(function (k) {
        return switchDevice(k).catch(function () {});
      })).then(function () { deviceRetryBtn.disabled = false; });
    }

    function onPickerChange(kind) {
      if (left) return;
      if (!localStream) { startPreview().catch(function () {}); return; }
      switchDevice(kind).catch(function () {});
    }

    // Join can disagree with the slot check made at page load (the slot's
    // source may have changed since), so these two let goLive() follow join.
    function openCamera() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return Promise.reject({ handled: true, message: "This browser does not support live calling. Try a recent Chrome, Safari or Firefox." });
      }
      show(preview);
      show(previewHint);
      return startPreview().catch(function () {
        throw { handled: true, message: "Could not access your camera or microphone. Check the browser permissions and try again." };
      });
    }

    function closeCamera() {
      if (localStream) localStream.getTracks().forEach(function (t) { t.stop(); });
      localStream = null;
      preview.srcObject = null;
      trackEnded = {};
      trackMuted = {};
      reconnectFailed = {};
      hide(deviceAlert);
      hide(preview);
      hide(previewHint);
    }

    function applyMuteToTrack() {
      if (!localStream) return;
      localStream.getAudioTracks().forEach(function (t) { t.enabled = !muted; });
    }

    // ---- WebRTC helpers ----------------------------------------------------
    function waitForIce(pc) {
      return new Promise(function (resolve) {
        if (pc.iceGatheringState === "complete") return resolve();
        var done = false;
        function finish() { if (!done) { done = true; resolve(); } }
        pc.addEventListener("icegatheringstatechange", function () {
          if (pc.iceGatheringState === "complete") finish();
        });
        // Don't wait forever for a TURN-less environment: cap gathering.
        setTimeout(finish, 2000);
      });
    }

    // ---- Connection loss ---------------------------------------------------
    function clearPublishDisconnect() {
      if (publishDisconnectTimer) { clearTimeout(publishDisconnectTimer); publishDisconnectTimer = null; }
    }

    // The publish connection has gone for good: the studio no longer gets the
    // guest. Replace the live banner with a warning and offer Rejoin.
    function onPublishLost() {
      if (left) return;
      clearPublishDisconnect();
      publishLost = true;
      hide(muteBtn);
      show(rejoinBtn);
      rejoinBtn.disabled = false;
      setBanner("Connection to the studio lost. The studio can no longer see or hear you. Press \\u201cRejoin\\u201d to reconnect.", "error");
    }

    // Watches the publish peer connection. "failed" is terminal; "disconnected"
    // is given a few seconds to recover on its own before it is treated the same.
    function watchPublishConnection(pc) {
      if (!pc.addEventListener) return;
      pc.addEventListener("connectionstatechange", function () {
        if (publishPc !== pc || left) return;
        var state = pc.connectionState;
        if (state === "failed") {
          onPublishLost();
        } else if (state === "disconnected") {
          if (!publishLost && !publishDisconnectTimer) {
            setBanner("Reconnecting to the studio\\u2026", "");
            publishDisconnectTimer = setTimeout(function () {
              publishDisconnectTimer = null;
              if (publishPc === pc && !left &&
                  (pc.connectionState === "disconnected" || pc.connectionState === "failed")) {
                onPublishLost();
              }
            }, DISCONNECT_GRACE_MS);
          }
        } else if (state === "connected") {
          // Recovered by itself before the grace window elapsed.
          clearPublishDisconnect();
          if (!publishLost && live) updateDeviceAlert();
        }
      });
    }

    // Watches the return peer connection. Losing it only stops the guest hearing
    // the studio, so it is a hint rather than a blocking warning.
    function watchReturnConnection(pc) {
      if (!pc.addEventListener) return;
      pc.addEventListener("connectionstatechange", function () {
        if (returnPc !== pc || left) return;
        var state = pc.connectionState;
        if (state === "failed") {
          returnLost = true;
          returnHint.textContent = "Lost the return feed from the studio. The studio still sees and hears you.";
          show(returnHint);
        } else if (state === "connected") {
          if (returnLost) {
            returnLost = false;
            returnHint.textContent = "Return feed from the studio.";
          }
        }
      });
    }

    function whipPublish(url, stream) {
      var pc = new RTCPeerConnection(ICE);
      senders = {};
      stream.getTracks().forEach(function (t) { senders[t.kind] = pc.addTrack(t, stream); });
      return pc.createOffer().then(function (offer) {
        return pc.setLocalDescription(offer);
      }).then(function () {
        return waitForIce(pc);
      }).then(function () {
        return fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/sdp", "Authorization": "Bearer " + token },
          body: pc.localDescription.sdp
        });
      }).then(function (res) {
        if (!res.ok) throw new Error("WHIP publish failed: " + res.status);
        publishResource = res.headers.get("Location");
        return res.text();
      }).then(function (answer) {
        return pc.setRemoteDescription({ type: "answer", sdp: answer });
      }).then(function () {
        publishPc = pc;
        watchPublishConnection(pc);
      });
    }

    // Open a recvonly WHEP session and hand its stream to onStream. Resolves
    // with { pc, resource } once the answer is applied.
    function whepPlay(url, withVideo, onStream) {
      var pc = new RTCPeerConnection(ICE);
      var resource = null;
      if (withVideo) pc.addTransceiver("video", { direction: "recvonly" });
      pc.addTransceiver("audio", { direction: "recvonly" });
      pc.addEventListener("track", function (e) {
        if (e.streams && e.streams[0]) onStream(e.streams[0]);
      });
      return pc.createOffer().then(function (offer) {
        return pc.setLocalDescription(offer);
      }).then(function () {
        return waitForIce(pc);
      }).then(function () {
        return fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/sdp", "Authorization": "Bearer " + token },
          body: pc.localDescription.sdp
        });
      }).then(function (res) {
        if (!res.ok) throw new Error("WHEP play failed: " + res.status);
        resource = res.headers.get("Location");
        return res.text();
      }).then(function (answer) {
        return pc.setRemoteDescription({ type: "answer", sdp: answer });
      }).then(function () {
        return { pc: pc, resource: resource };
      }, function (err) {
        try { pc.close(); } catch (e) {}
        throw err;
      });
    }

    function findFeed(feeds, id) {
      for (var i = 0; i < feeds.length; i++) {
        if (feeds[i].id === id && feeds[i].url) return feeds[i];
      }
      return null;
    }

    // Play the picture feed, and the fast feed when there is one.
    function playReturns(feeds, mode) {
      var picture = findFeed(feeds, "picture");
      var fast = findFeed(feeds, "fast");
      fastAvailable = !!fast;
      routeReturnAudio(mode);
      if (picture) {
        whepPlay(picture.url, true, function (stream) { returnVideo.srcObject = stream; }).then(function (s) {
          if (!live) { closeWhep(s.pc, s.resource); return; }
          returnPc = s.pc;
          returnResource = s.resource;
          returnLost = false;
          watchReturnConnection(s.pc);
          show(returnVideo);
          show(returnHint);
        }).catch(function () {
          returnHint.textContent = "Return feed not available yet.";
          show(returnHint);
        });
      }
      if (fast) {
        whepPlay(fast.url, false, function (stream) { returnAudio.srcObject = stream; }).then(function (s) {
          if (!live) { closeWhep(s.pc, s.resource); return; }
          fastPc = s.pc;
          fastResource = s.resource;
        }).catch(function () {
          fastAvailable = false;
          routeReturnAudio(audioMode);
        });
      }
    }

    // Close a WHEP PeerConnection and ask the server to end its session. The
    // DELETE must go out before the guest session's own DELETE, since the
    // invite token stops authorizing return routes once the session is gone.
    function closeWhep(pc, resource) {
      if (pc) { try { pc.close(); } catch (e) {} }
      if (!resource) return Promise.resolve();
      return fetch(new URL(resource, apiBase).toString(), {
        method: "DELETE",
        headers: { "Authorization": "Bearer " + token },
        keepalive: true
      }).catch(function () {});
    }

    // Closes the return feeds and resolves once their DELETEs are answered.
    function closeReturns() {
      var done = Promise.all([
        closeWhep(returnPc, returnResource),
        closeWhep(fastPc, fastResource)
      ]);
      returnPc = returnResource = fastPc = fastResource = null;
      returnVideo.srcObject = null;
      returnAudio.srcObject = null;
      return done;
    }

    // ---- Return mode -------------------------------------------------------
    // Makes what the guest hears match the mode. The server switches what the
    // picture feed's audio carries; in program-minus with a fast feed the guest
    // hears the fast feed instead, which arrives about half a second sooner.
    // The fast feed is always mix-minus, so program, or a fast feed that failed,
    // plays the picture's audio. A muted fast feed stays connected so switching
    // back is instant.
    function routeReturnAudio(mode) {
      audioMode = mode;
      var useFast = mode === "program-minus" && fastAvailable;
      returnVideo.muted = useFast;
      returnAudio.muted = !useFast;
    }

    function applyReturnAudio(mode) {
      returnMode = mode;
      routeReturnAudio(mode);
      Object.keys(modeInputs).forEach(function (k) { modeInputs[k].checked = k === mode; });
      updateSelfWarning();
    }

    function updateSelfWarning() {
      if (returnMode === "program" && !muted) show(selfWarning);
      else hide(selfWarning);
    }

    function returnUrl() {
      return apiBase + "/api/v1/guests/" + encodeURIComponent(inviteId) + "/session/return";
    }

    function setReturnMode(mode) {
      var previous = returnMode;
      var seq = ++modeSeq;
      modePending++;
      applyReturnAudio(mode);
      var abort = new AbortController();
      var timer = setTimeout(function () { abort.abort(); }, MODE_PUT_TIMEOUT_MS);
      fetch(returnUrl(), {
        method: "PUT",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
        body: JSON.stringify({ mode: mode }),
        signal: abort.signal
      }).then(function (res) {
        if (res.status === 401) refused();
        if (!res.ok) throw new Error("mode change failed: " + res.status);
        modeRefusals = 0;
      }).catch(function () {
        // Put back what the server still has, unless a newer change superseded
        // this one or the switch has been taken down. After a timeout the server
        // may have applied it after all; the next poll shows whichever it has.
        if (seq === modeSeq && previous && modePoll) applyReturnAudio(previous);
      }).then(function () {
        clearTimeout(timer);
        modePending--;
      });
    }

    function pollReturnMode() {
      if (modePending > 0) return;
      var seq = modeSeq;
      fetch(returnUrl(), {
        headers: { "Authorization": "Bearer " + token }
      }).then(function (res) {
        if (res.status === 401) { refused(); return null; }
        if (!res.ok) return null;
        modeRefusals = 0;
        return res.json();
      }).then(function (data) {
        if (!live || !modePoll || seq !== modeSeq || modePending > 0) return;
        if (data && modeInputs[data.mode] && data.mode !== returnMode) applyReturnAudio(data.mode);
      }).catch(function () { /* try again next tick */ });
    }

    // Offers the switch when there is a return feed and join lists both
    // picture-feed modes. A low-latency-minus mode (delivered as its own feed)
    // is not a choice here.
    function startReturnMode(joinData) {
      if (!joinData || !(joinData.feeds || []).length) return;
      var modes = joinData.modes || [];
      var offered = {};
      modes.forEach(function (m) {
        if (m && m.delivery && m.delivery.kind === "picture-switch") offered[m.key] = true;
      });
      if (!offered["program"] || !offered["program-minus"]) return;
      applyReturnAudio(joinData.returnMode || joinData.defaultMode || "program-minus");
      show(returnModeBox);
      modePoll = setInterval(pollReturnMode, MODE_POLL_MS);
    }

    function refused() {
      if (++modeRefusals >= MODE_MAX_REFUSALS) stopReturnMode();
    }

    function stopReturnMode() {
      if (modePoll) { clearInterval(modePoll); modePoll = null; }
      // Clearing the mode keeps the warning hidden if the guest toggles mute later.
      returnMode = null;
      hide(returnModeBox);
      hide(selfWarning);
    }

    // ---- Go live -----------------------------------------------------------
    // Joins the session and publishes (and plays the return feed). Shared by the
    // first "Go live" and by "Rejoin" after the connection drops; both reuse the
    // invite's live session via the join route's rejoin branch.
    function connect() {
      var joinData = null;
      return fetch(apiBase + "/api/v1/guests/" + encodeURIComponent(inviteId) + "/join", {
        method: "POST",
        headers: { "Authorization": "Bearer " + token }
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (payload) {
          if (!res.ok) throw { handled: true, message: joinErrorMessage(res.status, payload) };
          return payload;
        });
      }).then(function (data) {
        joinData = data;
        // No whipUrl: the slot is return-only (its source is not WHIP).
        if (!data.whipUrl) {
          closeCamera();
          return null;
        }
        return (localStream ? Promise.resolve() : openCamera()).then(function () {
          return whipPublish(data.whipUrl, localStream);
        });
      }).then(function () {
        live = true;
        publishLost = false;
        clearPublishDisconnect();
        // The pickers stay while live: picking a device swaps it in.
        if (joinData.whipUrl) show(pickers);
        else hide(pickers);
        hide(goLiveBtn);
        hide(rejoinBtn);
        if (joinData.whipUrl) show(muteBtn);
        show(leaveBtn);
        setBanner(joinData.whipUrl
          ? "You are live. The studio can see and hear you."
          : "You are connected. You hear the studio here; your camera reaches it separately.", "live");
        updateDeviceAlert();
        startReturnMode(joinData);
        // Play the return feeds, if any are live yet. Failure here is
        // non-fatal: the guest is still contributing even without a return.
        var feeds = (joinData && joinData.feeds) || [];
        if (feeds.length) {
          playReturns(feeds, (joinData && (joinData.returnMode || joinData.defaultMode)) || "program-minus");
        } else if (!joinData.whipUrl) {
          returnHint.textContent = "Return feed not available yet. Leave and open the link again once the show is running.";
          show(returnHint);
        }
      });
    }

    function goLive() {
      goLiveBtn.disabled = true;
      setBanner("Connecting\\u2026", "");
      connect().catch(function (err) {
        senders = {};
        goLiveBtn.disabled = false;
        setBanner(err && err.handled ? err.message : "Could not go live. Please check your connection and try again.", "error");
      });
    }

    // Tears down the dead connections (keeping the camera/mic) and connects
    // again. Join reuses the invite's live session, so the crew's slot is kept.
    function rejoin() {
      if (left) return;
      rejoinBtn.disabled = true;
      clearPublishDisconnect();
      stopReturnMode();
      if (publishPc) { try { publishPc.close(); } catch (e) {} publishPc = null; }
      closeReturns();
      senders = {};
      publishLost = false;
      returnLost = false;
      setBanner("Reconnecting to the studio\\u2026", "");
      connect().catch(function (err) {
        senders = {};
        publishLost = true;
        show(rejoinBtn);
        rejoinBtn.disabled = false;
        hide(muteBtn);
        setBanner(err && err.handled ? err.message : "Could not reconnect to the studio. Please try again.", "error");
      });
    }

    // ---- Mute --------------------------------------------------------------
    function setMuted(next) {
      muted = next;
      applyMuteToTrack();
      muteBtn.textContent = muted ? "Unmute mic" : "Mute mic";
      muteBtn.className = muted ? "muted" : "";
      if (muted) mutedIndicator.classList.add("show");
      else mutedIndicator.classList.remove("show");
      updateSelfWarning();
      // Report to the backend so the operator sees it (best-effort).
      fetch(apiBase + "/api/v1/guests/" + encodeURIComponent(inviteId) + "/session/mute", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
        body: JSON.stringify({ muted: muted })
      }).catch(function () { /* keep local mute regardless */ });
    }

    // ---- Leave -------------------------------------------------------------
    function teardown() {
      senders = {};
      hide(deviceAlert);
      clearPublishDisconnect();
      stopReturnMode();
      if (publishPc) { try { publishPc.close(); } catch (e) {} publishPc = null; }
      closeReturns();
      if (localStream) { localStream.getTracks().forEach(function (t) { t.stop(); }); }
      // A page restored from the back/forward cache opens the devices afresh.
      localStream = null;
    }

    function leave() {
      leaveBtn.disabled = true;
      live = false;
      left = true;
      closeReturns().then(function () {
        return fetch(apiBase + "/api/v1/guests/" + encodeURIComponent(inviteId) + "/session", {
          method: "DELETE",
          headers: { "Authorization": "Bearer " + token },
          keepalive: true
        });
      }).catch(function () {}).then(function () {
        teardown();
        showLeft();
      });
    }

    function showLeft() {
      hide(muteBtn);
      hide(leaveBtn);
      hide(rejoinBtn);
      hide(pickers);
      mutedIndicator.classList.remove("show");
      setBanner("You have left the broadcast. You can close this page.", "left");
    }

    window.addEventListener("pagehide", function () {
      if (!live) { teardown(); return; }
      // The guest has left, as with Leave, including on a page restored from
      // the back/forward cache.
      live = false;
      left = true;
      // Best-effort teardown on close; keepalive lets the requests outlive the
      // page. The return feeds' DELETEs are queued first (see closeWhep).
      closeReturns();
      try {
        fetch(apiBase + "/api/v1/guests/" + encodeURIComponent(inviteId) + "/session", {
          method: "DELETE",
          headers: { "Authorization": "Bearer " + token },
          keepalive: true
        });
      } catch (e) {}
      teardown();
      showLeft();
    });

    // ---- Wire up -----------------------------------------------------------
    goLiveBtn.addEventListener("click", goLive);
    rejoinBtn.addEventListener("click", rejoin);
    muteBtn.addEventListener("click", function () { setMuted(!muted); });
    leaveBtn.addEventListener("click", leave);
    Object.keys(modeInputs).forEach(function (k) {
      modeInputs[k].addEventListener("change", function () {
        if (modeInputs[k].checked && k !== returnMode) setReturnMode(k);
      });
    });
    camSel.addEventListener("change", function () { onPickerChange("video"); });
    micSel.addEventListener("change", function () { onPickerChange("audio"); });
    deviceRetryBtn.addEventListener("click", reconnectDevices);
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      // Show a newly plugged-in device without a reload.
      navigator.mediaDevices.addEventListener("devicechange", function () {
        if (localStream && !left) fillDevicePickers().catch(function () {});
      });
    }

    // ---- Boot --------------------------------------------------------------
    if (!token) {
      goLiveBtn.disabled = true;
      setBanner("This link is missing its access token. Ask the producer for the full invite link.", "error");
    } else if (!window.RTCPeerConnection) {
      goLiveBtn.disabled = true;
      setBanner("This browser does not support live calling. Try a recent Chrome, Safari or Firefox.", "error");
    } else {
      // Ask the server what the slot takes before touching any device. Only a
      // clear "return-only" answer changes anything: any other result (a dead
      // link, no network, server trouble) goes the usual camera way, and join
      // reports what is wrong.
      goLiveBtn.disabled = true;
      fetch(apiBase + "/api/v1/guests/" + encodeURIComponent(inviteId) + "/slot", {
        headers: { "Authorization": "Bearer " + token }
      }).then(function (res) {
        return res.ok ? res.json() : {};
      }).catch(function () {
        return {};
      }).then(function (slot) {
        if (slot && slot.returnOnly) {
          hide(preview);
          hide(previewHint);
          hide(pickers);
          goLiveBtn.textContent = "Join";
          goLiveBtn.disabled = false;
          setBanner("Press \\u201cJoin\\u201d to hear the studio. Your camera is connected separately by the producer.", "");
          return;
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          setBanner("This browser does not support live calling. Try a recent Chrome, Safari or Firefox.", "error");
          return;
        }
        return startPreview().then(function () {
          goLiveBtn.disabled = false;
          setBanner("Camera and microphone ready. Press \\u201cGo live\\u201d when you're set.", "");
        }, function () {
          setBanner("Could not access your camera or microphone. Check the browser permissions and reload.", "error");
        });
      });
    }
  })();
  </script>
</body>
</html>
`;

const guestPageRoutes: FastifyPluginAsync = async (fastify) => {
  // Serve the guest page for any invite id. The page itself holds no secret and
  // does not need the invite to exist to render — the token (from the URL
  // fragment, never sent here) drives the actual join, which returns the real
  // authorization result. Serving unconditionally keeps the token out of any
  // server-side lookup and lets the page render its own readable error states.
  fastify.get<{ Params: { inviteId: string } }>('/guest/:inviteId', async (_req, reply) => {
    reply
      .header('Content-Security-Policy', GUEST_PAGE_CSP)
      .header('Cache-Control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(GUEST_PAGE_HTML);
  });
};

export default guestPageRoutes;
