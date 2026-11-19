# Production deployment

## Before launch

- Set `NODE_ENV=production`; validate all Meta credentials, Mongo URI, JWT secret, and notification configuration.
- Use a dedicated managed MongoDB cluster with authentication, TLS, network allowlisting, backups, restore drills, and least-privilege app credentials.
- Use a replica set/Atlas deployment if future operations require transactions.
- Configure a secret manager, rotation process, restricted access, and separate credentials per environment.
- Deploy backend and frontend separately behind HTTPS. Set CORS to the exact dashboard origin.
- Set up a Meta system-user token, approved templates, business verification, webhook callback, and production phone number.
- Enter verified products and confirm images are publicly fetchable by Meta.

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
VITE_API_URL=https://api.example.com/api/v1 npm run build -w frontend
```

Use an external process supervisor/container orchestrator with health checks on `/api/v1/health`, graceful termination, resource limits, rolling deployment, and an operator-managed single webhook worker until queue leases/recovery are implemented. The app expects the proxy to preserve `X-Hub-Signature-256` and the original request body.

## Observability and recovery

Forward Pino JSON logs to a protected log service. Alert on health failures, Meta 4xx/5xx spikes, webhook queue age, failed event count, notification failures, database connection saturation, and authentication failures. Never log access tokens or full sensitive customer message bodies. Define retention and PII deletion policies.

Test MongoDB backups by restoring to a separate environment. Document Meta token rotation, app-secret rotation, webhook endpoint failover, queue repair, and security incident response.

## Docker Compose limitations

Compose is for local evaluation. Its Mongo service is unauthenticated, non-persistent, single-node, and not hardened. Do not expose it publicly or use it for production records. Configure the external managed database and TLS ingress for deployment.
