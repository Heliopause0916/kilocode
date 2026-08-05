---
"@kilocode/cli": patch
---

Add a 15-second timeout to the grep tool so scans of very large directories no longer hang indefinitely; when the limit is reached it returns a clear error instead of waiting forever.
