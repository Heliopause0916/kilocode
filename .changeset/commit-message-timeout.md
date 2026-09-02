---
"@kilocode/cli": patch
---

Raise the default timeout for generating commit messages from 30 seconds to 5 minutes and make it configurable via the new `commit_message.timeoutMs` setting, so slow providers no longer fail unnecessarily and the limit can be tuned per user.
