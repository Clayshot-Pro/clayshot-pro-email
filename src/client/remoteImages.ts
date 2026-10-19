import { useEffect, useState } from "react";

/**
 * Remote images in mail (v3.19): "show" loads them through the app's private
 * image proxy; "ask" keeps them hidden until "Show images" in the reader.
 * A per-device choice, like the other reading preferences.
 */
type RemoteImagesMode = "show" | "ask";
const KEY = "ltm.remoteImages";
const EVENT = "ltm-remote-images";

function remoteImagesMode(): RemoteImagesMode {
  try {
    return localStorage.getItem(KEY) === "ask" ? "ask" : "show";
  } catch {
    return "show";
  }
}

export function setRemoteImagesMode(mode: RemoteImagesMode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // Private mode: the choice lasts for this page only.
  }
  window.dispatchEvent(new Event(EVENT));
}

export function useRemoteImagesMode(): RemoteImagesMode {
  const [mode, setMode] = useState(remoteImagesMode);
  useEffect(() => {
    const update = () => setMode(remoteImagesMode());
    window.addEventListener(EVENT, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(EVENT, update);
      window.removeEventListener("storage", update);
    };
  }, []);
  return mode;
}
