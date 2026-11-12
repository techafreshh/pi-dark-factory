# Docker stack

Runs the factory (`factoryd` + scheduler) and the dashboard on your own computer, with no VPS.

```sh
cp .env.example .env && chmod 600 .env     # set FACTORY_API_KEY, GH_TOKEN and a model key
docker compose up -d --build
curl -fsS localhost:8077/health            # then open http://localhost:8787
npx @techafresh/dark-factory setup http://localhost:8077 <FACTORY_API_KEY>
```

The full guide (auth, resources, updating, running behind Caddy, troubleshooting) is [docs/docker.md](../docs/docker.md).
