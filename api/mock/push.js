import { handlePush } from '../../lib/handler.js';
import { serve } from '../../lib/http.js';

// POST /api/mock/push { order_id, event } - makes the mock seller act on its own on a confirmed
// order: event = packed | out_for_delivery | delivered (unsolicited on_status) or seller_cancel
// (unsolicited on_cancel). Not part of ONDC; it stands in for the seller's back office.
export default function handler(req, res) {
  return serve(req, res, (body, cfg) => handlePush(body, cfg));
}
