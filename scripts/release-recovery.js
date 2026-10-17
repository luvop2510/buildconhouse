/* Run before Expo: recover a failed, empty startup without touching live UI. */
(function () {
  'use strict';
  // Capture business deep links before Expo initializes and can normalize an
  // unmounted admin Slot to /access. Keep this tab's pending destination across
  // a reload in that short initialization window; the mounted shell clears it.
  try {
    var initialURL = new URL(location.href);
    var initialPath = initialURL.pathname;
    var pendingRouteKey = 'forge.pending-initial-route';
    var validAdminRoute = /^\/(?:access|dashboard|catalog|customers|quotations|purchases|purchases-completed|purchase-orders|payments|payments-list|walkins|followups|notebook|tiles|godown-stock|sales-data|team|notifications|reports|settings(?:-[a-z-]+)?)(?:\/|\?|$)/;
    var pendingRoute = sessionStorage.getItem(pendingRouteKey);
    if (initialPath === '/access' && pendingRoute && validAdminRoute.test(pendingRoute)) window.__FORGE_INITIAL_ROUTE__ = pendingRoute;
    else if (validAdminRoute.test(initialPath)) {
      window.__FORGE_INITIAL_ROUTE__ = initialPath + initialURL.search;
      if (initialPath !== '/access') sessionStorage.setItem(pendingRouteKey, window.__FORGE_INITIAL_ROUTE__);
    } else sessionStorage.removeItem(pendingRouteKey);
  } catch (_) { /* Storage restrictions do not prevent the app from starting. */ }
  var handled = false;
  var pending = false;
  var queued = false;
  var assetPrefix = '/_expo/static/js/web/';
  var initialRoot = document.getElementById('root');
  var initialHTML = initialRoot ? initialRoot.innerHTML : null;
  var interactive = 'button,input,textarea,select,a,summary,iframe,canvas,video,audio,[role="button"],[role="link"],[contenteditable="true"],[tabindex]';

  function sameOriginAsset(value) {
    try {
      var url = new URL(value, location.href);
      return url.origin === location.origin && url.pathname.indexOf(assetPrefix) === 0 && /\.js$/.test(url.pathname);
    } catch (_) { return false; }
  }

  function emptyApp() {
    var root = document.getElementById('root');
    if (!root || (root.childElementCount === 0 && !String(root.textContent || '').trim())) return true;
    // Expo exports an inert SSR splash before hydration. Only its untouched,
    // noninteractive snapshot is safe to treat as an unfinished startup.
    return root.innerHTML === initialHTML && !root.querySelector(interactive);
  }

  function fingerprint() {
    var scripts = document.querySelectorAll('script[src]');
    for (var index = 0; index < scripts.length; index += 1) {
      var src = scripts[index].src;
      if (sameOriginAsset(src) && /\/entry-[^/]+\.js(?:\?|$)/.test(src)) return new URL(src, location.href).pathname;
    }
    return null;
  }

  function manualReload() {
    if (!emptyApp() || document.getElementById('release-startup-recovery')) return;
    var panel = document.createElement('section');
    panel.id = 'release-startup-recovery';
    panel.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;justify-content:center;align-items:flex-start;padding:24px;box-sizing:border-box;background:#fff;color:#15202b;font:16px/1.5 system-ui,sans-serif;overflow:auto';
    panel.setAttribute('role', 'alert');
    panel.setAttribute('aria-labelledby', 'release-startup-recovery-title');
    var title = document.createElement('h1');
    title.id = 'release-startup-recovery-title';
    title.textContent = 'The app could not start';
    var explanation = document.createElement('p');
    explanation.textContent = 'Reload to download the latest app files.';
    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Reload app';
    button.style.cssText = 'min-height:44px;padding:12px 20px;margin-top:8px;border:1px solid #15202b;border-radius:6px;background:#15202b;color:#fff;font:inherit;cursor:pointer';
    button.addEventListener('click', function () { location.reload(); });
    panel.appendChild(title);
    panel.appendChild(explanation);
    panel.appendChild(button);
    document.body.appendChild(panel);
    button.focus();
    // A delayed successful startup can supersede the fallback without a reload.
    if (typeof MutationObserver === 'function') {
      var observer = new MutationObserver(function () {
        if (!emptyApp()) { panel.remove(); observer.disconnect(); }
      });
      observer.observe(document.getElementById('root') || document.body, { childList: true, subtree: true });
    }
  }

  function recover() {
    queued = false;
    if (handled || !pending || !emptyApp()) return;
    handled = true;
    var entry = fingerprint();
    // Missing fingerprint or unavailable storage cannot safely enforce a retry
    // limit across navigation. Give control to the user instead.
    if (!entry) { manualReload(); return; }
    var key = 'forge.startup-recovery:' + location.pathname + ':' + entry;
    try {
      if (sessionStorage.getItem(key)) { manualReload(); return; }
      sessionStorage.setItem(key, 'attempted');
    } catch (_) { manualReload(); return; }
    location.reload();
  }

  function requestRecovery() {
    if (handled || !emptyApp()) return;
    pending = true;
    if (document.readyState === 'loading') return;
    if (!queued) { queued = true; setTimeout(recover, 0); }
  }

  function ownStartupError(message, filename, stack, allowParseError) {
    // A generic JSON/API parse rejection is not proof of a failed script.
    // Parse syntax is eligible only for a global script error with its own
    // asset filename. Async failures need the specific Metro/chunk signature.
    var chunkFailure = /Requiring unknown module\s+["']?\d+/.test(message) || /(?:Loading (?:chunk|module) .+ failed|ChunkLoadError)/.test(message);
    var parseFailure = allowParseError && /Unexpected token ['"]?</.test(message) && sameOriginAsset(filename);
    var ownStack = (String(stack || '').match(/https?:\/\/[^\s)]+/g) || []).some(function (part) { return sameOriginAsset(part.replace(/:\d+(?::\d+)?$/, '')); });
    return parseFailure || (chunkFailure && (sameOriginAsset(filename) || ownStack));
  }

  // React catches lazy-import rejections before global error listeners see
  // them. A mounted page boundary can offer an explicit reload for a stale
  // release without automatically discarding a live form or touching auth.
  window.__FORGE_IS_RELEASE_ERROR__ = function (error) {
    if (!error || typeof error !== 'object') return false;
    return ownStartupError(String(error.message || ''), error.request, error.stack, false);
  };

  window.addEventListener('error', function (event) {
    var target = event.target;
    // Resource errors carry the actual failed script element, including strict
    // MIME rejections. Fonts/images, API requests and third-party scripts cannot
    // enter this path.
    if (target && target.tagName === 'SCRIPT' && sameOriginAsset(target.src)) {
      requestRecovery();
      return;
    }
    var error = event.error || {};
    if (ownStartupError(event.message || error.message || '', event.filename || error.request, error.stack, true)) requestRecovery();
  }, true);

  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason || {};
    if (ownStartupError(reason.message || '', reason.request, reason.stack, false)) requestRecovery();
  });

  document.addEventListener('DOMContentLoaded', function () {
    if (pending && !queued) { queued = true; setTimeout(recover, 0); }
  }, { once: true });

  // A deferred script can stall without emitting an error or DOMContentLoaded.
  // Offer control after a bounded wait, but never reload automatically or
  // cover a mounted page. A late successful mount removes this panel.
  setTimeout(manualReload, 20000);
}());
