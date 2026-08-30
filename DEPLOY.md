# Wie dieses Repo ausgerollt wird

Ein Push auf `master` deployt nach `https://pdf.mintapis.com`. Das ist seit dem
30.08.2026 wieder wahr und war es davor monatelang nicht.

## Was kaputt war

Coolify meldete für die Anwendung `is_auto_deploy_enabled = true`, aber dieses
Repo hatte **keinen einzigen Webhook**, und die Coolify-Instanz hatte keinen
FQDN — GitHub hätte also gar keine Adresse gehabt, an die es hätte zustellen
können. Beide Seiten schwiegen dazu: der Push wurde grün quittiert, Coolifys
Warteschlange blieb leer, der Container bediente weiter den vorherigen Commit.
Aufgefallen ist es erst, als ein Commit auf `master` lag und die Produktion
nachweislich den Stand davor auslieferte.

## Wie es jetzt läuft

GitHub stellt `push`-Ereignisse an
`https://coolify.app.mintapis.com/webhooks/source/github/events/manual` zu,
signiert mit dem anwendungseigenen HMAC-Secret.

Exponiert ist über diesen Namen **ausschließlich** der Pfad `/webhooks/` — das
Coolify-Dashboard und die API antworten dort mit 404 und bleiben wie zuvor nur
über `127.0.0.1:8000` erreichbar. Der Grund: Coolify darf auf diesem Host alles
ausrollen, und ein FQDN auf der Instanz hätte die komplette Steuerungsebene ins
Netz gestellt, um einen einzigen Deploy-Trigger zu bekommen.

## Wenn ein Deploy von Hand nötig ist

```bash
sudo docker exec coolify php artisan tinker --execute="
  \$app = App\Models\Application::where('uuid','8krrw2g88xyrofaqto9tposj')->first();
  \$uuid = (string) new Visus\Cuid2\Cuid2();
  queue_application_deployment(application: \$app, deployment_uuid: \$uuid, is_api: true);
  echo \$uuid;"
```

Ob er durch ist, sagt der Image-Tag des laufenden Containers — nicht die
Warteschlange allein. Während des Wechsels bedient der alte Container noch mit;
wer in diesem Fenster misst, misst den Deploy und nicht die Anwendung.
