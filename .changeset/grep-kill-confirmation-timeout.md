---
"@kilocode/cli": patch
---

Bound the wait for subprocess termination confirmation in the spawn layer so the grep tool can no longer hang indefinitely in rare environments (e.g. when a dropped process close event on Windows never arrives); the wait now times out and returns instead of stalling forever.
