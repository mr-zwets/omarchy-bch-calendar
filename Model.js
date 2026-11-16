.pragma library

// Pure chain math and formatting for the BCH calendar widget. No QML types,
// so it can be tested with node (strip the pragma line).
//
// Halvings follow CHIP-2025-03 ("Faster Blocks", 1-minute blocks) tick model:
// a tick is one second of target time; every block up to and including the
// activation block H_a adds 600 ticks, every later block 60. A block's era is
// floor(ceil(tick / 600) / 210000), so halvings stay on the original
// 126,000,000-tick grid whatever the block time. Before activation (or with
// the upgrade disabled) this is exactly the old height / 210,000 rule.

var ERA_CHUNKS = 210000
var CHUNK = 600
var FAST_TAU = 60

// Per network: the curated Cashonize Fulcrum list and the 1-minute-block
// activation time (MTP, unix seconds) from CHIP-2025-03.
var NETWORKS = {
  mainnet: { servers: [], activation: 1810382400 },  // [] = fetch.mjs defaults
  chipnet: {
    servers: ["chipnet.imaginary.cash", "chipnet.bch.ninja", "chipnet.c3-soft.com:64002"],
    activation: 1794744000
  }
}

// Named upgrades; any other year falls back to "Upgrade <year>" on 15 May.
var UPGRADE_NAMES = { 2027: "1-minute blocks" }

function network(name) {
  return NETWORKS[name] || NETWORKS.mainnet
}

// fetch.mjs output -> validated object, or null for anything unusable.
function parse(text) {
  try {
    var d = JSON.parse(String(text || "").trim())
    function int(x) { var n = Number(x); return n >= 0 && n < 1e10 && Math.floor(n) === n ? n : -1 }
    var h = int(d && d.height)
    var t = int(d && d.tipTime)
    var m = int(d && d.tipMtp)
    if (!(h > 2016 && h < 1e8) || t < 1231006505 || m < 1231006505) return null
    var ph = int(d.pastHeight), pt = int(d.pastTime)
    var ha = d.activationHeight === null || d.activationHeight === undefined ? null : int(d.activationHeight)
    return {
      height: h,
      tipTime: t,
      tipMtp: m,
      pastHeight: ph > 0 && ph < h ? ph : 0,
      pastTime: pt > 0 && pt < t ? pt : 0,
      activationHeight: ha > 0 && ha <= h ? ha : null,
      server: String(d.server || "").slice(0, 80),
      fetchedAt: int(d.fetchedAt) > 0 ? d.fetchedAt : 0
    }
  } catch (e) {
    return null
  }
}

function tick(h, ha) {
  if (ha === null || ha === undefined || h <= ha) return h * CHUNK
  return ha * CHUNK + (h - ha) * FAST_TAU
}

// Target interval of block h itself.
function tau(h, ha) {
  return ha !== null && ha !== undefined && h > ha ? FAST_TAU : CHUNK
}

function era(h, ha) {
  return Math.floor(Math.ceil(tick(h, ha) / CHUNK) / ERA_CHUNKS)
}

// Satoshis per block: halve 50 BCH first, then scale by the interval
// (the CHIP's normative order).
function subsidySats(h, ha) {
  var e = era(h, ha)
  if (e >= 64) return 0
  return Math.floor(Math.floor(5e9 / Math.pow(2, e)) * tau(h, ha) / CHUNK)
}

// First block of the era after the tip's, by walking the tick grid: the era
// boundary sits at boundaryTick; the first block whose interval starts at or
// after (boundaryTick - 600) is the first one in the new era.
function firstBlockOfEra(targetEra, ha) {
  var startTick = targetEra * ERA_CHUNKS * CHUNK - CHUNK  // interval start
  if (ha === null || ha === undefined || startTick < ha * CHUNK) return startTick / CHUNK + 1
  return ha + (startTick - ha * CHUNK) / FAST_TAU + 1
}

