import * as THREE from 'three'
import { World } from './world'
import { Combat } from './combat'
import { Sfx } from './sfx'
import { TEAM_COLOR, ENERGY_MAX, TP_REGEN_BASE, enemyOf, falloffMul, type CharacterDef, type Team, type Unit } from './types'
import { TOKENS, DecoyUnit, loadoutFor } from './tokens'
import { buildMonsterCommander } from './models'
import { getModel, animateGlbBody, animateSkeleton } from './modelLoader'

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
  private burstLeft = 0
  private burstCd = 1.5
  private fireT = 0
  private deployT = 6
  private skillCd = 3
  private skillActiveT = 0
  private armorT = 0
  private dashT = 0
  private dashDir = new THREE.Vector3()
  private strafeDir = 1
  private strafeT = 0
  private regenDelay = 0
  private lastDamaged = 999
  private lastSawPlayer = 0
  private walkT = 0
  private charging = false
  private prevTargetPos = new THREE.Vector3()
  private targetVel = new THREE.Vector3()
  private aimErr = 0

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
    this.group.rotation.y = Math.atan2(-spawn.x, -spawn.z)
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

    // エネルギー管理: 切れたらチャージ(射撃停止+鈍足=隙)
    if (this.charging) {
      this.energy = Math.min(ENERGY_MAX, this.energy + 55 * dt)
      if (this.energy > 65) this.charging = false
    } else if (this.energy < this.char.weapon.energyCost) {
      this.charging = true
      this.retreatToCover() // 無防備な間は遮蔽裏へ下がる
    } else if (this.lastDamaged > 1.5) {
      this.energy = Math.min(ENERGY_MAX, this.energy + 7 * dt)
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

  private think() {
    const player = this.world.commanderOf(enemyOf(this.team))
    if (!player || !player.alive) return
    const low = this.hp < this.maxHp * 0.4
    const cps = this.world.coverPoints
    if (!cps.length) return
    let pick: THREE.Vector3 | null = null

    // すぐ近くにコアがあれば機会的に拾いに行く(レベル3以上)
    if (this.params.coreSeek && this.tp < 85) {
      for (const c of this.world.cores) {
        if (flatDist(c.pos, this.group.position) < 10) {
          pick = c.pos.clone()
          break
        }
      }
    }

    // TPが低く、コア回収が許可されていれば最寄りのコアへ
    if (!pick && !low && this.params.coreSeek && this.tp < 45 && this.world.cores.length) {
      let bd = Infinity
      for (const c of this.world.cores) {
        const d = flatDist(c.pos, this.group.position)
        if (d < bd) {
          bd = d
          pick = c.pos.clone()
        }
      }
    } else if (low) {
      const base = this.world.basePos[this.team]
      let bd = Infinity
      for (const p of cps) {
        const d = flatDist(p, base) + flatDist(p, this.group.position) * 0.4
        if (d < bd) {
          bd = d
          pick = p
        }
      }
    } else if (!pick) {
      // 武器の得意距離帯のカバーへ寄る(近距離型は詰め、遠距離型は維持)
      const ideal = this.idealRange()
      const lo = Math.max(5, ideal - 6)
      const hi = ideal + 9
      const cands = cps.filter((p) => {
        const d = flatDist(p, player.group.position)
        return d > lo && d < hi
      })
      const pool = (cands.length ? cands : cps)
        .slice()
        .sort((a, b) => flatDist(a, this.group.position) - flatDist(b, this.group.position))
        .slice(0, 5)
      pick = pool[Math.floor(Math.random() * pool.length)] ?? null
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
      const tgt = u.group.position.clone()
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
    if (!t || !t.alive || t.stealthed || this.charging) {
      this.burstLeft = 0
      return
    }
    const dx = t.group.position.x - this.group.position.x
    const dz = t.group.position.z - this.group.position.z
    this.group.rotation.y = lerpAngle(this.group.rotation.y, Math.atan2(dx, dz), dt * 7)

    const w = this.char.weapon
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

  private shoot(t: Unit) {
    const w = this.char.weapon
    if (this.energy < w.energyCost) return
    this.energy -= w.energyCost
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
    // 自分の武器が活きる距離でのみ足を止めて撃ち合う。
    // 射程外ならカバー伝いに距離を詰め続ける(超近距離型ほど我慢して詰める)
    const engageThreshold = this.idealRange() < 11 ? 0.8 : 0.55
    if (t && t.alive && !t.stealthed && t.isCommander && !this.charging &&
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
          this.group.rotation.y = lerpAngle(this.group.rotation.y, Math.atan2(dir.x, dir.z), dt * 8)
        }
        this.bobWalk(4.3)
      }
    }
  }

  private bobWalk(speed: number) {
    this.group.position.y = Math.abs(Math.sin(this.walkT * speed * 1.8)) * 0.06
  }

  private animPrev: THREE.Vector3 | null = null
  private animT = Math.random() * 6
  private animAmp = 0

  /** 移動速度に応じた歩行アニメ */
  private updateWalkAnim(dt: number) {
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
    if (this.group.userData.bones) animateSkeleton(this.group, this.animT, this.animAmp)
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
    for (const p of this.flashPairs) {
      p.m.emissive.setHex(0xffffff)
      p.m.emissiveIntensity = 0.7
    }
    this.retargetT = Math.min(this.retargetT, 0.1)
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
