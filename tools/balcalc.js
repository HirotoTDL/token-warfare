// バランス解析: 各キャラの武器DPS・エネルギー経済・実効HP・確定数(STK)・キルタイム(TTK)を算出。
// types.ts の数値を反映(手動同期)。node tools/balcalc.js
// 【2026-06-15 火力強化】プレイヤーTTKを平均約0.5秒へ。扱いやすい武器(高連射・長射程)ほどTTKは長め。
const ENERGY_MAX = 100, PASSIVE = 7
const REF_HP = 110 // 平均的な相手HP(キャラHPは95〜140、平均≈110)。確定数/KTの基準
const C = [
  { k: 'renji', hp: 115, dmg: 23, pel: 1, rate: 8, burst: 1, ecost: 3.2, peak: 1.0, close: 0.85, ease: '中射程/高連射', skill: 'dash -50%dmg 2s/移動' },
  // garo=チャージャー(プリズムレール)。dmg/rateはフル相当の代表値(rate=1/(chargeTime+fireRecover))。詳細はcharger欄+専用セクション参照。
  { k: 'garo', hp: 112, dmg: 125, pel: 1, rate: 0.73, burst: 1, ecost: 0, peak: 1.0, close: 0.2, ease: 'チャージ式/フルは超長射程1撃', skill: 'dome -60%dmg 2.5s',
    charger: { chargeTime: 1.15, minFrac: 0.2, fireRecover: 0.22, holdTime: 0.9, minDamage: 16, maxDamage: 125, minSpeed: 130, maxSpeed: 300, minRange: 24, maxRange: 200 } },
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
  if (c.charger) {
    // チャージャー: フル溜め(chargeTime)で1撃。KTは溜め時間=必中前提の理論値。
    const kt = +c.charger.chargeTime.toFixed(2)
    ktSum += kt; ktN++
    console.log(c.k.padEnd(7), '1撃(フル溜)'.padEnd(8), String(kt).padStart(5), '  ', c.ease)
    continue
  }
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

// === トークン破壊時間(プレイヤーがトークンを壊すのに要する秒) ===
// 目標(ユーザー指定): トークンを壊すのに「平均1.5秒ほど」。プレイヤーの弾はトークンに全ダメージが入る
// (対トークン軽減は無い=combat側で確認)。破壊時間 = tokenHP / 撃つ側の peakDPS(有効射程の100%命中、TTKと同基準)。
// HPは src/tokens.ts のコンストラクタ実値(手動同期)。役割でHPを意図的に差別化している(脆い罠/重い壁等)。
// ret = トークン自身の反撃DPS(撃ち返す砲台/壁等。tokens.tsの fireBoltAt 実値: dmg/fireCd)。
// structure=true は迎撃砲台/壁などの防衛構造物=役割上タンク。1.5s目標(汎用トークン)の対象外。
const TOKENS = [
  { k: 'gunner', hp: 145, role: '占領供給', std: true, ret: 7 / 0.5 },        // 14DPS(対将は4.9)
  { k: 'striker', hp: 133, role: '突撃', std: true },
  { k: 'chaser', hp: 133, role: '追尾', std: true },
  { k: 'decoy', hp: 160, role: 'おとり', std: true },
  { k: 'jammer', hp: 182, role: '妨害(中)', std: false },
  { k: 'booster', hp: 213, role: '支援(やや重)', std: false },
  { k: 'bomber', hp: 236, role: '範囲(やや重)', std: false },
  { k: 'healer', hp: 105, role: '回復(脆)', std: false },
  { k: 'mine', hp: 80, role: '罠(脆・使い捨て)', std: false },
  { k: 'sniperdrone', hp: 91, role: '狙撃(脆)', std: false, ret: 18 / 1.7 }, // 10.6DPS
  // 防衛構造物(撃ち返す/射線を塞ぐ)。汎用1.5s目標の対象外でタンク。#43で一律削減したのを役割相応へ復帰(2026-06-16)。
  { k: 'sentry', hp: 400, role: '迎撃砲台(重・反撃)', std: false, structure: true, ret: 5 / 0.16 }, // 31.3DPSで撃ち返す
  { k: 'wallpod', hp: 520, role: '壁(最重・射線封鎖)', std: false, structure: true, ret: 24 / 2.0 }, // 12DPS
]
const peakById = Object.fromEntries(rows.map((r) => [r.k, r.peakDPS]))
const TOKEN_DESTROY_TARGET = 1.5
console.log(`\n=== トークン破壊時間 ===`)
console.log('※「破壊時間 = HP ÷ peakDPS」は【理論下限】: 全弾命中・ピーク射程・エネルギー無限・反撃も遮蔽も無視。')
console.log('  実戦では命中率<100%・距離減衰・そして反撃トークン(retDPS)は遮蔽を強いるため、実破壊時間は下限の何倍にもなる。')
console.log('  特に迎撃砲台/壁などの防衛構造物(structure)は「正面から数秒で割れる」ことはなく、1.5s目標の対象外=タンク。')
console.log('')
console.log('token         HP  最速  平均  最遅  反撃DPS 役割')
let stdSum = 0, stdN = 0
for (const tk of TOKENS) {
  const times = C.map((c) => tk.hp / peakById[c.k]) // 各武器の理論下限破壊秒
  const min = Math.min(...times), max = Math.max(...times), avg = times.reduce((a, b) => a + b, 0) / times.length
  if (tk.std) { stdSum += avg; stdN++ }
  const retStr = tk.ret ? `${tk.ret.toFixed(0).padStart(4)}  ` : '  -   '
  console.log(
    (tk.std ? '*' : tk.structure ? '#' : ' ') + tk.k.padEnd(12), String(tk.hp).padStart(3),
    min.toFixed(2).padStart(5), avg.toFixed(2).padStart(5), max.toFixed(2).padStart(5), retStr, tk.role,
  )
}
console.log(`\n汎用トークン(*=gunner/striker/chaser/decoy)の理論下限・平均 = ${(stdSum / stdN).toFixed(2)}s  (目標 約${TOKEN_DESTROY_TARGET}s ← ユーザー指定の「平均1.5s」はこの汎用群に適用)`)
console.log('#=防衛構造物(sentry/wallpod): 役割上タンク。反撃で遮蔽を強いるため理論下限すら実戦値ではない。1.5s目標から除外。')
// 反撃を持つ構造物を「正面から削る」際に攻撃側が被る理論ダメージ(=正面突破のコスト)。
console.log('\n--- 防衛構造物を正面から削る代償(理論下限時間×反撃DPS=最低でも被るダメージ) ---')
for (const tk of TOKENS.filter((t) => t.structure)) {
  const avgFloor = C.reduce((a, c) => a + tk.hp / peakById[c.k], 0) / C.length
  const fastFloor = tk.hp / Math.max(...C.map((c) => peakById[c.k]))
  console.log(`${tk.k.padEnd(8)} 理論下限 最速${fastFloor.toFixed(1)}s/平均${avgFloor.toFixed(1)}s、その間に反撃で被弾 ≈ ${(avgFloor * tk.ret).toFixed(0)}dmg(平均) — 正面ソロ撃破は非現実的。遮蔽/横取り/チャージャー(garo)等で対処する設計。`)
}

// === チャージャー(garo / プリズムレール)詳細 ===
// スプラトゥーン チャージャー型: トリガー押下で溜め、溜め量fracで威力/弾速/射程が min→max。
// フル(frac=1)は超長距離の1撃。溜め時間(chargeTime)がコスト=高リスク高リターンの狙撃。
const garo = C.find((c) => c.charger)
if (garo) {
  const cd = garo.charger
  const lerp = (a, b, t) => a + (b - a) * t
  const at = (frac) => {
    const f = Math.max(cd.minFrac, Math.min(1, frac))
    const t = (f - cd.minFrac) / (1 - cd.minFrac)
    return { frac: f, dmg: lerp(cd.minDamage, cd.maxDamage, t), spd: lerp(cd.minSpeed, cd.maxSpeed, t), rng: lerp(cd.minRange, cd.maxRange, t) }
  }
  console.log(`\n=== チャージャー詳細(garo / プリズムレール) ===`)
  console.log(`溜め時間 0→フル=${cd.chargeTime}s / 発射後硬直=${cd.fireRecover}s / フル維持=${cd.holdTime}s(超過で自動放電)`)
  console.log('frac   威力   弾速   射程(m)  到達時間(射程÷弾速)')
  for (const fr of [cd.minFrac, 0.5, 0.75, 1.0]) {
    const a = at(fr)
    console.log(`${a.frac.toFixed(2).padStart(4)}  ${a.dmg.toFixed(0).padStart(4)}  ${a.spd.toFixed(0).padStart(5)}  ${a.rng.toFixed(0).padStart(6)}   ${(a.rng / a.spd).toFixed(2)}s`)
  }
  const full = at(1)
  const oneShotList = C.filter((c) => c.hp <= full.dmg).map((c) => `${c.k}(${c.hp})`)
  const surviveList = C.filter((c) => c.hp > full.dmg).map((c) => `${c.k}(${c.hp})`)
  console.log(`フル(${full.dmg.toFixed(0)})で1撃確殺: ${oneShotList.join(', ')}`)
  console.log(`フルでも耐える: ${surviveList.length ? surviveList.join(', ') : 'なし(全員1撃圏内)'}`)
  console.log(`フルチャージKT(溜め必中前提) ≈ ${cd.chargeTime}s。平均TTK(${(ktSum / ktN).toFixed(2)}s)より遅い=溜めコストで火力を相殺。`)
  console.log(`近接(frac=${cd.minFrac})威力 ${cd.minDamage} は弱く、間合いを詰められると不利=明確なカウンター(接近)が成立。`)
}
