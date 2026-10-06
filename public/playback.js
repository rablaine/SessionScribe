(() => {
  "use strict";
  const loads = new WeakMap();
  function clear(player) {
    loads.get(player)?.abort();
    loads.delete(player);
  }
  function wait(signal) {
    return new Promise((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, 3000);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  async function load(player, jobId, onStatus) {
    clear(player);
    const controller = new AbortController();
    loads.set(player, controller);
    player.pause();
    player.removeAttribute("src");
    player.load();
    const endpoint = `/api/jobs/${jobId}/playback`;
    const started = Date.now();
    try {
      for (;;) {
        const result = await window.SessionScribeAuth.request(endpoint, { signal: controller.signal });
        controller.signal.throwIfAborted();
        if (result?.status === "ready") {
          if (![ `/api/jobs/${jobId}/audio`, `/api/jobs/${jobId}/audio?indexed=1` ].includes(result.url)) {
            throw new Error("The server returned an invalid playback URL.");
          }
          player.src = result.url;
          player.load();
          return;
        }
        if (result?.status !== "generating") throw new Error("The server returned an invalid playback status.");
        if (Date.now() - started > 11 * 60_000) throw new Error("Playback preparation took too long. Try again.");
        onStatus("Preparing an accurate seek index for this recording...");
        await wait(controller.signal);
      }
    } finally {
      if (loads.get(player) === controller) loads.delete(player);
    }
  }
  window.SessionScribePlayback = Object.freeze({ load, clear });
})();
