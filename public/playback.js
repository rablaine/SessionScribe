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
  async function load(player, jobId, onStatus, repair = false) {
    if (repair && !confirm("Fix timestamp/clip timing for this session? This prepares a playback-only copy and can take several minutes. It uses about 86 MB per audio hour until the recording expires. Originals, exports, and saved clip ranges stay unchanged.")) return null;
    clear(player);
    const controller = new AbortController();
    loads.set(player, controller);
    player.pause();
    player.removeAttribute("src");
    player.load();
    const endpoint = `/api/jobs/${jobId}/playback`;
    const started = Date.now();
    let method = repair ? "POST" : "GET";
    try {
      for (;;) {
        const result = await window.SessionScribeAuth.request(endpoint, { signal: controller.signal, method });
        method = "GET";
        controller.signal.throwIfAborted();
        if (result?.status === "ready") {
          if (![ `/api/jobs/${jobId}/audio`, `/api/jobs/${jobId}/audio?playback=2` ].includes(result.url)) {
            throw new Error("The server returned an invalid playback URL.");
          }
          player.src = result.url;
          player.load();
          if (repair) window.dispatchEvent(new CustomEvent("scribe-playback-repaired", { detail: { jobId, player } }));
          return result;
        }
        if (result?.status !== "generating") throw new Error("The server returned an invalid playback status.");
        if (Date.now() - started > 31 * 60_000) throw new Error("Playback preparation took too long. Try again.");
        onStatus("Preparing accurate playback for this recording. Long recordings can take several minutes...");
        await wait(controller.signal);
      }
    } finally {
      if (loads.get(player) === controller) loads.delete(player);
    }
  }
  window.SessionScribePlayback = Object.freeze({ load, clear });
})();
