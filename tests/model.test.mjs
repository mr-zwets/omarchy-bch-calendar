// Tests for Model.js (pure chain math and formatting). Run: node --test tests/
// Model.js is a QML `.pragma library` script, so it's loaded by stripping the
// pragma line and exporting its top-level functions.

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

process.env.TZ = "Europe/Brussels"

const src = readFileSync(new URL("../Model.js", import.meta.url), "utf8").replace(".pragma library", "")
const names = [...src.matchAll(/^function (\w+)/gm)].map((m) => m[1])
const M = {}
new Function("E", src + ";" + names.map((n) => `E.${n}=${n}`).join(";"))(M)

const ACTIVATION = 1810382400 // 2027-05-15T12:00:00Z
const chainAt = (nowMs, fields) => ({
  height: 977585, tipTime: nowMs / 1000 - 60, tipMtp: nowMs / 1000 - 3600,
  pastHeight: 975569, pastTime: nowMs / 1000 - 2016 * 600, activationHeight: null,
  server: "test", fetchedAt: 0, ...fields,
})
const find = (list, key) => list.find((e) => e.key === key)

test("legacy halving schedule is unchanged without the upgrade", () => {
  for (const h of [1, 209999, 210000, 839999, 840000, 977584, 1049999, 1050000])
    assert.equal(M.era(h, null), Math.floor(h / 210000), `era of ${h}`)
  assert.equal(M.firstBlockOfEra(5, null), 1050000)
  assert.equal(M.subsidySats(1049999, null), 312500000)
  assert.equal(M.subsidySats(1050000, null), 156250000)
})

test("tick model matches the CHIP-2025-03 example (H_a = 1,003,670)", () => {
  const ha = 1003670
  assert.equal(M.tick(ha, ha), 602202000)
  assert.equal(M.tick(1003672, ha), 602202120)
  const first = M.firstBlockOfEra(5, ha)
  assert.equal(first, 1466961)
  assert.equal(M.era(first - 1, ha), 4)
  assert.equal(M.era(first, ha), 5)
  // Per-block reward drops to 1/10 at activation, then halves on the grid.
  assert.equal(M.subsidySats(ha, ha), 312500000)
  assert.equal(M.subsidySats(ha + 1, ha), 31250000)
  assert.equal(M.subsidySats(first - 1, ha), 31250000)
  assert.equal(M.subsidySats(first, ha), 15625000)
  // An era after activation is exactly 2,100,000 one-minute blocks.
  assert.equal(M.firstBlockOfEra(6, ha) - M.firstBlockOfEra(5, ha), 2100000)
})

test("halving date does not depend on the switch to 1-minute blocks", () => {
  const chain = chainAt(Date.UTC(2026, 10, 16, 8), {})
  const fast = M.halving(chain, ACTIVATION)
  const slow = M.halving(chain, 0)
  assert.equal(slow.height, 1050000)
  assert.equal(slow.exact, true)
  assert.equal(fast.exact, false)
  assert.ok(fast.height > 1460000 && fast.height < 1475000)
  // The 1-minute halving block lands 9 minutes before the 10-minute one would.
  assert.equal(slow.eta - fast.eta, 540)
  assert.equal(fast.per10Next, 156250000)
})

test("average block time uses ticks across the activation boundary", () => {
  const ha = 332450
  const chain = { height: 333626, tipTime: 1794815685, tipMtp: 0, pastHeight: 331610, pastTime: 1794243785, activationHeight: ha }
  assert.equal(M.blockTime(M.avgBlockSeconds(chain)), "1m 00s")
})

test("parse rejects garbage and markup", () => {
  assert.equal(M.parse(""), null)
  assert.equal(M.parse("<img src=x>"), null)
  assert.equal(M.parse('{"height":"1e3"}'), null)
  const ok = M.parse('{"height":977585,"tipTime":1794815633,"tipMtp":1794812621,"pastHeight":975569,"pastTime":1793590805,"activationHeight":null,"server":"a","fetchedAt":1}')
  assert.equal(ok.height, 977585)
})

