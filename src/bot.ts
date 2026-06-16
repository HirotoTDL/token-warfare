import * as THREE from 'three'
import { World } from './world'
import { Combat } from './combat'
import { Sfx } from './sfx'
import { TEAM_COLOR, ENERGY_MAX, TP_REGEN_BASE, INVULN_ON_FIRE, enemyOf, falloffMul, type CharacterDef, type Team, type Unit } from './types'
import { TOKENS, DecoyUnit, loadoutFor } from './tokens'
import { buildMonsterCommander } from './models'
import { getModel, animateGlbBody, animateSkeleton } from './modelLoader'
import { chargeShotParams } from './chargeWeapon'

// ジャンプ垂直物理(player.tsと同値)。ボットも段差/塔/障害物をジャンプで越えられるようにする。
const BOT_GRAVITY = 20
const BOT_FALL_MULT = 1.7
const BOT_JUMP_VEL = 7.8

function flatDist(a: THREE.Vector3, b: THREE.Vector3) {
  const dx = a.x - b.x
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dz * dz)
}

function lerpAngle(a: number, b: number, t: number) {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return a + d * Math.min(1, t)
}

/** 角度を [-π, π] に正規化 */
function wrapAngle(x: number) {
  let d = x % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return d
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

/** ボット難易度パラメータ(練習Lv1〜10。対戦モードはLv6) */
export interface BotParams {
  level: number
  spread: number
  thinkT: number
  deployMin: number
  deployMax: number
  dmgMul: number
  burstPause: number
  lead: boolean
  tpMul: number
  coreSeek: boolean
  reaction: number
  /** 新規ターゲット捕捉時のエイム誤差(人間らしい照準合わせ) */
  aimErrInit: number
  /** エイム誤差の収束速度(/s) */
  aimErrDecay: number
  /** 戦略深度0..1: 高いほど勝敗状況(リード差)・係争・占領を読んで効用最適化する。低Lvは素朴(占領寄りだが適応弱め) */
  strategyDepth: number
}

export function botParams(level: number): BotParams {
  const lv = Math.max(1, Math.min(10, level))
  const t = (lv - 1) / 9
  return {
    level: lv,
    spread: lerp(0.13, 0.018, t),
    thinkT: lerp(3.6, 1.6, t),
    deployMin: lerp(14, 5, t),
    deployMax: lerp(19, 8, t),
    dmgMul: lerp(0.5, 1.05, t),
    burstPause: lerp(1.8, 0.7, t),
    lead: lv >= 7,
    tpMul: lerp(0.6, 1.2, t),
    coreSeek: lv >= 3,
    reaction: lerp(0.9, 0.35, t),
    aimErrInit: lerp(0.3, 0.05, t),
    aimErrDecay: lerp(0.18, 0.55, t),
    strategyDepth: lerp(0.15, 1.0, t), // 低Lv=ほぼ素朴, 高Lv=勝敗/係争を読む最適戦略
  }
}

/** CPU将(シェイプリンガー)。通常は赤軍だが、シミュレーション用に青軍も可 */
export class BotCommander implements Unit {
  id: number
  team: Team
  kind = 'commander'
  name: string
  hp: number
  maxHp: number
  alive = true
  isCommander = true
  stealthed = false
  group: THREE.Group
  hitMeshes: THREE.Mesh[] = []
  radius = 0.45
  height = 1.8

  char: CharacterDef
  tp = 50
  tpRegenMul = 1
  energy = ENERGY_MAX
  invulnT = 0
  params: BotParams

  private world: World
  private combat: Combat
  private sfx: Sfx
  private muzzle: THREE.Object3D

  private thinkT = 1
  private moveTarget: THREE.Vector3 | null = null
  private path: THREE.Vector3[] | null = null
  private pi = 0
  private retargetT = 0
  private target: Unit | null = null
  private capturing = false // 占領射撃中(至近の優先スフィアを撃って確保中)。この間は間合い戦闘の足止めを抑止しスフィアを保持
  private burstLeft = 0
  private burstCd = 1.5
  private fireT = 0
  private chargeT = 0 // チャージ武器の溜め経過秒(garo等)
  private deployT = 6
  private skillCd = 3
  private skillActiveT = 0
  private armorT = 0
  private dashT = 0
  private dashDir = new THREE.Vector3()
  private strafeDir = 1
  private strafeT = 0
  // 垂直移動(ジャンプ/重力/着地)。プレイヤー同様の物理をボットにも持たせ、段差・塔・障害物を飛び越えられるようにする。
  private velY = 0
  private onGround = true
  private wantJump = false // このフレームでジャンプ踏み切りを要求(AIロジックが立てる)
  private jumpCd = 0 // 連続ジャンプ抑制
  private stuckT = 0 // 移動先へ進めていない時間(詰まり検出→ジャンプで越える)
  private stuckRef = new THREE.Vector3()
  private regenDelay = 0
  private lastDamaged = 999
  private lastSawPlayer = 0
  private walkT = 0
  private charging = false
  private prevTargetPos = new THREE.Vector3()
  private targetVel = new THREE.Vector3()
  private _acqTgt = new THREE.Vector3() // acquireTargetの敵ごとLOS判定用スクラッチ(per-enemy cloneを回避)
  private aimErr = 0
  private aimYaw = 0 // 上体エイムの残差ヨー(胴体facing後の頭/胸の向き調整)
  private aimPitch = 0 // 上体エイムのピッチ(狙いの上下。+で標的が上)

  private flashPairs: { m: THREE.MeshStandardMaterial; color: number; intensity: number }[] = []
  private flashT = 0
  private stealthMats: { m: THREE.Material; opacity: number }[] = []

  constructor(world: World, combat: Combat, sfx: Sfx, char: CharacterDef, spawn: THREE.Vector3, params: BotParams, team: Team = 'red') {
    this.world = world
    this.combat = combat
    this.sfx = sfx
    this.char = char
    this.params = params
    this.team = team
    this.id = world.allocId()
    this.name = char.name
    this.hp = this.maxHp = char.hp
    this.group = getModel(`char_${char.key}`, team) ?? buildMonsterCommander(char, team)
    this.group.position.copy(spawn)
    this.group.rotation.y = Math.atan2(-spawn.x, -spawn.z) + Math.PI // 中央(敵方向)へ前面を向ける
    this.muzzle = this.group.userData.muzzle as THREE.Object3D
    this.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) this.hitMeshes.push(o as THREE.Mesh)
    })
    const mats = (this.group.userData.mats as THREE.MeshStandardMaterial[]) ?? []
    for (const m of mats) {
      this.flashPairs.push({ m, color: m.emissive.getHex(), intensity: m.emissiveIntensity })
      this.stealthMats.push({ m, opacity: m.opacity })
    }
  }

  respawn(spawn: THREE.Vector3, invuln: number) {
    this.group.position.copy(spawn)
    this.group.visible = true
    this.hp = this.maxHp
    this.energy = ENERGY_MAX
    this.alive = true
    this.stealthed = false
    this.setStealthVisual(false)
    this.skillActiveT = 0
    this.invulnT = invuln
    this.regenDelay = 0
    this.charging = false
    this.chargeT = 0
    this.moveTarget = null
    this.path = null
    this.target = null
    this.thinkT = 0.5
    this.group.updateMatrixWorld()
  }

  update(dt: number) {
    if (!this.alive) return
    this.invulnT = Math.max(0, this.invulnT - dt)
    this.lastDamaged += dt
    this.lastSawPlayer += dt
    this.thinkT -= dt
    this.retargetT -= dt
    this.deployT -= dt
    this.skillCd = Math.max(0, this.skillCd - dt)
    this.armorT = Math.max(0, this.armorT - dt)
    this.walkT += dt
    this.updateFlash(dt)

    if (this.skillActiveT > 0) {
      this.skillActiveT -= dt
      if (this.skillActiveT <= 0 && (this.char.skill.key === 'cloak' || this.char.skill.key === 'decoy')) {
        this.setStealth(false)
      }
    }

    // エネルギー管理: 切れたらチャージ(射撃停止+鈍足=隙)。
    // チャージ武器(garo)はエネルギー制を使わず this.charging を「溜め中スロー」フラグとして chargerCombat が占有するため除外。
    if (!this.char.weapon.charger) {
      if (this.charging) {
        this.energy = Math.min(ENERGY_MAX, this.energy + 55 * dt)
        if (this.energy > 65) this.charging = false
      } else if (this.energy < this.char.weapon.energyCost) {
        this.charging = true
        this.retreatToCover() // 無防備な間は遮蔽裏へ下がる
      } else if (this.lastDamaged > 1.5) {
        this.energy = Math.min(ENERGY_MAX, this.energy + 7 * dt)
      }
    }

    // エイム誤差の収束
    this.aimErr = Math.max(0, this.aimErr - this.params.aimErrDecay * dt)

    if (this.thinkT <= 0) {
      this.thinkT = this.params.thinkT * (0.85 + Math.random() * 0.3)
      this.think()
    }
    if (this.retargetT <= 0) {
      this.retargetT = this.params.reaction
      this.acquireTarget()
    }

    this.combatUpdate(dt)
    this.moveUpdate(dt)
    // 詰まり検出→ジャンプで越える: 移動先が遠いのに進めていない(障害物/段差/塔)なら踏み切る。
    this.stuckT += dt
    if (this.stuckT >= 0.3) {
      const moved = flatDist(this.group.position, this.stuckRef)
      const farTarget = this.moveTarget != null && flatDist(this.moveTarget, this.group.position) > 2
      if (this.onGround && farTarget && moved < 0.22) this.wantJump = true
      this.stuckRef.copy(this.group.position)
      this.stuckT = 0
    }
    this.verticalUpdate(dt) // ジャンプ/重力/着地(段差・塔・障害物越え)。moveUpdate(水平)の後に縦を解く。
    this.deployUpdate()
    this.skillUpdate()

    if (this.regenDelay > 0) this.regenDelay -= dt
    else this.hp = Math.min(this.maxHp, this.hp + 8 * dt)
    this.tp = Math.min(100, this.tp + TP_REGEN_BASE * this.params.tpMul * this.tpRegenMul * dt)

    this.updateWalkAnim(dt)
    this.group.updateMatrixWorld()
  }

  private eye() {
    const e = this.group.position.clone()
    e.y += 1.45
    return e
  }

  // ── 効用ベース戦略AI(移動先=どの行動が今いちばん勝利に資するかをスコア化して最高を選ぶ) ──
  // 戦闘(acquireTarget/combatUpdate/shoot)は別系統で常時並行=「目標へ動きながら見える敵を撃つ」。
  // 勝利条件=中央＋敵陣スフィアを確保した間カウント加算。リード差(count差)で攻守の重みを切替えるのが最適性の核。
  private think() {
    const player = this.world.commanderOf(enemyOf(this.team))
    if (!player || !player.alive) return
    const cps = this.world.coverPoints
    if (!cps.length) return
    const o = this.world.objectives
    const me = this.team
    const low = this.hp < this.maxHp * 0.4
    const sd = this.params.strategyDepth // 0..1 戦略深度(低Lv=適応弱め)

    // 勝敗状況: リードしている間は確保した盤面を防衛、ビハインドでは敵スフィアへ攻勢(attacker-defenderメタの定石)。
    // 戦略深度sdが高いほど強く適応する。
    const lead = o ? o.count[me] - o.count[enemyOf(me)] : 0
    const ladj = sd * Math.min(1, Math.abs(lead) / 4)
    const wCapture = 1 + (lead < 0 ? 0.4 : -0.3) * ladj
    const wDefend = 1 + (lead > 0 ? 0.4 : -0.3) * ladj

    const center = o ? o.center.pos : new THREE.Vector3()
    // スフィアへの接近位置: スフィアにLOSが通る最寄りのカバー点を優先する(中央スフィアは構造物が地上の射線を
    // 完全に遮るため、高所等のLOSが通るカバー点からでないと占領できない)。無ければ幾何的に中央寄り6m
    // (=敵スフィアの奥=敵スポーンに張り付かない/リスキル回避)へフォールバック。
    const losEye = new THREE.Vector3()
    const approach = (sp: { pos: THREE.Vector3 }, isCenter: boolean): THREE.Vector3 => {
      // スフィア近傍(≤14m)でLOSが通るカバー点のうち、ボットに最も近い=到達しやすい点を選ぶ
      // (中央は地上の射線が構造物に遮られるが、LOSが通る地上カバー点が数点あるのでそこに立って撃つ)。
      let best: THREE.Vector3 | null = null, bd = Infinity
      for (const cp of this.world.coverPoints) {
        const d = flatDist(cp, sp.pos)
        if (d > 14 || d < 2) continue
        losEye.set(cp.x, cp.y + 1.45, cp.z)
        if (!this.world.hasLOS(losEye, sp.pos)) continue
        const dSelf = flatDist(cp, this.group.position)
        if (dSelf < bd) { bd = dSelf; best = cp }
      }
      if (best) return best.clone()
      const toward = isCenter ? this.group.position : center
      const dir = toward.clone().sub(sp.pos).setY(0)
      if (dir.lengthSq() < 1) dir.set(0, 0, me === 'blue' ? 1 : -1)
      return sp.pos.clone().setY(0).addScaledVector(dir.normalize(), 6)
    }

    const cands: { util: number; target: THREE.Vector3 }[] = []

    // A) 退避(低HP/チャージ中): 自陣寄り・近接のカバーへ。効用は不利なほど高い。
    if (low || this.charging) {
      const base = this.world.basePos[me]
      let best: THREE.Vector3 | null = null, bd = Infinity
      for (const p of cps) { const d = flatDist(p, base) + flatDist(p, this.group.position) * 0.4; if (d < bd) { bd = d; best = p } }
      if (best) cands.push({ util: low ? 0.9 : 0.5, target: best.clone() })
    }

    // B) 占領(まだ支配していない): 優先スフィア(中央→敵陣→自陣)へ。ビハインドで重み増。
    if (o && !o.dominating(me)) {
      const sp = this.priorityCapture()
      if (sp) {
        let u = 0.6
        if (sp === o.center) u += 0.12 // 中央は支配(中央＋敵陣)の前提条件
        if (sp.contested()) u += 0.12   // 係争中は割り込み価値が高い
        cands.push({ util: u * wCapture, target: approach(sp, sp === o.center) })
      }
    }

    // C) 防衛: 自軍所有スフィアが係争中なら駆けつけて阻止。リードで重み増。
    if (o) {
      for (const s of o.spheres) {
        if (s.owner() === me && s.contested()) {
          cands.push({ util: 0.55 * wDefend, target: approach(s, s === o.center) })
        }
      }
    }

    // D) コア拾い(coreSeek許可+TP低): 占領が緊急(ビハインド×高戦略)なら抑制。
    if (this.params.coreSeek && this.world.cores.length) {
      let nc: THREE.Vector3 | null = null, nd = Infinity
      for (const c of this.world.cores) { const d = flatDist(c.pos, this.group.position); if (d < nd) { nd = d; nc = c.pos } }
      if (nc) {
        let u = this.tp < 45 ? 0.5 : (this.tp < 85 && nd < 10 ? 0.42 : 0)
        u *= 1 - 0.5 * sd * Math.max(0, -lead) / 4 // ビハインド+高戦略はコアより占領を優先
        if (u > 0.01) cands.push({ util: u, target: nc.clone() })
      }
    }

    // E) 支配中(全確保): 武器の得意距離帯のカバーで敵を待ち受ける防衛布陣。
    if (o && o.dominating(me)) {
      const ideal = this.idealRange(), lo = Math.max(5, ideal - 6), hi = ideal + 9
      const pool = cps.filter((p) => { const d = flatDist(p, player.group.position); return d > lo && d < hi })
        .sort((a, b) => flatDist(a, this.group.position) - flatDist(b, this.group.position)).slice(0, 5)
      const t = pool[Math.floor(Math.random() * pool.length)] ?? cps[0]
      cands.push({ util: 0.55 * wDefend, target: t.clone() })
    }

    // 最高効用の行動を採用。候補が無ければ得意距離帯のカバーへ(従来フォールバック)。
    let pick: THREE.Vector3 | null = null, bestU = -Infinity
    for (const c of cands) { if (c.util > bestU) { bestU = c.util; pick = c.target } }
    if (!pick) {
      const ideal = this.idealRange(), lo = Math.max(5, ideal - 6), hi = ideal + 9
      const pool = cps.filter((p) => { const d = flatDist(p, player.group.position); return d > lo && d < hi })
        .sort((a, b) => flatDist(a, this.group.position) - flatDist(b, this.group.position)).slice(0, 5)
      pick = (pool[Math.floor(Math.random() * pool.length)] ?? cps[0]).clone()
    }
    if (pick && (!this.moveTarget || flatDist(pick, this.moveTarget) > 1)) {
      this.moveTarget = pick.clone()
      this.path = this.world.nav.findPath(this.group.position, this.moveTarget)
      this.pi = 0
    }
  }

  /** 武器の威力ピーク距離 */
  private idealRange() {
    return this.char.weapon.falloff.reduce((acc, f) => (f.mul >= acc.mul ? f : acc)).d + 4
  }

  /** その距離での武器威力倍率 */
  private effectiveAt(dist: number) {
    return falloffMul(this.char.weapon.falloff, dist)
  }

  /** チャージ中の退避先(自分の近く・プレイヤーから今より遠いカバー) */
  private retreatToCover() {
    const player = this.world.commanderOf(enemyOf(this.team))
    if (!player) return
    const myDist = flatDist(player.group.position, this.group.position)
    let best: THREE.Vector3 | null = null
    let bd = Infinity
    for (const p of this.world.coverPoints) {
      const dSelf = flatDist(p, this.group.position)
      const dPlayer = flatDist(p, player.group.position)
      if (dPlayer > myDist + 2 && dSelf < bd) {
        bd = dSelf
        best = p
      }
    }
    if (best) {
      this.moveTarget = best.clone()
      this.path = this.world.nav.findPath(this.group.position, this.moveTarget)
      this.pi = 0
    }
  }

  private acquireTarget() {
    const enemies = this.world.enemiesOf(this.team)
    let best: Unit | null = null
    let bestScore = -Infinity
    const eye = this.eye()
    for (const u of enemies) {
      if (u.stealthed) continue
      const d = flatDist(u.group.position, this.group.position)
      if (d > 55) continue
      const tgt = this._acqTgt.copy(u.group.position)
      tgt.y += u.height * 0.6
      if (!this.world.hasLOS(eye, tgt)) continue
      let score = -d
      if (u.isCommander || u.kind === 'decoy') score += 40 // 将(とデコイ)優先
      if (score > bestScore) {
        bestScore = score
        best = u
      }
    }
    if (best?.isCommander) this.lastSawPlayer = 0
    // 偏差射撃用の速度推定
    if (best && best === this.target) {
      this.targetVel.copy(best.group.position).sub(this.prevTargetPos).divideScalar(Math.max(0.05, this.params.reaction))
      this.targetVel.y = 0
    } else {
      this.targetVel.set(0, 0, 0)
    }
    if (best) this.prevTargetPos.copy(best.group.position)
    // 新規ターゲット捕捉時は照準合わせの誤差が乗る(徐々に収束)
    if (best && best !== this.target) this.aimErr = this.params.aimErrInit
    this.target = best
  }

  private combatUpdate(dt: number) {
    const t = this.target
    // 占領優先(勝利条件直結): 至近(≤12m)の優先スフィアが未確保なら、遠い敵を撃つより占領射撃を進める。
    // ただし至近(≤16m)に敵が居れば交戦を優先(占領中の棒立ち被弾を避ける=最適)。
    const sp = !this.charging ? this.priorityCapture() : null
    this.capturing = false
    // 優先スフィアが射程内(≤28m)かつLOSが通っているなら占領射撃を進める(中央は高所LOS位置からのみ撃てる)。
    if (sp && flatDist(this.group.position, sp.pos) <= 28 && this.world.hasLOS(this.eye(), sp.pos)) {
      const threatClose = t && t.alive && !t.stealthed && flatDist(this.group.position, t.group.position) <= 16
      if (!threatClose) {
        this.capturing = true // moveUpdateの間合い戦闘を抑止し、スフィア上に留まって占領を進める
        this.burstLeft = 0
        const dk = Math.min(1, dt * 6)
        this.aimYaw += (0 - this.aimYaw) * dk
        this.aimPitch += (0 - this.aimPitch) * dk
        this.captureFire(dt)
        return
      }
    }
    // チャージ武器は溜め中(this.charging)でも戦闘を継続する(溜め自体が戦闘行動)。
    // 非チャージ武器はエネルギー切れ(this.charging)中は戦闘を降りて遮蔽で回復する。
    const isCharger = !!this.char.weapon.charger
    if (!t || !t.alive || t.stealthed || (this.charging && !isCharger)) {
      this.burstLeft = 0
      if (isCharger) { this.charging = false; this.chargeT = 0 } // 目標を失ったら溜めを解除
      // エイムレイヤーを中立へ戻す(狙いが無ければ頭/胸を正面へ)
      const dk = Math.min(1, dt * 6)
      this.aimYaw += (0 - this.aimYaw) * dk
      this.aimPitch += (0 - this.aimPitch) * dk
      this.captureFire(dt) // 敵が居なければスフィア占領を進める
      return
    }
    const dx = t.group.position.x - this.group.position.x
    const dz = t.group.position.z - this.group.position.z
    // モデル前面は-Zなので+πで「顔(視線)」をターゲット=実際のエイム方向へ向ける(見かけの視線と一致)
    this.group.rotation.y = lerpAngle(this.group.rotation.y, Math.atan2(dx, dz) + Math.PI, dt * 9)
    // 上体エイムレイヤー: eye→target の方向(shoot()のbaseDirと同源)を頭/胸のピッチ+残差ヨーへ伝える。
    // これで段差・浮遊ドローン相手でも「見かけの視線=実際の弾道」になり、どこを狙っているか読める。
    const eye = this.eye()
    const at = t.group.position.clone()
    at.y += t.height * 0.55
    const adx = at.x - eye.x
    const ady = at.y - eye.y
    const adz = at.z - eye.z
    const horiz = Math.max(0.001, Math.hypot(adx, adz))
    const wantYaw = wrapAngle(Math.atan2(adx, adz) + Math.PI - this.group.rotation.y)
    const wantPitch = Math.atan2(ady, horiz)
    const ak = Math.min(1, dt * 10)
    this.aimYaw += wrapAngle(wantYaw - this.aimYaw) * ak
    this.aimPitch += (wantPitch - this.aimPitch) * ak

    const w = this.char.weapon
    if (w.charger) { this.chargerCombat(dt, t); return } // チャージ武器(garo)は溜め→1撃モデル
    this.fireT -= dt
    if (this.burstLeft > 0) {
      if (this.fireT <= 0) {
        this.fireT = 1 / Math.max(1.2, w.rate)
        this.burstLeft--
        this.shoot(t)
      }
    } else {
      this.burstCd -= dt
      if (this.burstCd <= 0) {
        // 連射武器ほど長いバースト、単発武器は1発ずつ
        this.burstLeft = Math.max(1, Math.round(w.rate * 0.7))
        this.burstCd = this.params.burstPause * (0.8 + Math.random() * 0.5)
      }
    }
  }

  /** チャージ武器の戦闘: 目標を狙いながら溜め、フル(遠距離)/早撃ち(至近)で1撃を放つ。
   *  最高難易度ほど溜め切って高威力の貫通弾を確実に当てる=狙撃に徹する最適行動。 */
  private chargerCombat(dt: number, t: Unit) {
    const cd = this.char.weapon.charger!
    const dist = flatDist(t.group.position, this.group.position)
    this.charging = true // 溜め中はスロー&占領射撃を抑止(狙撃に集中)
    this.fireT -= dt
    if (this.fireT > 0) return // 発射後の硬直
    this.chargeT = Math.min(cd.chargeTime, this.chargeT + dt)
    const frac = this.chargeT / cd.chargeTime
    // 至近は溜め切らず早撃ちで回避優先、中遠距離はフルチャージで貫通1撃を狙う
    const wantFrac = dist < 9 ? Math.min(1, cd.minFrac + 0.3) : 1
    // 難易度が低いほど溜めが甘く威力が出ない(params.dmgMulとは別に溜め精度で表現)
    const releaseFrac = wantFrac * (0.85 + 0.15 * this.params.dmgMul)
    if (frac + 1e-3 >= Math.min(1, releaseFrac)) {
      this.fireCharged(t, Math.max(cd.minFrac, frac))
      this.chargeT = 0
      this.fireT = cd.fireRecover + 0.05
      this.charging = false
    }
  }

  private fireCharged(t: Unit, frac: number) {
    const cd = this.char.weapon.charger!
    const w = this.char.weapon
    const p = chargeShotParams(cd, frac)
    if (this.invulnT > INVULN_ON_FIRE) this.invulnT = INVULN_ON_FIRE
    if (this.stealthed) this.setStealth(false)
    const origin = this.eye()
    const aim = t.group.position.clone()
    aim.y += t.height * 0.55
    if (this.params.lead) {
      const dist = origin.distanceTo(aim)
      aim.addScaledVector(this.targetVel, dist / p.speed)
    }
    const baseDir = aim.sub(origin).normalize()
    const muzzlePos = this.muzzle.getWorldPosition(new THREE.Vector3())
    const dir = this.combat.spreadDir(baseDir, this.params.spread * 0.5 + w.spread + this.aimErr)
    this.combat.fireBolt(muzzlePos.clone(), dir, {
      damage: p.damage * this.params.dmgMul, team: this.team, from: this, speed: p.speed,
      color: w.boltColor, maxRange: p.range, pierce: p.pierce, size: 0.1 + p.frac * 0.13,
    })
    this.combat.fx.flash(muzzlePos, w.boltColor, 0.12)
    this.sfx.shotFar(0.16)
    this.group.userData.recoil = 1
  }

  private shoot(t: Unit) {
    const w = this.char.weapon
    if (this.energy < w.energyCost) return
    this.energy -= w.energyCost
    if (this.invulnT > INVULN_ON_FIRE) this.invulnT = INVULN_ON_FIRE // 発砲でスポーン無敵を解除(無敵撃ち返し封じ)
    if (this.stealthed) this.setStealth(false)
    const origin = this.eye()
    const aim = t.group.position.clone()
    aim.y += t.height * 0.55
    if (this.params.lead) {
      const dist = origin.distanceTo(aim)
      aim.addScaledVector(this.targetVel, dist / w.boltSpeed)
    }
    const baseDir = aim.sub(origin).normalize()
    const muzzlePos = this.muzzle.getWorldPosition(new THREE.Vector3())
    for (let i = 0; i < w.pellets; i++) {
      const dir = this.combat.spreadDir(baseDir, this.params.spread + w.spread * 0.5 + this.aimErr)
      this.combat.fireBolt(muzzlePos.clone(), dir, {
        damage: w.damage * this.params.dmgMul,
        team: this.team,
        from: this,
        speed: w.boltSpeed,
        falloff: w.falloff,
        color: 0xff8a78,
        explosive: w.explosive,
        gravity: w.gravity,
        maxRange: 110,
        size: w.explosive ? 0.16 : 0.085,
      })
    }
    this.combat.fx.flash(muzzlePos, 0xffb080, 0.1)
    this.sfx.shotFar(0.13)
    this.group.userData.recoil = 1 // 発砲リコイル(animateSkeletonが上体/銃腕へ反映、updateで減衰)
  }

  /** ゾーン制圧: 今このボットが確保すべきスフィア(優先: 中央→敵陣→自陣防衛)。無ければnull(支配中) */
  private priorityCapture() {
    const o = this.world.objectives
    if (!o) return null
    const me = this.team
    const enemy = enemyOf(this.team)
    if (o.center.owner() !== me) return o.center
    if (o.base[enemy].owner() !== me) return o.base[enemy]
    if (o.base[me].owner() !== me) return o.base[me] // 自陣を奪われ中→防衛
    return null
  }

  /** 敵ターゲットが居ないとき、射程内の優先スフィアを撃って占領を進める */
  private captureFire(dt: number) {
    if (this.charging) return
    const sp = this.priorityCapture()
    if (!sp) return
    const px = this.group.position.x
    const pz = this.group.position.z
    const d = Math.hypot(sp.pos.x - px, sp.pos.z - pz)
    if (d > 32) return // 遠ければthink()が接近させる
    this.group.rotation.y = lerpAngle(this.group.rotation.y, Math.atan2(sp.pos.x - px, sp.pos.z - pz) + Math.PI, dt * 7)
    const w = this.char.weapon
    this.fireT -= dt
    if (this.fireT <= 0 && this.energy >= w.energyCost) {
      this.fireT = 1 / Math.max(1.2, w.rate)
      this.energy -= w.energyCost
      if (this.stealthed) this.setStealth(false)
      const origin = this.eye()
      const dir = sp.pos.clone().sub(origin).normalize()
      const muzzlePos = this.muzzle.getWorldPosition(new THREE.Vector3())
      for (let i = 0; i < w.pellets; i++) {
        const sd = this.combat.spreadDir(dir, w.spread * 0.4)
        this.combat.fireBolt(muzzlePos.clone(), sd, {
          damage: w.damage * this.params.dmgMul, team: this.team, from: this, speed: w.boltSpeed,
          falloff: w.falloff, color: 0xff8a78, explosive: w.explosive, gravity: w.gravity, maxRange: 110,
          size: w.explosive ? 0.16 : 0.085,
        })
      }
      this.combat.fx.flash(muzzlePos, 0xffb080, 0.1)
      this.sfx.shotFar(0.1)
    }
  }

  private moveUpdate(dt: number) {
    const p = this.group.position
    if (this.dashT > 0) {
      this.dashT -= dt
      p.addScaledVector(this.dashDir, 20 * dt)
      this.collide()
      return
    }
    const speedMul = this.charging ? 0.5 : 1
    const t = this.target
    // 占領位置への精密接近: スフィアのLOSは位置にシビア(中央は数十cmずれると射線が切れる)。
    // 優先スフィア狙いで moveTarget(=LOSが通るカバー点)の至近に来たら、ぴったり乗るまで微速で寄せて保持する。
    const csp = !this.charging ? this.priorityCapture() : null
    if (csp && this.moveTarget && flatDist(this.moveTarget, csp.pos) < 15 && flatDist(this.moveTarget, p) < 3.5) {
      const threatClose = t && t.alive && !t.stealthed && flatDist(t.group.position, p) <= 14
      if (!threatClose) {
        const off = flatDist(this.moveTarget, p)
        if (off > 0.25) {
          const dir = this.moveTarget.clone().sub(p).setY(0).normalize()
          p.addScaledVector(dir, Math.min(off, 2.6 * dt))
          this.collide()
          this.bobWalk(2.6)
        }
        return // 精密保持(間合いstrafe/経路追従より優先)
      }
    }
    // 自分の武器が活きる距離でのみ足を止めて撃ち合う。
    // 射程外ならカバー伝いに距離を詰め続ける(超近距離型ほど我慢して詰める)
    const engageThreshold = this.idealRange() < 11 ? 0.8 : 0.55
    if (t && t.alive && !t.stealthed && t.isCommander && !this.charging && !this.capturing &&
        this.effectiveAt(flatDist(t.group.position, p)) >= engageThreshold) {
      const d = flatDist(t.group.position, p)
      this.strafeT -= dt
      if (this.strafeT <= 0) {
        this.strafeT = 1.2 + Math.random() * 1.0
        this.strafeDir = Math.random() < 0.5 ? -1 : 1
      }
      const toT = t.group.position.clone().sub(p).setY(0).normalize()
      const lateral = new THREE.Vector3(-toT.z, 0, toT.x).multiplyScalar(this.strafeDir)
      const move = lateral.clone()
      const ideal = this.idealRange()
      if (d > ideal + 6) move.add(toT)
      else if (d < Math.max(6, ideal - 6)) move.sub(toT)
      move.normalize()
      p.addScaledVector(move, 3.6 * dt)
      this.collide()
      this.bobWalk(3.6)
      return
    }
    if (this.path && this.pi < this.path.length) {
      const wp = this.path[this.pi]
      if (flatDist(wp, p) < 0.9) {
        this.pi++
      } else {
        const dir = wp.clone().sub(p).setY(0).normalize()
        p.addScaledVector(dir, 4.3 * speedMul * dt)
        this.collide()
        if (!this.target) {
          // 非戦闘時は進行方向へ。モデル前面-Zに合わせ+π
          this.group.rotation.y = lerpAngle(this.group.rotation.y, Math.atan2(dir.x, dir.z) + Math.PI, dt * 8)
        }
        this.bobWalk(4.3)
      }
    }
  }

  private bobWalk(_speed: number) {
    // y(高さ)は verticalUpdate の物理が一元管理する。歩行の上下バウンスをここで足すと接地判定が
    // フリッカーしジャンプ物理が壊れるため、yは触らない(歩行の見た目は脚のスケルタルアニメで表現)。
  }

  private animPrev: THREE.Vector3 | null = null
  private animT = Math.random() * 6
  private animAmp = 0

  /** 移動速度に応じた歩行アニメ */
  private updateWalkAnim(dt: number) {
    // 過渡モーション(発砲リコイル/被弾フリンチ)の減衰
    const ud = this.group.userData
    if (ud.recoil) ud.recoil = Math.max(0, ud.recoil - dt * 9)
    if (ud.flinch) ud.flinch = Math.max(0, ud.flinch - dt * 4.5)
    const anim = this.group.userData.anim as { legs: THREE.Group[]; arms: THREE.Group[] } | undefined
    const p = this.group.position
    if (!this.animPrev) this.animPrev = p.clone()
    const dx = p.x - this.animPrev.x
    const dz = p.z - this.animPrev.z
    const speed = Math.sqrt(dx * dx + dz * dz) / Math.max(dt, 1e-3)
    this.animPrev.set(p.x, p.y, p.z)
    const targetAmp = Math.min(1, speed / 3.2)
    this.animAmp += (targetAmp - this.animAmp) * Math.min(1, dt * 10)
    this.animT += dt * (5 + speed * 2.0)
    if (anim) {
      anim.legs.forEach((leg, i) => {
        leg.rotation.x = Math.sin(this.animT + (i % 2) * Math.PI) * 0.7 * this.animAmp
      })
      anim.arms.forEach((arm, i) => {
        arm.rotation.x = Math.sin(this.animT + (i % 2) * Math.PI) * 0.5 * this.animAmp
      })
      return
    }
    if (this.group.userData.bones) animateSkeleton(this.group, this.animT, this.animAmp, this.aimYaw, this.aimPitch)
    else animateGlbBody(this.group, this.animT, this.animAmp)
  }

  private collide() {
    const p = this.group.position
    const lim = this.world.arenaHalf - 1
    p.x = Math.max(-lim, Math.min(lim, p.x))
    p.z = Math.max(-lim, Math.min(lim, p.z))
    for (const c of this.world.colliders) {
      if (p.y >= c.max.y - 0.01) continue
      const cx = Math.max(c.min.x, Math.min(c.max.x, p.x))
      const cz = Math.max(c.min.z, Math.min(c.max.z, p.z))
      const dx = p.x - cx
      const dz = p.z - cz
      const d2 = dx * dx + dz * dz
      if (d2 < this.radius * this.radius) {
        if (d2 < 1e-6) {
          const pushL = p.x - (c.min.x - this.radius)
          const pushR = c.max.x + this.radius - p.x
          const pushB = p.z - (c.min.z - this.radius)
          const pushF = c.max.z + this.radius - p.z
          const m = Math.min(pushL, pushR, pushB, pushF)
          if (m === pushL) p.x = c.min.x - this.radius
          else if (m === pushR) p.x = c.max.x + this.radius
          else if (m === pushB) p.z = c.min.z - this.radius
          else p.z = c.max.z + this.radius
        } else {
          const d = Math.sqrt(d2)
          p.x = cx + (dx / d) * this.radius
          p.z = cz + (dz / d) * this.radius
        }
      }
    }
  }

  /** 垂直物理: 重力・ジャンプ・地面/コライダー上面への着地(プレイヤー同型)。collide()は p.y>上面 でコライダーを無視するので、
   *  ジャンプで足元がコライダー上面を越えれば横移動で乗り、落下で上面に着地する=塔/段差を登れる。 */
  private verticalUpdate(dt: number) {
    const p = this.group.position
    this.jumpCd = Math.max(0, this.jumpCd - dt)
    if (this.wantJump && this.onGround && this.jumpCd <= 0) {
      this.velY = BOT_JUMP_VEL; this.onGround = false; this.jumpCd = 0.45
    }
    this.wantJump = false
    let g = BOT_GRAVITY; if (this.velY < 0) g *= BOT_FALL_MULT
    this.velY -= g * dt
    const prevY = p.y
    p.y += this.velY * dt
    // 着地面: 地面0 + 足元(x,z)がフットプリント内のコライダー上面のうち、直前フレームで上にいた最高面
    let landY = 0
    for (const c of this.world.colliders) {
      if (p.x >= c.min.x - this.radius && p.x <= c.max.x + this.radius &&
          p.z >= c.min.z - this.radius && p.z <= c.max.z + this.radius &&
          prevY >= c.max.y - 0.1 && c.max.y > landY) landY = c.max.y
    }
    if (this.velY <= 0 && p.y <= landY) { p.y = landY; this.velY = 0; this.onGround = true }
    else this.onGround = (p.y <= landY + 0.001)
  }

  private deployUpdate() {
    if (this.deployT > 0) return
    this.deployT = this.params.deployMin + Math.random() * (this.params.deployMax - this.params.deployMin)
    const loadout = loadoutFor(this.char.uniqueToken)
    const player = this.world.commanderOf(enemyOf(this.team))
    let bestKey: string | null = null
    let bestScore = 0
    for (const key of loadout) {
      const def = TOKENS[key]
      if (this.tp < def.cost) continue
      if (this.world.countActive(this.team, key) >= def.maxActive) continue
      let score = 1 + Math.random() * 2
      if (key === 'healer' && this.hp < this.maxHp * 0.65) score += 5
      if (key === 'sentry' && this.world.countActive(this.team, 'sentry') === 0) score += 3
      if (key === 'gunner') score += 1.5
      if ((key === 'striker' || key === 'mine' || key === 'chaser') && this.tp > 70) score += 2.5
      if (key === 'booster' && this.world.units.filter((u) => u.alive && u.team === this.team && !u.isCommander).length >= 2) score += 3
      if (key === 'wallpod' && this.hp < this.maxHp * 0.6) score += 3
      if (score > bestScore) {
        bestScore = score
        bestKey = key
      }
    }
    if (!bestKey) return
    const def = TOKENS[bestKey]
    const base = this.group.position
    const toPlayer = player
      ? player.group.position.clone().sub(base).setY(0).normalize()
      : new THREE.Vector3(0, 0, 1)
    for (let i = 0; i < 8; i++) {
      const ang = (Math.random() - 0.5) * 2.4
      const dist = 3 + Math.random() * 4
      const dir = toPlayer.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), ang)
      const p = base.clone().addScaledVector(dir, dist)
      if (Math.abs(p.x) > this.world.arenaHalf - 2 || Math.abs(p.z) > this.world.arenaHalf - 2) continue
      if (!this.world.nav.isFree(p.x, p.z)) continue
      this.tp -= def.cost
      const unit = def.spawn(this.world, this.combat, this.sfx, this.team, new THREE.Vector3(p.x, 0, p.z), toPlayer)
      this.world.addUnit(unit)
      this.combat.fx.ring(new THREE.Vector3(p.x, 0, p.z), TEAM_COLOR[this.team])
      this.sfx.shotFar(0.1)
      return
    }
  }

  private skillUpdate() {
    if (this.skillCd > 0 || this.skillActiveT > 0) return
    const s = this.char.skill
    const player = this.world.commanderOf(enemyOf(this.team))
    const low = this.hp < this.maxHp * 0.5 && this.lastDamaged < 1.5
    let use = false
    switch (s.key) {
      case 'dash':
      case 'cloak':
      case 'decoy':
      case 'dome':
        use = low
        break
      case 'repair': {
        const hurt = this.world.units.filter(
          (u) => u.alive && u.team === this.team && !u.isCommander && u.hp < u.maxHp * 0.7 &&
            u.group.position.distanceTo(this.group.position) < 12,
        ).length
        use = this.hp < this.maxHp * 0.6 || hurt >= 2
        break
      }
      case 'overdrive':
        use = !!this.target && this.target.isCommander && flatDist(this.target.group.position, this.group.position) < 18
        break
      case 'beatdrop': {
        const close = this.world.enemiesOf(this.team).some(
          (u) => flatDist(u.group.position, this.group.position) < 5,
        )
        use = close
        break
      }
      case 'sonar':
        use = this.lastSawPlayer > 6
        break
    }
    if (!use) return
    this.skillCd = s.cooldown
    this.skillActiveT = s.duration

    switch (s.key) {
      case 'dash': {
        const away = player
          ? this.group.position.clone().sub(player.group.position).setY(0).normalize()
          : new THREE.Vector3(0, 0, -1)
        away.applyAxisAngle(new THREE.Vector3(0, 1, 0), (Math.random() - 0.5) * 1.2)
        this.dashDir.copy(away)
        this.dashT = 0.18
        break
      }
      case 'cloak':
        this.setStealth(true)
        this.thinkT = 0
        break
      case 'decoy': {
        const decoy = new DecoyUnit(this.world, this.combat, this.sfx, this.team, this.group.position.clone(), this.char, this.group.rotation.y)
        this.world.addUnit(decoy)
        this.setStealth(true)
        this.thinkT = 0
        break
      }
      case 'repair': {
        this.hp = Math.min(this.maxHp, this.hp + 30)
        for (const u of this.world.units) {
          if (u.alive && u.team === this.team && !u.isCommander && u.kind !== 'decoy') {
            if (u.group.position.distanceTo(this.group.position) < 12) u.hp = Math.min(u.maxHp, u.hp + 30)
          }
        }
        this.combat.fx.ring(this.group.position.clone(), 0x6effa8)
        break
      }
      case 'beatdrop': {
        this.armorT = 0.5
        const p = this.group.position.clone()
        p.y += 0.9
        this.combat.explode(p, 6, 35, this.team, this, 0xc89bff)
        break
      }
      case 'sonar': {
        this.world.reveal(enemyOf(this.team), s.duration)
        if (player) {
          this.moveTarget = player.group.position.clone()
          this.path = this.world.nav.findPath(this.group.position, this.moveTarget)
          this.pi = 0
        }
        break
      }
      // dome/overdriveは状態フラグ(skillActiveT)のみで効果発動
    }
  }

  private setStealth(on: boolean) {
    this.stealthed = on
    this.setStealthVisual(on)
  }

  private setStealthVisual(on: boolean) {
    for (const s of this.stealthMats) {
      s.m.transparent = true
      ;(s.m as THREE.MeshStandardMaterial).opacity = on ? 0.13 : s.opacity
      s.m.needsUpdate = true
    }
  }

  private updateFlash(dt: number) {
    if (this.flashT > 0) {
      this.flashT -= dt
      if (this.flashT <= 0) {
        for (const p of this.flashPairs) {
          p.m.emissive.setHex(p.color)
          p.m.emissiveIntensity = p.intensity
        }
      }
    }
  }

  takeDamage(amount: number, from: Unit | null) {
    if (!this.alive || this.invulnT > 0) return
    let d = amount
    const sk = this.char.skill.key
    if (sk === 'dash' && this.skillActiveT > 0) d *= 0.5
    if (sk === 'dome' && this.skillActiveT > 0) d *= 0.4
    if (this.armorT > 0) d *= 0.2
    this.hp -= d
    this.world.notifyDamage(this, from, d)
    this.regenDelay = 6
    this.lastDamaged = 0
    this.flashT = 0.09
    this.group.userData.flinch = 1 // 被弾フリンチ(animateSkeletonが上体に反映、updateで減衰)
    for (const p of this.flashPairs) {
      p.m.emissive.setHex(0xffffff)
      p.m.emissiveIntensity = 0.7
    }
    // 被弾時は再取得を早めるが、戦闘中に全botが10HzでhasLOS走査する暴走を避けるため下限0.2s(約5Hz)に留める
    this.retargetT = Math.min(this.retargetT, 0.2)
    // 見えない敵からの被弾は横っ飛びで回避(棒立ち狙撃され対策)
    if (!this.target && this.dashT <= 0) {
      const ang = Math.random() * Math.PI * 2
      this.dashDir.set(Math.cos(ang), 0, Math.sin(ang))
      this.dashT = 0.12
      this.thinkT = Math.min(this.thinkT, 0.4)
    }
    if (this.hp <= 0) {
      this.hp = 0
      this.alive = false
      const p = this.group.position.clone()
      p.y += 1
      this.combat.fx.explosion(p, 3)
      this.sfx.explosion()
      this.group.visible = false
      this.world.notifyKill(this, from)
    }
  }
}
