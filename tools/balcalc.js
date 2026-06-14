// バランス解析: 各キャラの武器DPS・エネルギー経済・実効HPを算出して崩れを可視化する。
// types.ts の数値を反映(手動同期)。node tools/balcalc.js
const ENERGY_MAX = 100, PASSIVE = 7
const C = [
  { k: 'renji', hp: 115, dmg: 11, pel: 1, rate: 8, burst: 1, ecost: 3.2, peak: 1.0, close: 0.85, skill: 'dash -50%dmg 2s/移動' },
  { k: 'garo', hp: 140, dmg: 7, pel: 6, rate: 1.6, burst: 1, ecost: 12, peak: 1.3, close: 1.3, skill: 'dome -60%dmg 2.5s' },
  { k: 'jin', hp: 95, dmg: 50, pel: 1, rate: 0.82, burst: 1, ecost: 17, peak: 1.2, close: 0.45, skill: 'cloak 4s' },
  { k: 'doku', hp: 110, dmg: 6.5, pel: 1, rate: 11, burst: 1, ecost: 2.4, peak: 1.1, close: 1.1, skill: 'heal30' },
  { k: 'mimi', hp: 108, dmg: 4.4, pel: 2, rate: 9, burst: 1, ecost: 2.5, peak: 1.1, close: 1.1, skill: 'overdrive rate+60%/燃費半減 2.5s' },
  { k: 'nanase', hp: 120, dmg: 30, pel: 1, rate: 1.1, burst: 1, ecost: 15, peak: 1.0, close: 0.8, skill: 'beatdrop 35AOE+armor', aoe: 2.6 },
  { k: 'riko', hp: 105, dmg: 9, pel: 1, rate: 2.8, burst: 3, ecost: 7.5, peak: 1.0, close: 0.9, skill: 'decoy 1.5s' },
  { k: 'yume', hp: 100, dmg: 10.5, pel: 1, rate: 6, burst: 1, ecost: 3.1, peak: 1.0, close: 0.7, skill: 'sonar 4s' },
]
function row(c) {
  const shotsPerTrigger = c.pel * c.burst
  const triggerDmg = c.dmg * shotsPerTrigger
  const burstDPS = triggerDmg * c.rate * c.peak
  const closeDPS = triggerDmg * c.rate * c.close
  const drain = c.ecost * c.rate            // エネルギー/秒
  const timeToEmpty = ENERGY_MAX / drain    // 全力射撃の持続秒
  const sustTrig = PASSIVE / c.ecost        // 持続可能トリガ/秒
  const sustDPS = triggerDmg * sustTrig * c.peak
  const burstWindowDmg = burstDPS * timeToEmpty // 1チャージ分の総ダメージ
  return { k: c.k, hp: c.hp, peakDPS: +burstDPS.toFixed(0), closeDPS: +closeDPS.toFixed(0), sustDPS: +sustDPS.toFixed(0), emptySec: +timeToEmpty.toFixed(1), burstDmg: +burstWindowDmg.toFixed(0), skill: c.skill }
}
const rows = C.map(row)
console.log('=== 武器DPS / エネルギー経済 / HP ===')
console.log('char    HP  peakDPS closeDPS sustDPS  empty(s) 1charge総ダメ  skill')
for (const r of rows.sort((a, b) => b.peakDPS - a.peakDPS)) {
  console.log(
    r.k.padEnd(7), String(r.hp).padStart(3), String(r.peakDPS).padStart(7), String(r.closeDPS).padStart(8),
    String(r.sustDPS).padStart(7), String(r.emptySec).padStart(7), String(r.burstDmg).padStart(11), ' ', r.skill,
  )
}
// TTK: 相手HPを peakDPS で割る(理想・命中100%)
console.log('\n=== 理想TTK(命中100%, peak距離) 相手HP100/120/140 ===')
for (const r of rows) {
  console.log(r.k.padEnd(7), 'vs100:', (100 / r.peakDPS).toFixed(2) + 's', ' vs120:', (120 / r.peakDPS).toFixed(2) + 's', ' vs140:', (140 / r.peakDPS).toFixed(2) + 's')
}
