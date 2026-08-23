#!/usr/bin/env bash
#
# Everything PDFMint created, and how to take it away again.
# Reads RENDER_API_KEY and STRIPE_LIVE_SECRET_KEY from the environment.
#
#   ops/reap.sh --list       show what exists and what it costs; change nothing
#   ops/reap.sh --suspend    stop the Render service billing, keep all data
#   ops/reap.sh --resume     start it again
#   ops/reap.sh --local      remove the local n8n test containers and their data
#   ops/reap.sh --destroy    delete the Render service and the Stripe webhook
#
set -uo pipefail

RENDER_SERVICE="srv-da5g1obbc2fs738ulc60"
NEON_PROJECT="muddy-sunset-47374431"
STRIPE_WEBHOOK="we_1U7cgBCozVR51OgaRZj8KPi3"
MONTHLY_USD="7.00"

render() {
  curl -s -X "$1" "https://api.render.com/v1$2" \
    -H "Authorization: Bearer ${RENDER_API_KEY:?RENDER_API_KEY is not set}" \
    -H 'Content-Type: application/json' ${3:+-d "$3"}
}

list() {
  echo "PDFMint infrastructure"
  echo "======================"
  echo
  render GET "/services/$RENDER_SERVICE" | python3 -c "
import json, sys
raw = sys.stdin.read()
try:
    d = json.loads(raw)
except Exception:
    print('Render service: could not be read (check RENDER_API_KEY)')
    raise SystemExit
sd = d.get('serviceDetails', {})
state = 'SUSPENDED' if d.get('suspended') == 'suspended' else 'running'
print('Render web service  %s  (%s)' % (d.get('name'), d.get('id')))
print('  region   %s' % sd.get('region'))
print('  plan     %s' % sd.get('plan'))
print('  url      %s' % sd.get('url'))
print('  state    %s' % state)
"
  echo
  echo "Neon project        $NEON_PROJECT (free tier)"
  echo "Stripe webhook      $STRIPE_WEBHOOK -> /stripe/webhook"
  echo "npm package         n8n-nodes-pdfmint (public; this script never unpublishes it)"
  echo
  echo "Local containers:"
  docker ps -a --filter 'name=n8n-' --format '  {{.Names}}  {{.Status}}' 2>/dev/null \
    || sudo -n docker ps -a --filter 'name=n8n-' --format '  {{.Names}}  {{.Status}}' 2>/dev/null \
    || echo "  (docker not readable here)"
  echo
  echo "Running cost: \$$MONTHLY_USD / month, all of it the Render service."
  echo "Nothing else bills: Neon is on the free tier, Stripe charges per transaction,"
  echo "npm and GitHub are free for public projects, and no domain was bought."
}

docker_rm() { docker rm -f "$1" 2>/dev/null || sudo -n docker rm -f "$1" 2>/dev/null; }

case "${1:---list}" in
  --list) list ;;

  --suspend)
    echo "Suspending $RENDER_SERVICE — billing stops, all data stays."
    render POST "/services/$RENDER_SERVICE/suspend" >/dev/null \
      && echo "suspended. \$$MONTHLY_USD/month no longer accrues."
    ;;

  --resume)
    render POST "/services/$RENDER_SERVICE/resume" >/dev/null && echo "resumed."
    ;;

  --local)
    echo "Removing the local n8n test containers and their data directories."
    for c in n8n-test n8n-fresh n8n-video pdfmint-mem pdfmint-h; do
      docker_rm "$c" >/dev/null && echo "  removed container $c"
    done
    for d in /tmp/n8n-data /tmp/n8n-fresh /tmp/n8n-video /tmp/n8ntest /tmp/installcheck /tmp/provcheck; do
      [ -e "$d" ] && rm -rf "$d" && echo "  removed $d"
    done
    echo "done."
    ;;

  --destroy)
    cat <<EOF
This will PERMANENTLY delete:

  - the Render web service $RENDER_SERVICE (the public URL stops answering)
  - the Stripe webhook endpoint $STRIPE_WEBHOOK

It will NOT touch: the Neon database (delete that from the Neon console if you
want the data gone), the npm package (unpublishing breaks anyone who installed
it, and npm refuses after 72 hours anyway), the GitHub repositories, or any
Stripe customer, subscription or payment.

EOF
    read -r -p 'Type DESTROY to continue: ' confirm
    [ "$confirm" = "DESTROY" ] || { echo "Nothing was changed."; exit 1; }

    echo "Deleting the Stripe webhook…"
    curl -s -X DELETE "https://api.stripe.com/v1/webhook_endpoints/$STRIPE_WEBHOOK" \
      -u "${STRIPE_LIVE_SECRET_KEY:?STRIPE_LIVE_SECRET_KEY is not set}:" >/dev/null && echo "  done"

    echo "Deleting the Render service…"
    render DELETE "/services/$RENDER_SERVICE" >/dev/null && echo "  done"

    echo
    echo "The database survives on purpose. To remove it too:"
    echo "  https://console.neon.tech/app/projects/$NEON_PROJECT/settings"
    echo
    echo "Monthly cost after this: \$0.00"
    ;;

  *) echo "unknown option: $1"; sed -n '3,12p' "$0"; exit 1 ;;
esac
