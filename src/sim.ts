import * as THREE from 'three'
import { World } from './world'
import { Effects, Combat } from './combat'
import { Sfx } from './sfx'
import { buildArena } from './arena'
import { BotCommander, botParams } from './bot'
import { Objectives } from './objectives'
import {
  CHARACTERS, characterByKey,
  MATCH_TIME, OVERTIME_AT, RESPAWN_TIME, RESPAWN_INVULN,
  TP_MOMENTUM_MUL, CORE_TP, SMALL_CORE_TP,
  type Team,
} from './types'

/**
 * バランス検証用: ボット同士の高速ヘッドレス対戦。
 * レンダリングせずに固定タイムステップで3分マッチを回し、スコアを返す。
 * コンソールから __tw.sim('renji', 'jin') / __tw.simMatrix() で使う。
 */
export interface SimResult {
  a: string
  b: string
  scoreA: number
  scoreB: number
  dmgA: number
  dmgB: number
}

export function simulateMatch(aKey: string, bKey: string, level = 6, matchTime = MATCH_TIME, mapKey = 'skyhaven'): SimResult {
  const world = new World()
  buildArena(world, mapKey, true) // lite: 装飾を省きコライダー/コア地点のみ(高速化)
  const sfx = new Sfx() // unlockしない=無音
  const fx = new Effects(world.scene)
  const combat = new Combat(world, fx, sfx)
  const botA = new BotCommander(world, combat, sfx, characterByKey(aKey), world.basePos.blue.clone(), botParams(level), 'blue')
  const botB = new BotCommander(world, combat, sfx, characterByKey(bKey), world.basePos.red.clone(), botParams(level), 'red')
  world.addUnit(botA)
  world.addUnit(botB)

  // ゾーン制圧目標(占領モードの計測)
  const objectives = new Objectives(world.scene, new THREE.Vector3(0, 3, 0), world.basePos)
  world.objectives = objectives

  const scores: Record<Team, number> = { blue: 0, red: 0 }
  const dmg: Record<Team, number> = { blue: 0, red: 0 }
  const respawnT: Partial<Record<Team, number>> = {}

  const dropCore = (pos: THREE.Vector3, small: boolean) => {
    pos.y = 0
    world.cores.push({ pos, mesh: new THREE.Group(), tp: small ? SMALL_CORE_TP : CORE_TP, small, life: small ? 20 : Infinity })
  }

  world.onKill = (victim, killer) => {
    if (victim.isCommander) {
      scores[victim.team === 'blue' ? 'red' : 'blue']++
      respawnT[victim.team] = RESPAWN_TIME
    } else if (victim.kind !== 'decoy') {
      dropCore(victim.group.position.clone(), true)
    }
  }
  world.onDamage = (_victim, attacker) => {
    if (attacker === botA) dmg.blue++
    if (attacker === botB) dmg.red++
  }

  let coreT = 4
  let timer = matchTime
  const dt = 1 / 30

  while (timer > 0) {
    timer -= dt
    const ot = timer <= OVERTIME_AT
    coreT -= dt
    if (coreT <= 0) {
      coreT = ot ? 6 : 12
      if (world.cores.filter((c) => !c.small).length < 4 && world.coreSpots.length) {
        const s = world.coreSpots[Math.floor(Math.random() * world.coreSpots.length)]
        dropCore(s.clone(), false)
      }
    }
    botA.tpRegenMul = (scores.blue < scores.red ? TP_MOMENTUM_MUL : 1) * (ot ? 2 : 1)
    botB.tpRegenMul = (scores.red < scores.blue ? TP_MOMENTUM_MUL : 1) * (ot ? 2 : 1)

    for (const team of ['blue', 'red'] as Team[]) {
      const t = respawnT[team]
      if (t === undefined) continue
      const next = t - dt
      if (next <= 0) {
        delete respawnT[team]
        ;(team === 'blue' ? botA : botB).respawn(world.basePos[team].clone(), RESPAWN_INVULN)
      } else {
        respawnT[team] = next
      }
    }

    for (const core of [...world.cores]) {
      if (core.life !== Infinity) {
        core.life -= dt
        if (core.life <= 0) {
          world.cores.splice(world.cores.indexOf(core), 1)
          continue
        }
      }
      for (const bot of [botA, botB]) {
        if (!bot.alive) continue
        const dx = bot.group.position.x - core.pos.x
        const dz = bot.group.position.z - core.pos.z
        if (dx * dx + dz * dz < 2) {
          bot.tp = Math.min(100, bot.tp + core.tp)
          world.cores.splice(world.cores.indexOf(core), 1)
          break
        }
      }
    }

    for (const u of [...world.units]) u.update(dt)
    combat.update(dt)
    fx.update(dt)
    objectives.update(dt)
    world.revealT.blue = Math.max(0, world.revealT.blue - dt)
    world.revealT.red = Math.max(0, world.revealT.red - dt)
    if (objectives.winner) break // 30カウント到達=ノックアウト
  }

  // 後始末(GPU未使用だがジオメトリは解放)
  world.scene.traverse((o) => {
    const m = o as THREE.Mesh
    m.geometry?.dispose?.()
    const mt = m.material as THREE.Material | THREE.Material[] | undefined
    for (const x of Array.isArray(mt) ? mt : mt ? [mt] : []) {
      ;(x as THREE.MeshStandardMaterial).map?.dispose?.()
      x.dispose()
    }
  })

  // 占領モード: スコア=占領カウント(キル数dmgは参考スタット)
  void scores
  return { a: aKey, b: bKey, scoreA: Math.floor(objectives.count.blue), scoreB: Math.floor(objectives.count.red), dmgA: Math.round(dmg.blue), dmgB: Math.round(dmg.red) }
}

/** 全キャラ総当たり(片側ずつ)。重いのでawaitしながら回す */
export async function simulateMatrix(level = 6, onProgress?: (done: number, total: number) => void): Promise<SimResult[]> {
  const keys = CHARACTERS.map((c) => c.key)
  const pairs: [string, string][] = []
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) pairs.push([keys[i], keys[j]])
  }
  const results: SimResult[] = []
  let done = 0
  for (const [a, b] of pairs) {
    results.push(simulateMatch(a, b, level))
    done++
    onProgress?.(done, pairs.length)
    await new Promise((r) => setTimeout(r, 0)) // UIを固めない
  }
  return results
}

/** 結果からキャラ別勝ち点(勝2/分1/負0)とスコア合計を集計 */
export function summarize(results: SimResult[]) {
  const table: Record<string, { pts: number; kills: number; deaths: number }> = {}
  for (const c of CHARACTERS) table[c.key] = { pts: 0, kills: 0, deaths: 0 }
  for (const r of results) {
    table[r.a].kills += r.scoreA
    table[r.a].deaths += r.scoreB
    table[r.b].kills += r.scoreB
    table[r.b].deaths += r.scoreA
    if (r.scoreA > r.scoreB) table[r.a].pts += 2
    else if (r.scoreB > r.scoreA) table[r.b].pts += 2
    else {
      table[r.a].pts += 1
      table[r.b].pts += 1
    }
  }
  return table
}