test("list is sorted by date and yearly dates roll over after their day", () => {
  const now = Date.UTC(2026, 10, 16, 8)
  const list = M.events(chainAt(now, {}), ACTIVATION, now)
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].time <= list[i].time)
  assert.equal(list[0].key, "genesis")
  // Lock-in was yesterday: it's next year's now.
  assert.equal(new Date(find(list, "lockin").time * 1000).getUTCFullYear(), 2027)
  const birthday = find(list, "birthday")
  assert.equal(birthday.detail, "10th anniversary")
  assert.equal(birthday.milestone, true)
})

test("a yearly date is 'today' for its whole local day", () => {
  const morning = new Date(2027, 0, 3, 0, 5).getTime()
  const late = new Date(2027, 0, 3, 23, 55).getTime()
  const after = new Date(2027, 0, 4, 0, 5).getTime()
  assert.equal(find(M.events(null, ACTIVATION, morning), "genesis").today, true)
  assert.equal(find(M.events(null, ACTIVATION, late), "genesis").today, true)
  const next = find(M.events(null, ACTIVATION, after), "genesis")
  assert.equal(next.today, false)
  assert.equal(next.detail, "Genesis turns 19")
})

test("the upgrade keeps its day after activating, then rolls over", () => {
  const before = Date.UTC(2027, 4, 15, 11)
  const activating = Date.UTC(2027, 4, 15, 12, 30)
  const done = Date.UTC(2027, 4, 15, 14)
  const nextDay = Date.UTC(2027, 4, 15, 22, 30) // 00:30 in Brussels
  let up = find(M.events(chainAt(before, {}), ACTIVATION, before), "upgrade")
  assert.equal(up.name, "1-minute blocks upgrade")
  assert.equal(up.today, true)
  up = find(M.events(chainAt(activating, {}), ACTIVATION, activating), "upgrade")
  assert.equal(up.detail, "activating…")
  up = find(M.events(chainAt(done, { tipMtp: done / 1000 - 3000, activationHeight: 1003535, height: 1003600 }), ACTIVATION, done), "upgrade")
  assert.equal(up.detail, "activated at block 1,003,535")
  up = find(M.events(chainAt(nextDay, { tipMtp: nextDay / 1000 - 3000, activationHeight: 1003535, height: 1004500 }), ACTIVATION, nextDay), "upgrade")
  assert.equal(up.name, "Network upgrade")
  assert.equal(new Date(up.time * 1000).getUTCFullYear(), 2028)
})

test("a halving stays for the rest of its day, then the next one shows", () => {
  const ha = 1003535
  const first = M.firstBlockOfEra(5, ha)
  const sameDay = Date.UTC(2028, 3, 2, 8)
  const nextDay = Date.UTC(2028, 3, 2, 22, 30)
  const halved = find(M.events(chainAt(sameDay, { height: first + 30, activationHeight: ha }), ACTIVATION, sameDay), "halved")
  assert.equal(halved.detail, "halved at block " + M.num(first))
  assert.equal(halved.today, true)
  const next = find(M.events(chainAt(nextDay, { height: first + 900, activationHeight: ha }), ACTIVATION, nextDay), "halving")
  assert.equal(next.name, "Halving #6")
})

test("formatting", () => {
  const now = Date.UTC(2026, 0, 1)
  assert.equal(M.leftText(now / 1000 + 365 * 86400 + 60, now, false), "1y")
  assert.equal(M.leftText(now / 1000 + 400 * 86400, now, false), "1y 35d")
  assert.equal(M.leftText(now / 1000 + 3 * 86400, now, false), "3d")
  assert.equal(M.leftText(now / 1000 + 5 * 3600, now, false), "5h")
  assert.equal(M.countdown(now / 1000 + 86400 + 3725, now), "1d 01h 02m 05s")
  assert.equal(M.num(1468176), "1,468,176")
  assert.equal(M.bch(15625000), "0.15625")
  assert.equal(M.ordinal(10), "10th")
  assert.equal(M.ordinal(21), "21st")
})