// Activation state of the 1-minute-block upgrade.
//   cfgActivation: unix MTP, or 0 when the upgrade is not assumed.
// Returns the H_a to use for projections plus whether it is real.
function activationState(chain, cfgActivation) {
  if (!chain) return { ha: null, known: false, active: false, pending: false }
  if (chain.activationHeight) return { ha: chain.activationHeight, known: true, active: true, pending: false }
  if (!(cfgActivation > 0) || chain.tipMtp >= cfgActivation) {
    // Disabled, or MTP passed but the search hasn't reported yet.
    return { ha: null, known: false, active: false, pending: cfgActivation > 0 }
  }
  // Not active yet: the activation block is the first whose MTP (≈ its own
  // time minus five intervals) reaches the activation time.
  var est = chain.height + Math.ceil((cfgActivation - chain.tipTime) / CHUNK) + 5
  return { ha: Math.max(chain.height + 1, est), known: false, active: false, pending: true }
}

// Everything the card shows about the next halving.
function halving(chain, cfgActivation) {
  if (!chain) return null
  var act = activationState(chain, cfgActivation)
  var e = era(chain.height, act.ha)
  var first = firstBlockOfEra(e + 1, act.ha)
  // Does the projected activation happen before the halving? If not, it
  // doesn't move the halving block.
  var ha = act.ha !== null && act.ha < first ? act.ha : null
  if (ha !== act.ha) first = firstBlockOfEra(e + 1, ha)
  var legacy = firstBlockOfEra(e + 1, null)
  return {
    number: e + 1,
    height: first,
    exact: act.known || ha === null,
    legacyHeight: legacy,
    blocksLeft: first - chain.height,
    // Ticks are seconds of target time; the halving block is due when the
    // ticks between the tip and it have elapsed.
    eta: chain.tipTime + tick(first, ha) - tick(chain.height, ha),
    progress: (tick(chain.height, ha) - e * ERA_CHUNKS * CHUNK) / (ERA_CHUNKS * CHUNK),
    rewardNow: subsidySats(chain.height, act.known ? act.ha : null),
    rewardNext: subsidySats(first, ha),
    per10Now: Math.floor(5e9 / Math.pow(2, e)),
    per10Next: Math.floor(5e9 / Math.pow(2, e + 1)),
    fastAtHalving: tau(first, ha) === FAST_TAU
  }
}

// Seconds of real time per second of target time over the last 2016 blocks,
// times the current target interval: the recent average block time.
function avgBlockSeconds(chain) {
  if (!chain || !chain.pastHeight || !chain.pastTime) return 0
  var ha = chain.activationHeight
  var ticks = tick(chain.height, ha) - tick(chain.pastHeight, ha)
  if (!(ticks > 0)) return 0
  return (chain.tipTime - chain.pastTime) / ticks * tau(chain.height + 1, ha)
}

// 15 May, 12:00 UTC (MTP): BCH's yearly upgrade slot.
function upgradeTime(year) {
  return Date.UTC(year, 4, 15, 12, 0, 0) / 1000
}

// Local-day bounds (ms) of a moment given in unix seconds.
function dayStartMs(sec) {
  var d = new Date(sec * 1000)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}
function dayEndMs(sec) {
  var d = new Date(sec * 1000)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
}

// The chain's MTP when it's fresh, else the wall clock minus the usual ~1 h
// MTP lag (no data yet, stale cache, offline for days).
function chainMtp(chain, nowMs) {
  var wall = nowMs / 1000
  return chain && Math.abs(wall - chain.tipMtp) < 6 * 3600 ? chain.tipMtp : wall - 3600
}

// The upgrade to show: the next one, or one that activated today, which
// stays (as done) until local midnight. It only rolls on once the chain's
// MTP has passed it too.
function nextUpgrade(chain, nowMs) {
  var mtp = chainMtp(chain, nowMs)
  var year = new Date(nowMs).getUTCFullYear() - 1
  while (upgradeTime(year) <= mtp && dayEndMs(upgradeTime(year)) <= nowMs) year++
  var t = upgradeTime(year)
  var done = mtp >= t
  return {
    year: year,
    time: t,
    name: UPGRADE_NAMES[year] || "Upgrade " + year,
    done: done,
    // Wall clock past 12:00 UTC but MTP (≈ 1 h behind) not yet.
    activating: !done && nowMs / 1000 >= t,
    today: nowMs >= dayStartMs(t)
  }
}

