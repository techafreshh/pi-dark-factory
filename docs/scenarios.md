# The scenario & probe contract

Acceptance lives OUTSIDE the product repo and runs black-box against the real service.

## Scenario & probe contract

`runtime.json` / `holdout.json`: `setup`, `start` (**foreground** server command — the harness
backgrounds it and always kills its process group), `readiness_path`, `teardown`, `probes[]`.
Every command gets `PORT` env. Probes are shell commands judged by `expect` tokens
(space-separated, values must be space-free):

```
status:200                 last stdout line equals 200 (use curl -s -o /dev/null -w '%{http_code}')
json:data[0].name=ok       walk stdout as JSON; lenient value comparison (true/3/"ok")
body_contains:text         stdout includes text
body_matches:^[0-9]{3}$    regex against stdout
exit:3                     exit code (implicit exit:0 unless overridden)
max_ms:3000                probe timeout for the runner
```

Unknown tokens fail closed. A busy port (any listener, factory or not) fails the scenario before
anything runs. Ports are reserved per-config at onboard time (config inventory + live probe).
The same contract runs in every mode: host and compose execute it on the VPS (container mode
inside the worker, ports published on `127.0.0.1`); instabox runs setup/start/teardown inside
the machine with probes still host-side, through forwarded 127.0.0.1 ports.
