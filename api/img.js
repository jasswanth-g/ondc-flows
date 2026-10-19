import { PROVIDERS } from '../lib/data.js';
import { OFFERS } from '../lib/offers.js';

// Generated product / provider / brand tiles so catalogue image URLs resolve to a real image.
const LABELS = new Map([
  ['seller', 'DigiDukaan Mock Seller'],
  ...PROVIDERS.map((p) => [p.id, p.distributor]),
  ...PROVIDERS.flatMap((p) => p.items.map((i) => [i.id, i.name])),
  ...PROVIDERS.flatMap((p) => p.brand_images.map((b) => [`brand-${b}`, b])),
  ...Object.values(OFFERS).flat().map((o) => [`offer-${o.id}`, o.title]),
]);

const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function wrap(text, width = 18) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    if ((line + ' ' + word).trim().length > width) {
      if (line) lines.push(line);
      line = word;
    } else line = (line + ' ' + word).trim();
  }
  if (line) lines.push(line);
  return lines.slice(0, 4);
}

export default function handler(req, res) {
  const name = String(new URL(req.url, 'http://x').searchParams.get('name') ?? '').replace(/\.svg$/, '');
  const label = LABELS.get(decodeURIComponent(name));
  if (!label) {
    res.statusCode = 404;
    return res.end('not found');
  }
  const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const lines = wrap(label);
  const text = lines
    .map((l, i) => `<text x="200" y="${200 - (lines.length - 1) * 18 + i * 36}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="28" font-weight="600" fill="#fff">${escape(l)}</text>`)
    .join('');
  res.statusCode = 200;
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400"><rect width="400" height="400" rx="24" fill="hsl(${hue} 45% 38%)"/>${text}</svg>`);
}
