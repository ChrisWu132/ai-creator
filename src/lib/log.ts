const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`

let t0 = Date.now()

export const log = {
  reset() { t0 = Date.now() },
  stamp() { return dim(`${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(6)) },
  info(msg: string) { console.log(`${this.stamp()} ${msg}`) },
  step(msg: string) { console.log(`${this.stamp()} ${dim('·')} ${dim(msg)}`) },
  action(msg: string) { console.log(`${this.stamp()} ${cyan('▸')} ${msg}`) },
  warn(msg: string) { console.log(`${this.stamp()} ${yellow('!')} ${msg}`) },
  error(msg: string) { console.error(`${this.stamp()} ${red('✗')} ${msg}`) },
  done(msg: string) { console.log(`${this.stamp()} ${green('✓')} ${msg}`) },
}
