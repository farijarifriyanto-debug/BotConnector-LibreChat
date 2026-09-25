# BotConnector production deployment policy

Production LibreChat must be promoted only from a successful GitHub Actions artifact whose
`manifest.txt` commit equals the current `main` commit at deploy time.

Canonical VPS command:

```bash
/home/botadmin/newbotconnector/runtime/librechat/bin/promote-production.sh <artifact-directory>
```

The promoter serializes production deploys with `flock`, rejects stale artifacts, stages before
replacement, restarts and health-checks LibreChat, automatically rolls back on failed health-check,
and records the deployed SHA in `runtime/librechat/RUNTIME_MANIFEST`.

Do not directly copy or move files into the production `client/dist`, API, or built package paths.
Multiple sessions may build concurrently, but only the current-`main` artifact may be promoted.
