// Dash0 Web SDK script-tag initializer (from the SDK's setup docs): queue calls until dash0.iife.js loads.
(function (d, a, s, h, z, e, r, o) {
  d[a] ||
    ((z = d[a] =
      function () {
        h.push(arguments);
      }),
    (z._t = new Date()),
    (z._v = 1),
    (h = z._q = []));
})(window, "dash0");

// Same-origin requests (everything under /api) get a traceparent header automatically, so no
// `propagators` setting is needed. Session replay is enabled by loading dash0-session-recording.iife.js;
// maskAllInputs: true is the default and is spelled out here for clarity.
dash0("init", Object.assign({}, window.DASH0_CONFIG, {
  sessionRecording: { maskAllInputs: true },
}));

if (String(window.DASH0_CONFIG && window.DASH0_CONFIG.endpoint.authToken).indexOf("REPLACE") === 0) {
  console.warn("shop-web: Dash0 auth token is still the placeholder; telemetry will be rejected. See README.");
}
