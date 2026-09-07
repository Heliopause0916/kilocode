import { hasDisplay } from "@/kilocode/cli/cmd/tui/util/display"

// Shared by `kilo console` and `kilo web`: open a URL in the default browser
// when a display is present, otherwise print a hint and return.
export async function launch(url: string, hint = "No display detected; open the URL manually") {
  if (!hasDisplay()) {
    console.warn(hint)
    return
  }
  const { default: open } = await import("open")
  const child = await open(url)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 500)
    child.once("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.once("exit", (code) => {
      if (code === null || code === 0) {
        clearTimeout(timer)
        resolve()
        return
      }
      clearTimeout(timer)
      reject(new Error(`Browser open failed with exit code ${code}`))
    })
  })
}