// 15 November, 12:00 UTC: the next May upgrade is locked in and activates on
// chipnet. Shown until the end of that local day.
function nextLockIn(nowMs) {
  var year = new Date(nowMs).getUTCFullYear() - 1
  while (dayEndMs(Date.UTC(year, 10, 15, 12) / 1000) <= nowMs) year++
  var t = Date.UTC(year, 10, 15, 12) / 1000
  return { year: year, time: t, today: nowMs >= dayStartMs(t) }
}

// The halving that happened today, if any: { number, height, time }. Its
// time is estimated back from the tip on the tick grid.
function recentHalving(chain, nowMs) {
  if (!chain) return null
  var ha = chain.activationHeight
  var e = era(chain.height, ha)
  if (e < 1) return null
  var first = firstBlockOfEra(e, ha)
  var t = chain.tipTime - (tick(chain.height, ha) - tick(first, ha))
  return nowMs < dayEndMs(t) ? { number: e, height: first, time: t } : null
}

// Yearly dates, counted to the start of the day (local time). `since` is the
// original year, for "turns N".
var ANNIVERSARIES = [
  { key: "birthday",   icon: "󰃫", month: 7,  day: 1,  since: 2017, name: "BCH birthday",   what: "BCH turns %1" },
  { key: "whitepaper", icon: "󰈙", month: 9,  day: 31, since: 2008, name: "Whitepaper day", what: "Whitepaper turns %1" },
  { key: "genesis",    icon: "󰆧", month: 0,  day: 3,  since: 2009, name: "Genesis block",  what: "Genesis turns %1" },
  { key: "pizza",      icon: "󰐉", month: 4,  day: 22, since: 2010, name: "Pizza day",      what: "%1 years of pizza" }
]

// Every tracked date, soonest first:
//   { key, icon, name, detail, time (unix s), today, milestone, chain }
// A yearly date stays "today" for its whole day, then moves to next year.
function events(chain, cfgActivation, nowMs) {
  var list = []
  var now = new Date(nowMs)
  for (var i = 0; i < ANNIVERSARIES.length; i++) {
    var a = ANNIVERSARIES[i]
    var year = now.getFullYear()
    var start = new Date(year, a.month, a.day)
    if (start.getTime() + 86400000 <= nowMs) start = new Date(++year, a.month, a.day)
    var age = year - a.since
    list.push({
      key: a.key, icon: a.icon, name: a.name,
      detail: age % 10 === 0 ? ordinal(age) + " anniversary" : a.what.replace("%1", age),
      time: start.getTime() / 1000,
      today: start.getTime() <= nowMs,
      milestone: age % 5 === 0,
      chain: false
    })
  }
  var up = nextUpgrade(chain, nowMs)
  list.push({
    key: "upgrade", icon: "󰑣",
    name: up.name === "Upgrade " + up.year ? "Network upgrade" : up.name + " upgrade",
    detail: up.done ? (chain && chain.activationHeight && up.time === cfgActivation
        ? "activated at block " + num(chain.activationHeight) : "activated")
      : up.activating ? "activating…" : "12:00 UTC",
    time: up.time, today: up.today, milestone: false, chain: true
  })
  var lock = nextLockIn(nowMs)
  list.push({
    key: "lockin", icon: "󰌾", name: "Upgrade lock-in",
    detail: "chipnet upgrade, 12:00 UTC",
    time: lock.time, today: lock.today, milestone: false, chain: false
  })
  // A halving that happened today stays (as done) until local midnight;
  // otherwise the next one. Reward and heights live on the halving page:
  // per-block numbers change with 1-minute blocks, so the list shows only
  // the date.
  var past = recentHalving(chain, nowMs)
  var h = halving(chain, cfgActivation)
  list.push(past ? {
    key: "halved", icon: "󰢷", name: "Halving #" + past.number,
    detail: "halved at block " + num(past.height),
    time: past.time, today: true, milestone: false, chain: true
  } : {
    key: "halving", icon: "󰢷", name: "Halving #" + (h ? h.number : "—"),
    detail: h ? "" : "loading…",
    time: h ? h.eta : Infinity, today: false, milestone: false, chain: true
  })
  list.sort(function(x, y) { return x.time - y.time })
  return list
}

