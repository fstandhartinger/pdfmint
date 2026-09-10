'use strict';
const crypto = require('node:crypto');
const { query } = require('./db');
const CAMPAIGN = 'growth-ads-pdfmint-20260910';
function authorized(header, secret) {
  if (typeof secret !== 'string' || secret.length < 32 || typeof header !== 'string') return false;
  const actual=Buffer.from(header), expected=Buffer.from('Bearer '+secret);
  return actual.length===expected.length && crypto.timingSafeEqual(actual,expected);
}
function install(app) {
  app.get('/internal/growth-ads/report', async (req,res) => {
    res.set({'Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow'});
    if(!authorized(req.get('authorization'),process.env.GROWTH_ADS_REPORT_TOKEN)) return res.status(401).json({error:'unauthorized'});
    try {
      const {rows}=await query(`
        SELECT count(*)::int AS trials,
        count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM usage_events u WHERE u.account_id=c.account_id
          AND u.ok AND u.origin='production' AND u.created_at>=c.created_at
        ))::int AS activated,
        count(*) FILTER (WHERE a.plan<>'free' AND a.stripe_subscription_id IS NOT NULL)::int AS paid_plan_accounts,
        count(*) FILTER (WHERE (c.created_at AT TIME ZONE 'UTC')::date=(now() AT TIME ZONE 'UTC')::date)::int AS trials_today
        FROM ad_signup_conversions c JOIN accounts a ON a.id=c.account_id
        WHERE c.campaign_id=$1 AND NOT c.qa AND NOT a.internal`,[CAMPAIGN]);
      return res.json({campaign:CAMPAIGN,asOf:new Date().toISOString(),...rows[0]});
    } catch(e) {
      // Never return zero on failure: the ad guard must stop when measurement fails.
      return res.status(503).json({error:'measurement_unavailable'});
    }
  });
}
module.exports={install,authorized};
