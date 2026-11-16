// Chain state for the BCH calendar widget, from a Fulcrum (Electrum protocol)
// server. Prints one JSON line on stdout and exits 0, or exits 2 when every
// server failed (the widget keeps its cache and retries).
//
//   node fetch.mjs [--activation <unix>] [--ha <height>] [host[:port] ...]
//
// Asks for:
//   - the tip (blockchain.headers.subscribe)
//   - the 11 headers ending at the tip, for its median-time-past (MTP)
//   - the header 2016 blocks back, for the recent block pace
//   - once the tip's MTP has reached --activation (CHIP-2025-03, 1-minute
//     blocks) and no final --ha is given: a binary search for the activation
//     block H_a, the first block whose MTP >= activation. MTP never decreases,
//     so the search is sound; it costs ~15 small requests, once.
//
// Network: one TLS connection (port 50002 unless given), servers tried in order
// until one answers. Defaults are the curated Cashonize mainnet list.

import tls from "node:tls"

const DEFAULT_SERVERS = [
  "electrum.imaginary.cash",
  "bch.imaginary.cash",
  "cashnode.bch.ninja",
  "fulcrum.greyh.at",
  "electroncash.dk",
  "fulcrum.jettscythe.xyz",
  "bch.loping.net",
  "fulcrum.criptolayer.net",
]

const WINDOW = 2016
const TIMEOUT_MS = 15000
const MAX_BYTES = 256 * 1024

function hostPort(server) {
  const s = String(server).trim().replace(/^(wss?|https?|ssl|tls):\/\//i, "").replace(/\/+$/, "")
  const m = s.match(/^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/)
  if (!m) return null
  return { host: m[1], port: m[2] ? Number(m[2]) : 50002 }
}

// Block times out of concatenated 80-byte headers (bytes 68..71, LE).
function headerTimes(hex) {
  if (typeof hex !== "string" || hex.length % 160 !== 0 || !/^[0-9a-f]*$/i.test(hex)) throw new Error("bad header")
  const buf = Buffer.from(hex, "hex")
  const out = []
  for (let i = 0; i < buf.length; i += 80) out.push(buf.readUInt32LE(i + 68))
  return out
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

// Minimal JSON-RPC client over one TLS socket.
function connect(target) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: target.host, port: target.port, servername: target.host })
    const pending = new Map()
    let nextId = 1
    let buf = ""
    const fail = (e) => {
      for (const p of pending.values()) p.reject(e)
      pending.clear()
      sock.destroy()
      reject(e)
    }
    sock.on("error", fail)
    sock.on("close", () => fail(new Error("closed")))
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8")
      if (buf.length > MAX_BYTES) return fail(new Error("response too large"))
      let nl
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        const p = pending.get(msg.id)
        if (!p) continue
        pending.delete(msg.id)
        msg.error ? p.reject(new Error(String(msg.error.message || "rpc error"))) : p.resolve(msg.result)
      }
    })
    sock.on("secureConnect", () => resolve({
      call(method, params) {
        return new Promise((res, rej) => {
          const id = nextId++
          pending.set(id, { resolve: res, reject: rej })
          sock.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
        })
      },
      close() { sock.removeAllListeners("close"); sock.destroy() },
    }))
  })
}

async function query(server, activation, knownHa) {
  const target = hostPort(server)
  if (!target) throw new Error("bad server " + server)
  const rpc = await connect(target)
  const timer = setTimeout(() => rpc.close(), TIMEOUT_MS)
  try {
    await rpc.call("server.version", ["omarchy-bch-calendar", "1.4"])
    const tipRes = await rpc.call("blockchain.headers.subscribe", [])
    const height = Number(tipRes && tipRes.height)
    if (!Number.isInteger(height) || height <= WINDOW) throw new Error("bad tip")

    const mtpAt = async (h) => {
      const r = await rpc.call("blockchain.block.headers", [h - 10, 11])
      const ts = headerTimes(r && r.hex)
      if (ts.length !== 11) throw new Error("short headers")
      return { mtp: median(ts), time: ts[10] }
    }
    const tip = await mtpAt(height)
    const pastTime = headerTimes(await rpc.call("blockchain.block.header", [height - WINDOW]))[0]

    let activationHeight = knownHa > 0 ? knownHa : null
    if (!activationHeight && activation > 0 && tip.mtp >= activation) {
      // Bracket: walk back until a block's MTP is before activation.
      let hi = height
      let step = 64
      let lo = height - step
      while ((await mtpAt(lo)).mtp >= activation) {
        hi = lo
        step *= 2
        lo = Math.max(11, height - step)
        if (lo === 11) break
      }
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2)
        if ((await mtpAt(mid)).mtp >= activation) hi = mid
        else lo = mid
      }
      activationHeight = hi
    }

    return {
      height,
      tipTime: tip.time,
      tipMtp: tip.mtp,
      pastHeight: height - WINDOW,
      pastTime,
      activationHeight,
      server: target.host,
      fetchedAt: Math.floor(Date.now() / 1000),
    }
  } finally {
    clearTimeout(timer)
    rpc.close()
  }
}

const args = process.argv.slice(2)
let activation = 0
let knownHa = 0
const servers = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--activation") activation = Number(args[++i]) || 0
  else if (args[i] === "--ha") knownHa = Number(args[++i]) || 0
  else if (args[i]) servers.push(args[i])
}

for (const server of servers.length ? servers : DEFAULT_SERVERS) {
  try {
    const result = await query(server, activation, knownHa)
    process.stdout.write(JSON.stringify(result) + "\n")
    process.exit(0)
  } catch (e) {
    process.stderr.write(`${server}: ${e.message}\n`)
  }
}
process.exit(2)
