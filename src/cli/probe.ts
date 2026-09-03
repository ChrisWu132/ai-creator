import { probePage } from '../authoring/probe.js'

const url = process.argv[2]
if (!url) {
  console.error('Usage: npm run probe -- <url>')
  process.exit(2)
}

// Useful on its own: run it against a page before writing a spec by hand, or
// to see what the script generator will be reasoning over.
console.log(JSON.stringify(await probePage(url), null, 2))
