/* eslint-disable */
// Mio Android avatar bridge — JS half (M-2.2).
//
// `desktop/src/renderer/avatar/main.ts` calls `window.avatarApi.*` to
// fetch the asset manifest, ship gestures upstream, and receive
// talking-state pushes. On the desktop the Electron preload script
// wires this; on Android there's no preload, so this shim does the
// wiring against the AndroidX `WebMessageListener` installed by
// `MioAvatarBridge.kt` as `window.MioAvatarBridge`.
//
// Frames JS → Kotlin (carried by `MioAvatarBridge.postMessage(str)`):
//   { kind: "rpc",  id: <int>, method: <string>, args: <any?> }   request-response
//   { kind: "fire", method: <string>, args: <any?> }              fire-and-forget
//
// Frames Kotlin → JS (via `WebView.evaluateJavascript`):
//   window.__mioAvatarRpcReply(id, ok, payload?)                  RPC reply
//   window.__mioAvatarPush("setTalking", { mood })                Push
//     also: "setIdle", "setGesturePrefs", "setOutfit"
//
// The shim runs *before* the bundled `main.ts` (the gradle copy task
// emits `<script src="./__mioAvatarBridge.js">` ahead of the bundle),
// so by the time `main.ts` reads `window.avatarApi` the surface is
// already there.

(function () {
  if (typeof window === 'undefined') return;
  if (window.avatarApi) return; // some other host already wired the API

  // Surface a platform marker before main.ts runs. The bundled scene's
  // mobile-only branches (Alt-drag removal, touch caress dwell, swipe-up
  // for history) gate on this value rather than on a build-time define
  // so we don't have to fork the desktop bundle.
  window.__MIO_PLATFORM__ = 'mobile';

  const noopUnsubscribe = function () {};

  const bridgePresent = !!(window.MioAvatarBridge && typeof window.MioAvatarBridge.postMessage === 'function');

  if (!bridgePresent) {
    // No host bridge — boot the scene with stubs so the page at least
    // renders the canvas placeholder. Useful when index.html is opened
    // in plain Chrome for debugging.
    console.warn('[avatarApi] MioAvatarBridge not present; using fallback stubs');
    window.avatarApi = {
      requestAssets: async function () {
        return {
          vrmPath: null,
          idleAnimations: [],
          talkingAnimations: [],
          extrasAnimations: [],
          outfits: [],
        };
      },
      onSetTalking: function () { return noopUnsubscribe; },
      onSetIdle: function () { return noopUnsubscribe; },
      onSetGesturePrefs: function () { return noopUnsubscribe; },
      onSetOutfit: function () { return noopUnsubscribe; },
      getGesturePrefs: async function () {
        return { gesturesEnabled: true };
      },
      sendGesture: function () { /* noop */ },
      moveWindowBy: function () { /* noop on android */ },
      openHistory: function () { /* noop in fallback */ },
      hapticTick: function () { /* noop in fallback */ },
    };
    return;
  }

  // ─── RPC plumbing ───────────────────────────────────────────────────

  let nextRpcId = 1;
  const pending = new Map();

  function rpc(method, args) {
    return new Promise(function (resolve, reject) {
      const id = nextRpcId++;
      pending.set(id, { resolve: resolve, reject: reject });
      try {
        window.MioAvatarBridge.postMessage(JSON.stringify({
          kind: 'rpc', id: id, method: method, args: args === undefined ? null : args,
        }));
      } catch (err) {
        pending.delete(id);
        reject(err);
      }
    });
  }

  function fire(method, args) {
    try {
      window.MioAvatarBridge.postMessage(JSON.stringify({
        kind: 'fire', method: method, args: args === undefined ? null : args,
      }));
    } catch (err) {
      console.warn('[avatarApi] fire failed', method, err);
    }
  }

  // Reply landing pad called by Kotlin via evaluateJavascript.
  window.__mioAvatarRpcReply = function (id, ok, payload) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (ok) p.resolve(payload);
    else p.reject(new Error((payload && payload.message) || 'rpc failed'));
  };

  // ─── Push subscribers ──────────────────────────────────────────────

  function listenerSet() {
    const set = [];
    return {
      add: function (h) {
        set.push(h);
        return function () {
          const i = set.indexOf(h);
          if (i >= 0) set.splice(i, 1);
        };
      },
      emit: function (payload) {
        for (let i = 0; i < set.length; i++) {
          try { set[i](payload); } catch (err) { console.error('[avatarApi] listener threw', err); }
        }
      },
    };
  }

  const talking = listenerSet();
  const idle = listenerSet();
  const prefs = listenerSet();
  const outfit = listenerSet();

  window.__mioAvatarPush = function (event, payload) {
    if (event === 'setTalking') talking.emit(payload || {});
    else if (event === 'setIdle') idle.emit();
    else if (event === 'setGesturePrefs') prefs.emit(payload || { gesturesEnabled: false });
    else if (event === 'setOutfit') {
      // Wardrobe path: the APK ships every VRM from `assets/avatar/vrm/*`
      // and the foreground service substitutes the desktop's
      // `http://<host>/...` URL with the bundled `https://appassets…`
      // copy of the matching outfit id before calling
      // `MioAvatarBridge.setOutfit` (avoids mixed-content blocks).
      outfit.emit(payload || {});
    }
  };

  // ─── Public surface (matches desktop `AvatarApi`) ──────────────────

  window.avatarApi = {
    requestAssets: function () { return rpc('requestAssets'); },
    getGesturePrefs: function () { return rpc('getGesturePrefs'); },
    sendGesture: function (event) { fire('sendGesture', event); },
    moveWindowBy: function () { /* full-screen surface: nothing to move */ },
    onSetTalking: function (handler) { return talking.add(handler); },
    onSetIdle: function (handler) { return idle.add(handler); },
    onSetGesturePrefs: function (handler) { return prefs.add(handler); },
    onSetOutfit: function (handler) { return outfit.add(handler); },
    // M-2.5: swipe-up on the canvas asks the native host to open the
    // chat-history overlay. main.ts's gesture controller fires this
    // when a swipe-up gesture is detected off-body.
    openHistory: function () { fire('openHistory'); },
    // M-2.8: gesture controller fires this on every emitted verb so
    // the native host can pulse the vibrator. The host owns the
    // user's haptics on/off pref; we just forward the verb so the
    // host can pick a per-verb pattern (a soft caress vs. a sharp
    // poke). Fire-and-forget.
    hapticTick: function (kind) { fire('hapticTick', { kind: kind }); },
  };
})();
