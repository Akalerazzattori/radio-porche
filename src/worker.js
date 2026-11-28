// Radio Porche · Worker principal
// Sirve la web estática (con cabeceras de seguridad), la API (Hub) y los WebSockets (Room).
import { Hub } from './hub.js';
import { Room } from './room.js';
import { Locker } from './locker.js';
import { APP } from '../public/js/config.js';

export { Hub, Room, Locker };

const TURNSTILE = 'https://challenges.cloudflare.com';

/** Identidad del token: deviceId, null si no vale, undefined si no se ha podido comprobar. */
async function whoami(env, req) {
  const h = req.headers.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return null;
  try {
    const r = await env.HUB.get(env.HUB.idFromName('main')).fetch('https://hub/internal/whoami', { method: 'POST', body: JSON.stringify({ token }) });
    return (await r.json()).deviceId || null;
  } catch { return undefined; }
}

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "connect-src 'self' wss: " + TURNSTILE,
    "media-src 'self' blob:",
    "img-src 'self' data: blob:",
    "script-src 'self' " + TURNSTILE,
    "style-src 'self'",
    "font-src 'self'",
    "worker-src 'self' blob:",
    'frame-src ' + TURNSTILE,
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "manifest-src 'self'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Permissions-Policy': 'microphone=(self), camera=(self), geolocation=(), display-capture=(self)',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

function withHeaders(res, extra = {}) {
  if (res.status === 101) return res;
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) r.headers.set(k, v);
  for (const [k, v] of Object.entries(extra)) r.headers.set(k, v);
  return r;
}

const hub = (env) => env.HUB.get(env.HUB.idFromName('main'));

function escAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Inyecta metadatos para buscadores y redes sociales en las páginas compartibles. */
async function seoPage(req, env, url, meta) {
  const res = await env.ASSETS.fetch(new Request(new URL('/', url), { headers: { accept: 'text/html' } }));
  const origin = url.origin;
  const title = meta.title ? `${meta.title} · ${APP.name}` : APP.name;
  const desc = (meta.description || APP.description).slice(0, 200);
  const image = meta.image ? origin + meta.image : origin + '/img/og.jpg';
  const canonical = origin + url.pathname;
  const set = (attr) => ({ element(el) { el.setAttribute('content', attr); } });
  return new HTMLRewriter()
    .on('title', { element(el) { el.setInnerContent(title); } })
    .on('meta[name="description"]', set(desc))
    .on('meta[property="og:title"]', set(title))
    .on('meta[property="og:description"]', set(desc))
    .on('meta[property="og:image"]', set(image))
    .on('meta[property="og:url"]', set(canonical))
    .on('meta[property="og:type"]', set(meta.type || 'website'))
    .on('meta[name="twitter:title"]', set(title))
    .on('meta[name="twitter:description"]', set(desc))
    .on('meta[name="twitter:image"]', set(image))
    .on('link[rel="canonical"]', { element(el) { el.setAttribute('href', canonical); } })
    .on('script#ld', {
      element(el) {
        if (meta.ld) el.setInnerContent(JSON.stringify(meta.ld).replace(/</g, '\\u003c'), { html: false });
      },
    })
    .transform(res);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    const ip = req.headers.get('CF-Connecting-IP') || '0.0.0.0';

    // ---------- WebSocket de sala
    const ws = /^\/api\/room\/([A-Za-z0-9_-]{4,40})\/ws$/.exec(path);
    if (ws) {
      if (req.headers.get('upgrade') !== 'websocket') return withHeaders(new Response('Se esperaba WebSocket', { status: 426 }));
      const origin = req.headers.get('origin');
      if (origin && new URL(origin).host !== url.host) return withHeaders(new Response('Origen no permitido', { status: 403 }));
      const a = await hub(env).fetch('https://hub/internal/auth', {
        method: 'POST',
        body: JSON.stringify({ porchId: ws[1], token: url.searchParams.get('t') || '', mod: url.searchParams.get('m') || '' }),
      });
      const auth = await a.json();
      auth.ip = ip;
      auth.invite = url.searchParams.get('i') || '';
      auth.tab = (url.searchParams.get('c') || '').replace(/[^A-Za-z0-9_-]/g, '');
      auth.kind = url.searchParams.get('d') === 'ordenador' ? 'ordenador' : 'móvil';
      const room = env.ROOM.get(env.ROOM.idFromName(ws[1]));
      const fwd = new Request(req.url, { headers: { upgrade: 'websocket', 'x-rp-auth': JSON.stringify(auth) } });
      return room.fetch(fwd);
    }

    // ---------- Versión desplegada (la app se recarga sola si cambia)
    if (path === '/api/version') {
      return withHeaders(new Response(JSON.stringify({ v: env.CF_VERSION_METADATA?.id || 'dev' }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }));
    }

    // ---------- API
    if (path.startsWith('/api/')) {
      // CSRF: las escrituras deben venir de este mismo origen
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const origin = req.headers.get('origin');
        if (origin && new URL(origin).host !== url.host) return withHeaders(new Response('Origen no permitido', { status: 403 }));
      }
      const headers = new Headers(req.headers);
      headers.set('x-rp-ip', ip);
      headers.delete('cookie');

      // Tu espacio (grabaciones y sonidos en tu cuenta): un Durable Object por identidad
      if (path === '/api/cloud' || path.startsWith('/api/cloud/')) {
        const dev = await whoami(env, req);
        if (dev === undefined) return withHeaders(new Response(JSON.stringify({ error: 'Inténtalo de nuevo en un momento' }), { status: 503, headers: { 'content-type': 'application/json' } }));
        if (!dev) return withHeaders(new Response(JSON.stringify({ error: 'Entra con tu nombre para usar tu espacio' }), { status: 401, headers: { 'content-type': 'application/json' } }));
        if (path === '/api/cloud/wipe') return withHeaders(new Response('No', { status: 403 }));
        const lk = env.LOCKER.get(env.LOCKER.idFromName(dev));
        return withHeaders(await lk.fetch(new Request(new URL(path + url.search, 'https://locker'), { method: req.method, headers, body: req.body })));
      }

      // Borrar mi identidad: también se vacía su espacio
      const wipeDev = path === '/api/me/delete' && req.method === 'POST' ? await whoami(env, req) : null;

      const fwd = new Request(new URL(path + url.search, 'https://hub'), { method: req.method, headers, body: req.body });
      const res = await hub(env).fetch(fwd);
      if (wipeDev && res.ok) {
        try { await env.LOCKER.get(env.LOCKER.idFromName(wipeDev)).fetch('https://locker/api/cloud/wipe', { method: 'POST' }); } catch {}
      }
      return withHeaders(res);
    }

    // ---------- SEO: sitemap
    if (path === '/sitemap.xml') {
      const d = await (await hub(env).fetch('https://hub/internal/sitemap')).json();
      const o = url.origin;
      const urls = [
        `<url><loc>${o}/</loc><changefreq>hourly</changefreq><priority>1.0</priority></url>`,
        `<url><loc>${o}/podcasts</loc><changefreq>daily</changefreq><priority>0.8</priority></url>`,
        ...['aviso-legal', 'privacidad', 'condiciones', 'normas'].map((s) => `<url><loc>${o}/legal/${s}</loc><priority>0.2</priority></url>`),
        ...(d.programs || []).map((p) => `<url><loc>${o}/programa/${escAttr(p.id)}</loc><changefreq>weekly</changefreq><priority>0.7</priority></url>`),
        ...d.porches.map((p) => `<url><loc>${o}/porche/${escAttr(p.slug)}</loc><changefreq>daily</changefreq><priority>0.7</priority></url>`),
        ...d.podcasts.map((p) => `<url><loc>${o}/p/${escAttr(p.id)}</loc><lastmod>${new Date(p.created).toISOString().slice(0, 10)}</lastmod><priority>0.6</priority></url>`),
      ];
      return withHeaders(new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`, {
        headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' },
      }));
    }
    if (path === '/robots.txt') {
      return withHeaders(new Response(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /admin\n\nSitemap: ${url.origin}/sitemap.xml\n`, {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }));
    }

    // ---------- SEO: páginas compartibles
    let m;
    if ((m = /^\/p\/([A-Za-z0-9_-]{4,40})$/.exec(path))) {
      const d = await (await hub(env).fetch(`https://hub/internal/meta?p=${m[1]}`)).json();
      const p = d.podcast;
      if (p) {
        return withHeaders(await seoPage(req, env, url, {
          title: p.title, type: 'music.song',
          description: `${p.porchName} · ${Math.round(p.duration / 60)} min. ${p.description || 'Escúchalo en Radio Porche.'}`,
          image: p.hasCover ? `/api/podcasts/${p.id}/cover` : `/img/scenes/escena-${p.scene || 1}.jpg`,
          ld: {
            '@context': 'https://schema.org', '@type': 'PodcastEpisode', name: p.title, description: p.description || p.title,
            datePublished: new Date(p.created).toISOString(), timeRequired: `PT${Math.round(p.duration / 60)}M`,
            associatedMedia: { '@type': 'MediaObject', contentUrl: `${url.origin}/api/podcasts/${p.id}/audio` },
            partOfSeries: { '@type': 'PodcastSeries', name: p.porchName, url: `${url.origin}/porche/${p.porchSlug}` },
          },
        }));
      }
    }
    if ((m = /^\/programa\/([A-Za-z0-9_-]{4,40})$/.exec(path))) {
      const d = await (await hub(env).fetch(`https://hub/internal/meta?program=${m[1]}`)).json();
      const p = d.program;
      if (p) {
        return withHeaders(await seoPage(req, env, url, {
          title: `${p.name} · ${p.porchName}`, description: p.description || `Podcast de ${p.porchName} en Radio Porche. ${p.episodes} episodios.`,
          image: p.hasCover ? `/api/program/${p.id}/cover` : `/img/scenes/escena-${p.scene || 1}.jpg`,
          ld: { '@context': 'https://schema.org', '@type': 'PodcastSeries', name: p.name, description: p.description || p.name, url: `${url.origin}/programa/${p.id}` },
        }));
      }
    }
    if ((m = /^\/porche\/([A-Za-z0-9_-]{2,60})$/.exec(path))) {
      const d = await (await hub(env).fetch(`https://hub/internal/meta?porch=${m[1]}`)).json();
      const p = d.porch;
      if (p) {
        return withHeaders(await seoPage(req, env, url, {
          title: `${p.freq.toFixed(1)} · ${p.name}`,
          description: p.live ? `En directo ahora: ${p.liveTitle || p.name}. Entra a escuchar y comenta.` : (p.description || `Radio de barrio de ${p.ownerName}. ${p.nextShow ? 'Vuelve ' + p.nextShow + '.' : ''}`),
          image: p.hasCover ? `/api/porch/${p.id}/cover` : `/img/scenes/escena-${p.scene || 1}.jpg`,
          ld: { '@context': 'https://schema.org', '@type': 'RadioStation', name: p.name, url: `${url.origin}/porche/${p.slug}` },
        }));
      }
    }

    // ---------- estáticos (con caché para recursos con huella)
    const res = await env.ASSETS.fetch(req);
    const extra = {};
    if (/^\/(fonts|img|library)\//.test(path)) extra['Cache-Control'] = 'public, max-age=2592000';
    if (path === '/sw.js') extra['Cache-Control'] = 'no-cache';
    return withHeaders(res, extra);
  },
};
