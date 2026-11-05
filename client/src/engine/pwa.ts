/**
 * Offline support: registers the service worker (src/sw/sw.ts, built to
 * /sw.js by vite.config.ts) in production builds. The vite dev server has
 * no /sw.js: nothing is registered there.
 *
 * Browsers only allow service workers in secure contexts: HTTPS, or
 * http://localhost / 127.0.0.1. A plain-HTTP LAN address gets no offline
 * support (the game still runs).
 */

let registration: Promise<ServiceWorkerRegistration | null> | null = null;

export function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  registration ??= (async () => {
    if (import.meta.env.DEV || !("serviceWorker" in navigator) || !window.isSecureContext) return null;
    try {
      return await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    } catch (e) {
      console.warn("service worker registration failed", e);
      return null;
    }
  })();
  return registration;
}

/** A one-line description of the offline support, for the landing page. */
export async function offlineStatus(): Promise<string> {
  if (import.meta.env.DEV) return "not with the development server (use a build: pnpm start)";
  if (!("serviceWorker" in navigator)) return "not supported by this browser";
  if (!window.isSecureContext) return "unavailable: the site must be opened over HTTPS (or on localhost)";
  const reg = await registerServiceWorker();
  if (!reg) return "unavailable (the service worker could not be installed)";
  if (reg.active) return "ready: the game starts without a network connection once it has been played here";
  return "being prepared…";
}
