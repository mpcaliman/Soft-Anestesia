/* ============================================================================
   Soft Anestesia — Service Worker
   Estratégia NETWORK-FIRST: online, o app SEMPRE vem da rede (nunca fica
   preso numa versão antiga); cada resposta boa é guardada no cache e usada
   como fallback quando a rede falha (wifi de hospital, avião, elevador).
   Só intercepta GET do próprio domínio — Supabase e afins passam direto.
============================================================================ */
const CACHE = 'soft-anestesia-v1';

self.addEventListener('install', () => { self.skipWaiting(); });

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(req)
      .then(resp => {
        if (resp && resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE).then(c => c.put(req, clone)).catch(() => {});
        }
        return resp;
      })
      .catch(() =>
        caches.match(req, { ignoreSearch: true }).then(hit => {
          if (hit) return hit;
          /* navegação offline sem match exato → serve o app cacheado */
          if (req.mode === 'navigate') {
            return caches.match('index.html', { ignoreSearch: true })
              .then(h => h || caches.match('./', { ignoreSearch: true }));
          }
          return undefined;
        })
      )
  );
});
