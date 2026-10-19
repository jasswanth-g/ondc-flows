import { handle } from '../../lib/handler.js';
import { serve } from '../../lib/http.js';

// POST /ondc/{search|select|init|confirm|status|cancel} - buyer NP requests.
export default function handler(req, res) {
  const action = new URL(req.url, 'http://x').pathname.split('/').filter(Boolean).pop();
  return serve(req, res, (body, cfg) => handle(action, body, cfg));
}
