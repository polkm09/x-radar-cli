# Split Topic Tools Deployment

The deployment artifacts are now split by tool name:

- `topic-collector-0.1.110.tgz` installs `topic-collector`.
- `topic-vertical-0.1.110.tgz` installs `topic-vertical`.

The split verifier checks both npm command entrypoints and tarball contents: the collector package must not contain `topic-vertical` source, and the vertical package must not contain collector/browser/Get笔记 source.

Use `DEPLOY_TOPIC_COLLECTOR_TO_MAC_MINI.md` for the data collection tool and `DEPLOY_TOPIC_VERTICAL_TO_MAC_MINI.md` for the vertical discovery tool.