function ordinal(n) {
  var s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th"
  return n + s
}

// List column: "today", "48d", "1y 137d", "13h", "47m".
function leftText(sec, nowMs, today) {
  if (today) return "today"
  var left = sec * 1000 - nowMs
  if (!isFinite(left)) return "—"
  if (left <= 0) return "now"
  var days = Math.floor(left / 86400000)
  if (days >= 365) return Math.floor(days / 365) + "y" + (days % 365 ? " " + (days % 365) + "d" : "")
  if (days >= 2) return days + "d"
  var hours = Math.floor(left / 3600000)
  if (hours >= 1) return hours + "h"
  return Math.max(1, Math.floor(left / 60000)) + "m"
}

// "Sat 1 Aug 2027".
function dayText(sec) {
  var d = new Date(Number(sec) * 1000)
  if (!isFinite(d.getTime())) return ""
  return DAYS[d.getDay()] + " " + d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear()
}

// Bar pill fragment: "502d", then "36h", then "47m".
function shortLeft(etaSec, nowMs) {
  var left = etaSec * 1000 - nowMs
  if (!isFinite(left)) return "—"
  if (left <= 0) return "now"
  var hours = left / 3600000
  if (hours >= 48) return Math.floor(hours / 24) + "d"
  if (hours >= 1) return Math.floor(hours) + "h"
  return Math.max(1, Math.floor(left / 60000)) + "m"
}

// "1y 137d 21h 10m 05s" (365-day years), ticking to the second.
function countdown(etaSec, nowMs) {
  var left = Math.floor((Number(etaSec) * 1000 - Number(nowMs)) / 1000)
  if (!isFinite(left)) return ""
  if (left <= 0) return "any block now"
  function two(n) { return n < 10 ? "0" + n : String(n) }
  var y = Math.floor(left / 31536000); left -= y * 31536000
  var d = Math.floor(left / 86400); left -= d * 86400
  var h = Math.floor(left / 3600); left -= h * 3600
  var m = Math.floor(left / 60)
  var s = left - m * 60
  var out = (y > 0 ? y + "y " : "") + (y > 0 || d > 0 ? d + "d " : "")
  return out + two(h) + "h " + two(m) + "m " + two(s) + "s"
}

// 977584 -> "977,584".
function num(n) {
  return String(Math.floor(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

// Satoshis -> "3.125", "0.15625".
function bch(sats) {
  return String(Number((Number(sats) / 1e8).toFixed(8)))
}

// 607.5 -> "10m 07s", 61 -> "1m 01s".
function blockTime(sec) {
  if (!(sec > 0)) return "—"
  var s = Math.round(sec)
  var ss = s % 60
  return Math.floor(s / 60) + "m " + (ss < 10 ? "0" : "") + ss + "s"
}

var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
function two(n) { return n < 10 ? "0" + n : String(n) }

// Local time: "Sun 2 Apr 2028, 06:57".
function dateText(sec) {
  var d = new Date(Number(sec) * 1000)
  if (!isFinite(d.getTime())) return ""
  return DAYS[d.getDay()] + " " + d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear()
    + ", " + two(d.getHours()) + ":" + two(d.getMinutes())
}

// "04:57 UTC".
function utcTime(sec) {
  var d = new Date(Number(sec) * 1000)
  if (!isFinite(d.getTime())) return ""
  return two(d.getUTCHours()) + ":" + two(d.getUTCMinutes()) + " UTC"
}

function ageText(ms, nowMs) {
  if (!ms) return "never"
  var s = Math.max(0, Math.round((nowMs - ms) / 1000))
  if (s < 60) return "just now"
  if (s < 3600) return Math.round(s / 60) + "m ago"
  return Math.round(s / 3600) + "h ago"
}

// 15s, 30s, 1m, … capped at the poll interval.
function retryMs(failures, pollMs) {
  return Math.min(15000 * Math.pow(2, Math.max(0, failures - 1)), pollMs)
}
