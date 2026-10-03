(() => {
  "use strict";
  // "Even out voices": a compressor plus make-up gain between an <audio> element and the speakers, so a quiet
  // speaker comes up toward the level of louder ones. Playback only; clip exports use the server's FFmpeg filter.
  const KEY = "scribe-even-voices";
  let enabled = true;
  try { enabled = localStorage.getItem(KEY) !== "off"; } catch {}
  let context = null;
  const chains = new Map();
  const listeners = new Set();

  function wire(chain) {
    chain.source.disconnect();
    chain.source.connect(enabled ? chain.input : context.destination);
  }

  // Routing an element through Web Audio is one-way, so it only happens on first playback with the setting on.
  function ensure(element) {
    if (chains.has(element)) return;
    try {
      context ??= new AudioContext();
      const source = context.createMediaElementSource(element);
      const compressor = context.createDynamicsCompressor();
      compressor.threshold.value = -40;
      compressor.knee.value = 12;
      compressor.ratio.value = 6;
      compressor.attack.value = 0.005;
      compressor.release.value = 0.3;
      const gain = context.createGain();
      gain.gain.value = 5;
      compressor.connect(gain).connect(context.destination);
      const chain = { source, input: compressor };
      chains.set(element, chain);
      wire(chain);
    } catch (error) {
      console.warn("Even out voices is unavailable in this browser:", error);
    }
  }

  function attach(element) {
    element.addEventListener("play", () => {
      if (!enabled && !chains.has(element)) return;
      ensure(element);
      void context?.resume();
    });
  }

  function setEnabled(value) {
    enabled = Boolean(value);
    try { localStorage.setItem(KEY, enabled ? "on" : "off"); } catch {}
    for (const chain of chains.values()) wire(chain);
    if (enabled) {
      for (const element of document.querySelectorAll("audio")) if (!element.paused) ensure(element);
      void context?.resume();
    }
    for (const listener of listeners) listener(enabled);
  }

  // Keeps toggle buttons (aria-pressed) in sync wherever they appear.
  function bindToggle(button) {
    const sync = () => {
      button.setAttribute("aria-pressed", String(enabled));
      button.classList.toggle("on", enabled);
    };
    button.addEventListener("click", () => setEnabled(!enabled));
    listeners.add(sync);
    sync();
  }

  window.SessionScribeAudio = Object.freeze({
    attach, bindToggle, setEnabled,
    get enabled() { return enabled; },
    onChange(listener) { listeners.add(listener); },
  });
})();
