// バランス解析: 各キャラの武器DPS・エネルギー経済・実効HP・確定数(STK)・キルタイム(TTK)を算出。
// types.ts の数値を反映(手動同期)。node tools/balcalc.js
// 【2026-06-15 火力強化】プレイヤーTTKを平均約0.5秒へ。扱いやすい武器(高連射・長射程)ほどTTKは長め。
const ENERGY_MAX = 100, PASSIVE = 7
const REF_HP = 110 // 平均的な相手HP(キャラHPは95〜140、平均≈110)。確定数/KTの基準
const C = [
  { k: 'renji', hp: 115, dmg: 23, pel: 1, rate: 8, burst: 1, ecost: 3.2, peak: 1.0, close: 0.85, ease: '中射程/高連射', skill: 'dash -50%dmg 2s/移動' },
  { k: 'garo', hp: 140, dmg: 13, pel: 6, rate: 1.6, burst: 1, ecost: 12, peak: 1.0, close: 1.3, ease: '近射程/低連射', skill: 'dome -60%dmg 2.5s' },
  { k: 'jin', hp: 95, dmg: 90, pel: 1, rate: 0.82, burst: 1, ecost: 17, peak: 1.2, close: 0.45, ease: '遠射程/最低連射', skill: 'cloak 4s' },
  { k: 'doku', hp: 110, dmg: 13, pel: 1, rate: 11, burst: 1, ecost: 2.4, peak: 1.0, close: 1.1, ease: '中射程/最高連射', skill: 'heal30' },
  { k: 'mimi', hp: 108, dmg: 10, pel: 2, rate: 9, burst: 1, ecost: 2.5, peak: 1.0, close: 1.1, ease: '近中射程/高連射', skill: 'overdrive rate+60%/燃費半減 2.5s' },
  { k: 'nanase', hp: 120, dmg: 60, pel: 1, rate: 1.1, burst: 1, ecost: 15, peak: 1.0, close: 0.8, ease: '遠射程(曲射)/低連射', skill: 'beatdrop 35AOE+armor', aoe: 2.6 },
  { k: 'riko', hp: 105, dmg: 19, pel: 1, rate: 2.8, burst: 3, ecost: 7.5, peak: 1.0, close: 0.9, ease: '中遠射程/3点バースト', skill: 'decoy 1.5s', burstInterval: 0.07 },
  { k: 'yume', hp: 100, dmg: 23, pel: 1, rate: 6, burst: 1, ecost: 3.1, peak: 1.0, close: 0.7, ease: '遠射程/中高連射', skill: 'sonar 4s' },
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
// 確定数(STK)とキルタイム(TTK): peak距離で命中100%。triggerは pel発を同時+burst発を burstInterval間隔で発射。
function ttk(c, targetHp) {
  const perShot = c.dmg * c.peak                 // 1ボルトの威力(pelは同時発射なので束で当たる前提)
  const perTrigger = perShot * c.pel             // 1トリガが束で与える威力(burst内の1発分)
  // 1トリガ内に pel*burst 発。burst weapon は perTrigger を burst 回(間隔burstInterval)出す
  const stkShots = Math.ceil(targetHp / perShot) // 必要ボルト数(個別)
  const stkTriggers = Math.ceil(targetHp / (perTrigger * c.burst)) // 必要トリガ数(束・バースト込み)
  // キルタイム: stkTriggers-1 回のトリガ間隔 + (バーストなら最後のトリガ内で必要なburst番目までの時間)
  const triggerInterval = 1 / c.rate
  let kt = (stkTriggers - 1) * triggerInterval
  if (c.burst > 1) {
    // 最後のトリガで何発目で倒れるか(直近トリガまでの累積を引く)
    const dealtBefore = (stkTriggers - 1) * perTrigger * c.burst
    const need = Math.max(1, Math.ceil((targetHp - dealtBefore) / perTrigger))
    kt += (Math.min(need, c.burst) - 1) * (c.burstInterval || 0)
  }
  return { stkShots, stkTriggers, kt: +kt.toFixed(2) }
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
// 確定数 + キルタイム(対 REF_HP=110)。扱いやすい武器ほどKTが長い設計か検証
console.log(`\n=== 確定数(STK) / キルタイム(TTK) 対HP${REF_HP} ===`)
console.log('char    確定発  KT(s)   扱いやすさ')
let ktSum = 0, ktN = 0
for (const c of C) {
  const t = ttk(c, REF_HP)
  ktSum += t.kt; ktN++
  const stkLabel = c.burst > 1 ? `${t.stkTriggers}バースト(${t.stkTriggers * c.burst}発)` : `${t.stkTriggers}発`
  console.log(c.k.padEnd(7), stkLabel.padEnd(8), String(t.kt).padStart(5), '  ', c.ease)
}
console.log(`\n平均KT(対HP${REF_HP}) = ${(ktSum / ktN).toFixed(2)}s  (目標: 平均0.5秒程度。扱いやすい武器ほど長め)`)
// 各キャラ実HPに対するTTK表(マッチアップ感)
console.log('\n=== TTK実HPマトリクス(行=撃つ側, 列=相手の実HP) ===')
const targets = C.map((c) => c.k)
console.log('       ', targets.map((t) => t.padStart(7)).join(''))
for (const a of C) {
  const cells = C.map((b) => ttk(a, b.hp).kt.toFixed(2).padStart(7)).join('')
  console.log(a.k.padEnd(7), cells)
}
// スフィア占領(武器非依存・固定レート)
const CAPTURE_RATE = 0.18, CAP_THRESHOLD = 0.55
console.log(`\n=== スフィア占領(武器非依存) ===`)
console.log(`占領レート ${CAPTURE_RATE}/s → 0→占領(${CAP_THRESHOLD}) = ${(CAP_THRESHOLD / CAPTURE_RATE).toFixed(1)}s (全武器一律)`)
console.log(`敵陣(charge -1)を奪う: -1→+${CAP_THRESHOLD} = ${((1 + CAP_THRESHOLD) / CAPTURE_RATE).toFixed(1)}s (相殺・ペナルティ除く理論値)`)
