# Production deployment

## Before launch

- Set `NODE_ENV=production`; validate all Meta credentials, Mongo URI, JWT secret, and notification configuration.
- To send native WhatsApp product cards, set `WHATSAPP_CATALOG_ID` to the catalog connected to the business phone number and map each active product to its exact Meta `retailer_id` in the Products form. Multi-product messages support up to 30 mapped products.
- Use a dedicated managed MongoDB cluster with authentication, TLS, network allowlisting, backups, restore drills, and least-privilege app credentials.
- Use a replica set/Atlas deployment if future operations require transactions.
- Configure a secret manager, rotation process, restricted access, and separate credentials per environment.
- Deploy backend and frontend separately behind HTTPS. Set CORS to the exact dashboard origin.
- The backend binds to loopback behind Apache. Express trusts only loopback as its reverse proxy so API and login rate limits use the forwarded client IP instead of combining all visitors under `127.0.0.1`. The general API bucket allows 1,000 requests per client IP per 15 minutes; login remains limited to 10 per 15 minutes and WhatsApp webhooks to 120 per minute. Keep Apache as the only path to the backend and preserve its `X-Forwarded-For` header.
- Set up a Meta system-user token, approved templates, business verification, webhook callback, and production phone number.
- Enter verified products and confirm images are publicly fetchable by Meta.
- Set `APP_URL` to the public HTTPS API origin and persist the backend `uploads` directory. Docker Compose mounts it at `/app/uploads`; for a host-based deployment, create `/var/www/ncut-app/uploads` and grant write access to `ncut-app`.

## Runtime

Build and run:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm start -w backend
```

Build the frontend with its API URL configured at build time:

```sh
VITE_API_URL=https://ncut-api.ssdit.in/api/v1 npm run build -w frontend
```

Without an explicit `VITE_API_URL`, production builds use the configured public API origin; local Vite development uses `http://localhost:5000/api/v1`.

Use an external process supervisor/container orchestrator with health checks on `/api/v1/health`, graceful termination, resource limits, rolling deployment, and an operator-managed single webhook worker until queue leases/recovery are implemented. The app expects the proxy to preserve `X-Hub-Signature-256` and the original request body.

## Apache virtual hosts

The checked-in configuration is [deploy/apache/ncut-app.conf](../deploy/apache/ncut-app.conf). It serves the built frontend from `/var/www/ncut-app/frontend/dist` and proxies `ncut-api.ssdit.in` to the backend on `127.0.0.1:5000`.

Install and enable it on the server, then obtain HTTPS certificates:

```sh
sudo cp deploy/apache/ncut-app.conf /etc/apache2/sites-available/ncut-app.conf
sudo a2ensite ncut-app.conf
sudo apachectl configtest
sudo systemctl reload apache2
sudo certbot --apache --redirect -d ncut-app.ssdit.in -d ncut-api.ssdit.in
```

Set `FRONTEND_URL=https://ncut-app.ssdit.in` in the backend environment. Build the frontend after setting `VITE_API_URL` as shown above. Keep the backend listening on port `5000` on localhost; do not expose that port publicly.

For a host-based deployment, set `HOST=127.0.0.1` and use the provided [systemd unit](../deploy/systemd/ncut-app-backend.service) to keep the backend running. The unit runs as the dedicated `ncut-app` system user:

```sh
sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin ncut-app
sudo chown root:ncut-app .env
sudo chmod 640 .env
sudo cp deploy/systemd/ncut-app-backend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ncut-app-backend
```

## Observability and recovery

Forward Pino JSON logs to a protected log service. Alert on health failures, Meta 4xx/5xx spikes, webhook queue age, failed event count, notification failures, database connection saturation, and authentication failures. Never log access tokens or full sensitive customer message bodies. Define retention and PII deletion policies.

Test MongoDB backups by restoring to a separate environment. Document Meta token rotation, app-secret rotation, webhook endpoint failover, queue repair, and security incident response.

## Docker Compose limitations

Compose is for local evaluation. Its Mongo service is unauthenticated, non-persistent, single-node, and not hardened. Do not expose it publicly or use it for production records. Configure the external managed database and TLS ingress for deployment.
