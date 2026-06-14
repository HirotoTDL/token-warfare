import * as THREE from 'three'
import { World, type AABB } from './world'
import { Combat } from './combat'
import { Sfx } from './sfx'
import { enemyOf, TEAM_COLOR, type CharacterDef, type Team, type Unit } from './types'
import {
  buildGunner, buildSentry, buildHealDrone, buildStriker, buildSpiderMine,
  buildWall, buildBooster, buildChaser, buildBomber, buildJammer, buildSniperDrone, buildDecoy,
} from './models'
import { getModel, animateGlbBody, animateSkeleton } from './modelLoader'

/** GLB(外部生成モデル)があれば優先、無ければプロシージャル */
function resolveModel(key: string, team: Team, fallback: () => THREE.Group): THREE.Group {
  return getModel(key, team) ?? fallback()
}

export interface TokenDef {
  key: string
  name: string
  cost: number
  maxActive: number
  desc: string
  spawn(world: World, combat: Combat, sfx: Sfx, team: Team, pos: THREE.Vector3, dir?: THREE.Vector3): Unit
}

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

export abstract class TokenUnit implements Unit {
  id: number
  team: Team
  kind: string
  name: string
  hp: number
  maxHp: number
  alive = true
  isCommander = false
  stealthed = false
  group: THREE.Group
  hitMeshes: THREE.Mesh[] = []
  radius: number
  height: number
  /** 起動ディレイ(秒)。配備直後この秒数は機能停止=即効果を防ぎ配置読みを成立させる。各updateの先頭でガード */
  protected activeT = 0
  /** 起動済みか(オーラ系トークンの効果がworld側から起動ディレイを尊重するための公開フラグ) */
  get armed(): boolean { return this.activeT <= 0 }

  protected world: World
  protected combat: Combat
  protected sfx: Sfx
  private flashPairs: { m: THREE.MeshStandardMaterial; color: number; intensity: number }[] = []
  private flashT = 0

  constructor(
    world: World, combat: Combat, sfx: Sfx, team: Team,
    kind: string, name: string, model: THREE.Group, pos: THREE.Vector3,
    hp: number, radius: number, height: number,
  ) {
    this.world = world
    this.combat = combat
    this.sfx = sfx
    this.id = world.allocId()
    this.team = team
    this.kind = kind
    this.name = name
    this.hp = this.maxHp = hp
    this.radius = radius
    this.height = height
    this.group = model
    this.group.position.copy(pos)
    this.group.position.y = 0
    model.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) this.hitMeshes.push(o as THREE.Mesh)
    })
    const mats = (model.userData.mats as THREE.MeshStandardMaterial[]) ?? []
    for (const m of mats) {
      this.flashPairs.push({ m, color: m.emissive.getHex(), intensity: m.emissiveIntensity })
    }
    // --- 敵味方の識別: 全トークンに陣営色の発光リング+ベースグローを付与 ---
    // 形状で能力、色(青=自軍 / 赤=敵軍)で陣営が一目で分かるようにする
    const tc = TEAM_COLOR[team]
    const ringMat = new THREE.MeshBasicMaterial({ color: tc, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })
    const ring = new THREE.Mesh(new THREE.TorusGeometry(Math.max(0.42, radius + 0.18), 0.05, 8, 28), ringMat)
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 0.05
    this.group.add(ring)
    const discMat = new THREE.MeshBasicMaterial({ color: tc, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
    const disc = new THREE.Mesh(new THREE.CircleGeometry(Math.max(0.5, radius + 0.25), 24), discMat)
    disc.rotation.x = -Math.PI / 2
    disc.position.y = 0.03
    this.group.add(disc)
    this.teamRing = ringMat
  }

  private teamRing: THREE.MeshBasicMaterial | null = null
  private ringPulse = Math.random() * 6

  takeDamage(amount: number, from: Unit | null) {
    if (!this.alive) return
    this.hp -= amount
    this.world.notifyDamage(this, from, amount)
    this.flashT = 0.09
    for (const p of this.flashPairs) {
      p.m.emissive.setHex(0xffffff)
      p.m.emissiveIntensity = 0.7
    }
    if (this.hp <= 0) this.die(from)
  }

  protected die(from: Unit | null) {
    this.alive = false
    const p = this.group.position.clone()
    p.y += this.height / 2
    this.combat.fx.explosion(p, 1.1)
    this.world.removeUnit(this)
    this.world.notifyKill(this, from)
  }

  protected updateFlash(dt: number) {
    // 陣営リングを脈動させて視認性を上げる
    if (this.teamRing) {
      this.ringPulse += dt * 3
      this.teamRing.opacity = 0.7 + Math.sin(this.ringPulse) * 0.25
    }
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

  private animPrev: THREE.Vector3 | null = null
  private animT = Math.random() * 6
  private animAmp = 0

  /** 移動速度に応じた歩行アニメ(モデルにanim情報がある場合のみ) */
  protected updateWalkAnim(dt: number) {
    const anim = this.group.userData.anim as { legs: THREE.Group[]; arms: THREE.Group[] } | undefined
    const p = this.group.position
    if (!this.animPrev) this.animPrev = p.clone()
    const dx = p.x - this.animPrev.x
    const dz = p.z - this.animPrev.z
    const speed = Math.sqrt(dx * dx + dz * dz) / Math.max(dt, 1e-3)
    this.animPrev.set(p.x, p.y, p.z)
    const targetAmp = Math.min(1, speed / 3)
    this.animAmp += (targetAmp - this.animAmp) * Math.min(1, dt * 10)
    this.animT += dt * (5 + speed * 2.0)
    if (anim) {
      anim.legs.forEach((leg, i) => {
        const phase = ((i + (i >> 1)) % 2) * Math.PI // 2脚=交互 / 4脚=対角トロット
        leg.rotation.x = Math.sin(this.animT + phase) * 0.7 * this.animAmp
      })
      anim.arms.forEach((arm, i) => {
        arm.rotation.x = Math.sin(this.animT + Math.PI + (i % 2) * Math.PI) * 0.5 * this.animAmp
      })
      return
    }
    if (this.group.userData.bones) animateSkeleton(this.group, this.animT, this.animAmp)
    else animateGlbBody(this.group, this.animT, this.animAmp)
  }

  protected faceDir(dir: THREE.Vector3, dt: number) {
    const yaw = Math.atan2(dir.x, dir.z)
    this.group.rotation.y = lerpAngle(this.group.rotation.y, yaw, dt * 9)
  }

  protected collide() {
    const p = this.group.position
    const lim = this.world.arenaHalf - 1
    p.x = Math.max(-lim, Math.min(lim, p.x))
    p.z = Math.max(-lim, Math.min(lim, p.z))
    for (const c of this.world.colliders) {
      if (p.y >= c.max.y - 0.01 || p.y + this.height <= c.min.y) continue
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

  protected moveToward(target: THREE.Vector3, speed: number, dt: number, face = true) {
    const dir = target.clone().sub(this.group.position)
    dir.y = 0
    if (dir.lengthSq() < 1e-6) return
    dir.normalize()
    this.group.position.addScaledVector(dir, speed * dt)
    this.collide()
    if (face) this.faceDir(dir, dt)
  }

  /** 索敵: range内・LOSあり・非ステルスの最寄り敵(敵ジャマーで距離半減) */
  /** 占領支援トークンが支援すべきスフィア(中央→敵陣→自陣防衛、支配中はnull) */
  protected targetSphere() {
    const o = this.world.objectives
    if (!o) return null
    const me = this.team
    const enemy = enemyOf(this.team)
    if (o.center.owner() !== me) return o.center
    if (o.base[enemy].owner() !== me) return o.base[enemy]
    if (o.base[me].owner() !== me) return o.base[me]
    return null
  }

  protected findTarget(range: number, eyeH = 1.0): Unit | null {
    const effRange = range * this.world.senseRangeMul(this.team, this.group.position)
    let best: Unit | null = null
    let bd = effRange
    const eye = this.group.position.clone()
    eye.y += eyeH
    for (const u of this.world.enemiesOf(this.team)) {
      if (u.stealthed) continue
      const d = flatDist(u.group.position, this.group.position)
      if (d < bd) {
        const tgt = u.group.position.clone()
        tgt.y += u.height * 0.6
        if (this.world.hasLOS(eye, tgt)) {
          best = u
          bd = d
        }
      }
    }
    return best
  }

  protected fireBoltAt(target: Unit, muzzle: THREE.Vector3, damage: number, speed: number, spread: number) {
    const aim = target.group.position.clone()
    aim.y += target.height * 0.55
    const dir = this.combat.spreadDir(aim.sub(muzzle).normalize(), spread)
    this.combat.fireBolt(muzzle, dir, {
      damage, team: this.team, from: this, speed,
      color: this.team === 'blue' ? 0x6ec8ff : 0xff8a78, size: 0.07, maxRange: 70,
    })
  }

  abstract update(dt: number): void
}

class GunnerUnit extends TokenUnit {
  private retargetT = 0
  private target: Unit | null = null
  private fireCd = 0
  private path: THREE.Vector3[] | null = null
  private pathT = 0
  private pi = 0
  private bobT = Math.random() * 6
  private supplyT = 0

  constructor(world: World, combat: Combat, sfx: Sfx, team: Team, pos: THREE.Vector3) {
    super(world, combat, sfx, team, 'gunner', 'ガンナー', resolveModel('token_gunner', team, () => buildGunner(team)), pos, 55, 0.4, 1.3)
    this.activeT = 0.7
  }

  update(dt: number) {
    this.updateFlash(dt)
    if ((this.activeT -= dt) > 0) { this.updateWalkAnim(dt); this.group.updateMatrixWorld(); return } // 起動ディレイ
    this.retargetT -= dt
    this.fireCd -= dt
    this.supplyT -= dt
    this.bobT += dt
    if (this.retargetT <= 0) {
      this.retargetT = 0.45
      this.target = this.findTarget(45, 1.1)
    }
    // --- 占領支援: 優先スフィアへ前進し、射線が通る間だけ占領を供給する ---
    const sp = this.targetSphere()
    let supplied = false
    if (sp) {
      const d = flatDist(sp.pos, this.group.position)
      const eye = this.group.position.clone()
      eye.y += 1.0
      if (d <= 12 && this.world.hasLOS(eye, sp.pos)) {
        // 同種スタックは逓減(1機0.03 / 2機計0.045 / 3機計0.045)で過剰占領を防止
        const n = Math.max(1, this.world.countActive(this.team, 'gunner'))
        const per = (n >= 2 ? 0.045 : 0.03) / n
        sp.supply(this.team, per, dt)
        supplied = true
        if (this.supplyT <= 0) {
          this.supplyT = 0.12
          if (!this.world.headless) this.combat.fx.tracer(eye, sp.pos.clone(), this.team === 'blue' ? 0x6ec8ff : 0xff8a78)
        }
        if (!this.target) this.faceDir(sp.pos.clone().sub(this.group.position).setY(0).normalize(), dt)
      } else if (d > 11) {
        this.moveToward(sp.pos, 3.2, dt, !this.target)
      }
    }
    const t = this.target
    if (t && t.alive && !t.stealthed) {
      const dist = flatDist(t.group.position, this.group.position)
      const dir = t.group.position.clone().sub(this.group.position)
      dir.y = 0
      dir.normalize()
      this.faceDir(dir, dt)
      // 占領中でなく敵が遠ければ詰める(占領優先なのでスフィア圏内では動かない)
      if (!supplied && dist > 14) this.moveToward(t.group.position, 3.2, dt, false)
      if (this.fireCd <= 0) {
        this.fireCd = 0.5 * this.world.fireBoostMul(this.team, this.group.position)
        const muzzle = this.group.position.clone()
        muzzle.y += 1.0
        // 対トークン7 / 対将は0.7倍(≈5)。トークン同士の撃ち合いを主、対人は牽制に留める
        this.fireBoltAt(t, muzzle, t.isCommander ? 4.9 : 7, 80, 0.03)
        this.sfx.shotFar(0.07)
      }
    } else if (!sp) {
      // 支配達成(支援先なし)かつ敵なし: 旧来の敵将進軍で詰めの圧をかける
      this.target = null
      const cmd = this.world.commanderOf(enemyOf(this.team))
      if (cmd && cmd.alive) {
        this.pathT -= dt
        if (!this.path || this.pathT <= 0) {
          this.path = this.world.nav.findPath(this.group.position, cmd.group.position)
          this.pi = 0
          this.pathT = 3
        }
        if (this.path && this.pi < this.path.length) {
          const wp = this.path[this.pi]
          if (flatDist(wp, this.group.position) < 0.9) this.pi++
          else this.moveToward(wp, 3.2, dt)
        }
      }
    }
    this.group.position.y = Math.abs(Math.sin(this.bobT * 7)) * 0.02
    this.updateWalkAnim(dt)
    this.group.updateMatrixWorld()
  }
}

class SentryUnit extends TokenUnit {
  private head: THREE.Object3D
  private retargetT = 0
  private target: Unit | null = null
  private fireCd = 0

  constructor(world: World, combat: Combat, sfx: Sfx, team: Team, pos: THREE.Vector3) {
    super(world, combat, sfx, team, 'sentry', 'セントリー', resolveModel('token_sentry', team, () => buildSentry(team)), pos, 120, 0.55, 1.25)
    // GLBモデルにはヘッドが無いため、その場合は本体ごと旋回する
    this.head = (this.group.userData.head as THREE.Object3D) ?? this.group
    this.activeT = 1.0 // 設置後1秒は起動待機(配置を読まれる猶予)
  }

  update(dt: number) {
    this.updateFlash(dt)
    if ((this.activeT -= dt) > 0) { this.group.updateMatrixWorld(); return } // 起動ディレイ
    this.retargetT -= dt
    this.fireCd -= dt
    if (this.retargetT <= 0) {
      this.retargetT = 0.3
      this.target = this.findTarget(26, 1.0)
    }
    const t = this.target
    if (t && t.alive && !t.stealthed) {
      const dx = t.group.position.x - this.group.position.x
      const dz = t.group.position.z - this.group.position.z
      const want = Math.atan2(dx, dz)
      this.head.rotation.y = lerpAngle(this.head.rotation.y, want, dt * 5)
      let diff = (want - this.head.rotation.y) % (Math.PI * 2)
      if (diff > Math.PI) diff -= Math.PI * 2
      if (diff < -Math.PI) diff += Math.PI * 2
      if (Math.abs(diff) < 0.18 && this.fireCd <= 0) {
        this.fireCd = 0.16 * this.world.fireBoostMul(this.team, this.group.position)
        const yaw = this.head.rotation.y
        const muzzle = this.group.position.clone()
        muzzle.y += 0.95
        muzzle.x += Math.sin(yaw) * 0.55
        muzzle.z += Math.cos(yaw) * 0.55
        this.fireBoltAt(t, muzzle, 5, 100, 0.022)
        this.sfx.shotFar(0.06)
      }
    } else {
      this.head.rotation.y += dt * 0.8
    }
    this.group.updateMatrixWorld()
  }
}

// ヒールドローン: 占領支援トークン。優先スフィアの直下を低空でホバリングして占領を供給し、
// 近くの味方トークンを回復する(将は回復しない=対人サポートではなく盤面サポートへ役割転換)。
// 低空ゆえ地上の将に撃ち落とされやすく、これが敵側のカウンター手段になる。
class HealDroneUnit extends TokenUnit {
  private healT = 0
  private supplyT = 0
  private orbitT = Math.random() * 6

  constructor(world: World, combat: Combat, sfx: Sfx, team: Team, pos: THREE.Vector3) {
    super(world, combat, sfx, team, 'healer', 'ヒールドローン', resolveModel('token_healer', team, () => buildHealDrone(team)), pos, 40, 0.35, 0.6)
    this.group.position.y = 1.4
    this.activeT = 0.8
  }

  update(dt: number) {
    this.updateFlash(dt)
    if ((this.activeT -= dt) > 0) { this.group.position.y = 1.4; this.group.rotation.y += dt; this.group.updateMatrixWorld(); return }
    this.orbitT += dt
    this.healT -= dt
    this.supplyT -= dt
    const p = this.group.position
    const lim = this.world.arenaHalf - 1
    // 支援先スフィア(無ければ自陣スフィアに待機して防衛供給)
    const sp = this.targetSphere() ?? this.world.objectives?.base[this.team] ?? null
    if (sp) {
      const target = sp.pos.clone()
      target.x += Math.cos(this.orbitT * 0.8) * 1.6
      target.z += Math.sin(this.orbitT * 0.8) * 1.6
      target.y = 1.4 + Math.sin(this.orbitT * 2.2) * 0.18 // 低空: 地上将のリーチ内=撃墜可能
      p.lerp(target, Math.min(1, dt * 2.6))
      p.x = Math.max(-lim, Math.min(lim, p.x))
      p.z = Math.max(-lim, Math.min(lim, p.z))
      // 占領供給(味方ヒーラー数で逓減=スタック過剰防止)
      const eye = p.clone()
      if (flatDist(sp.pos, p) <= 12 && this.world.hasLOS(eye, sp.pos)) {
        const n = Math.max(1, this.world.countActive(this.team, 'healer'))
        sp.supply(this.team, 0.03 / n, dt)
        if (this.supplyT <= 0) {
          this.supplyT = 0.14
          if (!this.world.headless) this.combat.fx.tracer(eye, sp.pos.clone(), this.team === 'blue' ? 0x8effd0 : 0xffb0a0)
        }
      }
    } else {
      p.y = 1.4 + Math.sin(this.orbitT * 2) * 0.2
    }
    // 近接の味方トークンを回復(6HP/秒)。将は対象外
    if (this.healT <= 0) {
      let inj: Unit | null = null
      let bd = 8
      for (const u of this.world.units) {
        if (!u.alive || u.team !== this.team || u.isCommander || u === this) continue
        if (u.hp >= u.maxHp) continue
        const d = flatDist(u.group.position, p)
        if (d < bd) { bd = d; inj = u }
      }
      if (inj) {
        this.healT = 0.4
        inj.hp = Math.min(inj.maxHp, inj.hp + 6 * 0.4)
        if (!this.world.headless) {
          const c = inj.group.position.clone()
          c.y += inj.height * 0.6
          this.combat.fx.tracer(p.clone(), c, 0x6effa8)
        }
      }
    }
    this.group.rotation.y += dt * 1.5
    this.group.updateMatrixWorld()
  }
}

class StrikerUnit extends TokenUnit {
  private retargetT = 0
  private target: Unit | null = null
  private chaseT = 0

  constructor(world: World, combat: Combat, sfx: Sfx, team: Team, pos: THREE.Vector3) {
    super(world, combat, sfx, team, 'striker', 'ストライカー', resolveModel('token_striker', team, () => buildStriker(team)), pos, 50, 0.4, 0.6)
    this.activeT = 0.6
  }

  update(dt: number) {
    this.updateFlash(dt)
    if ((this.activeT -= dt) > 0) { this.group.updateMatrixWorld(); return } // 起動ディレイ
    this.retargetT -= dt
    if (this.retargetT <= 0 || !this.target || !this.target.alive) {
      this.retargetT = 0.5
      this.target = this.findTarget(10, 0.5) ?? this.world.commanderOf(enemyOf(this.team))
    }
    const t = this.target
    if (t && t.alive) {
      const d = flatDist(t.group.position, this.group.position)
      this.moveToward(t.group.position, 7, dt)
      this.group.rotation.z = Math.sin(this.world.time * 14) * 0.06
      // 失速ロジック: 標的の至近(10m)に踏み込んでから2秒以内に接触できなければその場で自爆。
      // 回避し続ければ振り切れる=対人の理不尽な追尾圧を抑える counterplay
      if (d < 10) this.chaseT += dt
      else this.chaseT = 0
      if (d < 1.6 || this.chaseT >= 2) {
        this.alive = false
        this.world.removeUnit(this)
        const p = this.group.position.clone()
        p.y += 0.4
        this.combat.explode(p, 4.0, 48, this.team, this) // 55→48 / r4.5→4.0: 対人即死圧を是正
      }
    }
    this.group.updateMatrixWorld()
  }
}

class SpiderMineUnit extends TokenUnit {
  private retargetT = 0
  private target: Unit | null = null
  private lamp: THREE.MeshStandardMaterial | null
  private chaseT = 0

  constructor(world: World, combat: Combat, sfx: Sfx, team: Team, pos: THREE.Vector3) {
    super(world, combat, sfx, team, 'mine', 'スパイダーマイン', resolveModel('token_mine', team, () => buildSpiderMine(team)), pos, 30, 0.3, 0.5)
    this.lamp = (this.group.userData.lamp as THREE.MeshStandardMaterial) ?? null
    this.activeT = 0.8 // 設置後0.8秒は不活性(踏む前に視認・破壊する猶予)
  }

  update(dt: number) {
    this.updateFlash(dt)
    if ((this.activeT -= dt) > 0) {
      if (this.lamp) this.lamp.emissiveIntensity = 0.3 // 起動前は薄く点灯
      this.group.updateMatrixWorld()
      return
    }
    this.retargetT -= dt
    if (this.retargetT <= 0) {
      this.retargetT = 0.35
      this.target = this.findTarget(9, 0.4)
    }
    const t = this.target
    if (t && t.alive && !t.stealthed) {
      this.moveToward(t.group.position, 5.5, dt) // 6.5→5.5: 直線では将に振り切られる速度に
      if (this.lamp) this.lamp.emissiveIntensity = 2.2
      this.chaseT += dt // 追尾上限3秒: 振り切られたら自爆して粘着を断つ
      if (flatDist(t.group.position, this.group.position) < 1.35 || this.chaseT >= 3) {
        this.alive = false
        this.world.removeUnit(this)
        const p = this.group.position.clone()
        p.y += 0.3
        this.combat.explode(p, 3.5, 52, this.team, this) // 62→52: 最安(35TP)・最大3・追尾で過剰だった爆発火力を是正
      }
    } else {
      this.chaseT = 0
      if (this.lamp) this.lamp.emissiveIntensity = 0.8 + Math.sin(this.world.time * 5) * 0.6
    }
    this.group.updateMatrixWorld()
  }
}

/** ウォールポッド: 遮蔽壁を展開。射線とAI経路を塞ぐ */
class WallPodUnit extends TokenUnit {
  private box: AABB
  private deployed = false
  private deployT = 1.0 // 0.35→1.0: 壁が射線/経路を塞ぐまで1秒。配置を読まれる猶予(起動ディレイ統合)

  constructor(world: World, combat: Combat, sfx: Sfx, team: Team, pos: THREE.Vector3, dir?: THREE.Vector3) {
    // 壁は配備者の向きに対して垂直(=正面を塞ぐ)。AABB制約のため軸スナップ
    const d = dir ?? new THREE.Vector3(0, 0, 1)
    const alongX = Math.abs(d.z) >= Math.abs(d.x) // 進行方向がz軸なら壁はx方向に伸びる
    super(world, combat, sfx, team, 'wallpod', 'ウォールポッド', buildWall(team, alongX), pos, 150, 0.5, 2.2)
    const w = alongX ? 3 : 0.42
    const dd = alongX ? 0.42 : 3
    this.box = {
      min: new THREE.Vector3(pos.x - w / 2, 0, pos.z - dd / 2),
      max: new THREE.Vector3(pos.x + w / 2, 2.2, pos.z + dd / 2),
    }
    this.group.scale.y = 0.05
  }

  update(dt: number) {
    this.updateFlash(dt)
    if (!this.deployed) {
      this.deployT -= dt
      this.group.scale.y = Math.min(1, this.group.scale.y + dt * 1.05)
      if (this.deployT <= 0) {
        this.deployed = true
        this.group.scale.y = 1
        this.world.addCollider(this.box)
        for (const m of this.hitMeshes) this.world.obstacleMeshes.push(m)
      }
    }
    this.group.updateMatrixWorld()
  }

  protected die(from: Unit | null) {
    if (this.deployed) {
      this.world.removeCollider(this.box)
      for (const m of this.hitMeshes) {
        const i = this.world.obstacleMeshes.indexOf(m)
        if (i >= 0) this.world.obstacleMeshes.splice(i, 1)
      }
    }
    super.die(from)
  }
}

/** ブースターパイロン: 半径10mの味方トークン連射強化(world.fireBoostMul経由) */
class BoosterUnit extends TokenUnit {
  private crystal: THREE.Object3D | null
  private pulseT = 0

  constructor(world: World, combat: Combat, sfx: Sfx, team: Team, pos: THREE.Vector3) {
    super(world, combat, sfx, team, 'booster', 'ブースターパイロン', resolveModel('token_booster', team, () => buildBooster(team)), pos, 80, 0.45, 1.2)
    this.crystal = (this.group.userData.crystal as THREE.Object3D) ?? null
    this.activeT = 1.0 // 起動まで1秒はオーラ無効(armed=falseでworld側がゲート)
  }

  update(dt: number) {
    this.updateFlash(dt)
    if (this.activeT > 0) this.activeT -= dt // 視覚は回すがオーラはarmedで自動ゲート
    this.pulseT += dt
    if (this.crystal) {
      this.crystal.rotation.y += dt * 2.2
      this.crystal.position.y = 0.95 + Math.sin(this.pulseT * 2.4) * 0.08
    }
    if (this.pulseT > 1.6) {
      this.pulseT = 0
      this.combat.fx.ring(this.group.position.clone(), TEAM_COLOR[this.team])
    }
    this.group.updateMatrixWorld()
  }
}

/** チェイサー: 敵将を高速追跡。接触で小ダメージ+敵将を5秒マップ表示 */
class ChaserUnit extends TokenUnit {
  private path: THREE.Vector3[] | null = null
  private pi = 0
  private pathT = 0

  constructor(world: World, combat: Combat, sfx: Sfx, team: Team, pos: THREE.Vector3) {
    super(world, combat, sfx, team, 'chaser', 'チェイサー', resolveModel('token_chaser', team, () => buildChaser(team)), pos, 50, 0.35, 0.7)
    this.activeT = 0.5
  }

  update(dt: number) {
    this.updateFlash(dt)
    if ((this.activeT -= dt) > 0) { this.updateWalkAnim(dt); this.group.updateMatrixWorld(); return } // 起動ディレイ
    // 近接2m以内の敵ステルスを暴く(ステルス将/デコイへのカウンター=偵察犬の役割)
    for (const u of this.world.enemiesOf(this.team)) {
      if (u.stealthed && flatDist(u.group.position, this.group.position) < 2) u.stealthed = false
    }
    const prey = this.world.commanderOf(enemyOf(this.team))
    if (prey && prey.alive) {
      const dist = flatDist(prey.group.position, this.group.position)
      // 障害物に引っかからないよう経路追従(獲物が動くので高頻度で再計算)
      this.pathT -= dt
      if (!this.path || this.pathT <= 0) {
        this.path = this.world.nav.findPath(this.group.position, prey.group.position)
        this.pi = 0
        this.pathT = 1.2
      }
      if (dist < 6 || !this.path) {
        // 至近距離は直進
        this.moveToward(prey.group.position, 8.2, dt)
      } else if (this.pi < this.path.length) {
        const wp = this.path[this.pi]
        if (flatDist(wp, this.group.position) < 0.9) this.pi++
        else this.moveToward(wp, 8.2, dt)
      }
      this.group.position.y = Math.abs(Math.sin(this.world.time * 11)) * 0.12
      if (dist < 1.2) {
        this.alive = false
        this.world.removeUnit(this)
        const p = this.group.position.clone()
        p.y += 0.4
        this.combat.explode(p, 2.0, 12, this.team, this, 0x66e8ff)
        this.world.reveal(enemyOf(this.team), 5)
      }
    }
    this.updateWalkAnim(dt)
    this.group.updateMatrixWorld()
  }
}

/** ボムスリンガー: 曲射砲台。LOS不要で山なり爆撃 */
class BomberUnit extends TokenUnit {
  private fireCd = 2.0
  private retargetT = 0
  private target: Unit | null = null

  constructor(world: World, combat: Combat, sfx: Sfx, team: Team, pos: THREE.Vector3) {
    super(world, combat, sfx, team, 'bomber', 'ボムスリンガー', resolveModel('token_bomber', team, () => buildBomber(team)), pos, 90, 0.5, 1.0)
    this.activeT = 1.0
  }

  update(dt: number) {
    this.updateFlash(dt)
    if ((this.activeT -= dt) > 0) { this.group.updateMatrixWorld(); return } // 起動ディレイ
    this.fireCd -= dt
    this.retargetT -= dt
    if (this.retargetT <= 0) {
      this.retargetT = 0.6
      // 曲射なのでLOS不要: 最寄りの敵(範囲30m)
      const effRange = 30 * this.world.senseRangeMul(this.team, this.group.position)
      let best: Unit | null = null
      let bd = effRange
      for (const u of this.world.enemiesOf(this.team)) {
        if (u.stealthed) continue
        const d = flatDist(u.group.position, this.group.position)
        if (d > 6 && d < bd) {
          best = u
          bd = d
        }
      }
      this.target = best
    }
    const t = this.target
    if (t && t.alive && this.fireCd <= 0) {
      this.fireCd = 2.0 * this.world.fireBoostMul(this.team, this.group.position) // 2.2→2.0: コスト45に見合う手数へ
      const p = this.group.position
      const tp = t.group.position
      const dx = tp.x - p.x
      const dz = tp.z - p.z
      const flat = Math.sqrt(dx * dx + dz * dz)
      const flightT = Math.max(0.8, Math.min(1.8, flat / 16))
      const g = 12
      const muzzle = p.clone()
      muzzle.y += 1.0
      const vel = new THREE.Vector3(
        dx / flightT,
        (tp.y - muzzle.y + 0.5 * g * flightT * flightT) / flightT,
        dz / flightT,
      )
      const yaw = Math.atan2(dx, dz)
      this.group.rotation.y = yaw
      this.combat.fireBolt(muzzle, vel.clone().normalize(), {
        damage: 24, team: this.team, from: this, speed: vel.length(), // 18→24: 50TPに見合う出力へ
        explosive: { radius: 2.0 }, gravity: g, maxRange: 80, // 2.5→2.0: 範囲制圧の過剰を是正
        color: this.team === 'blue' ? 0x6ec8ff : 0xff8a78, size: 0.16,
      })
      this.sfx.shotFar(0.12)
    }
    this.group.updateMatrixWorld()
  }
}

/** ジャマーポッド: 半径9mの敵索敵を妨害(world.senseRangeMul経由) */
class JammerUnit extends TokenUnit {
  constructor(world: World, combat: Combat, sfx: Sfx, team: Team, pos: THREE.Vector3) {
    super(world, combat, sfx, team, 'jammer', 'ジャマーポッド', resolveModel('token_jammer', team, () => buildJammer(team)), pos, 70, 0.4, 1.1)
    this.activeT = 0.9 // 起動まで0.9秒は妨害無効(armed=falseでworld側がゲート)
  }

  update(dt: number) {
    this.updateFlash(dt)
    if (this.activeT > 0) this.activeT -= dt
    this.group.rotation.y += dt * (this.armed ? 1.4 : 0.5) // 起動後は速く回って稼働を示す
    this.group.updateMatrixWorld()
  }
}

/** スナイパードローン: 浮遊狙撃機。長射程・高威力・脆い */
class SniperDroneUnit extends TokenUnit {
  private fireCd = 1.2
  private retargetT = 0
  private target: Unit | null = null
  private home: THREE.Vector3

  constructor(world: World, combat: Combat, sfx: Sfx, team: Team, pos: THREE.Vector3) {
    super(world, combat, sfx, team, 'sniperdrone', 'スナイパードローン', resolveModel('token_sniperdrone', team, () => buildSniperDrone(team)), pos, 35, 0.35, 0.6)
    this.home = pos.clone()
    this.group.position.y = 3.2
    this.activeT = 1.0
  }

  update(dt: number) {
    this.updateFlash(dt)
    if ((this.activeT -= dt) > 0) { this.group.position.y = 3.2; this.group.updateMatrixWorld(); return } // 起動ディレイ
    this.fireCd -= dt
    this.retargetT -= dt
    const p = this.group.position
    p.y = 3.2 + Math.sin(this.world.time * 1.8) * 0.2
    p.x = this.home.x + Math.cos(this.world.time * 0.7) * 1.2
    p.z = this.home.z + Math.sin(this.world.time * 0.7) * 1.2
    if (this.retargetT <= 0) {
      this.retargetT = 0.5
      this.target = this.findTarget(38, 0) // 45→38: 設置位置から盤面の要所だけを狙える射程に
    }
    const t = this.target
    if (t && t.alive && !t.stealthed) {
      const dir = t.group.position.clone().sub(p)
      this.group.rotation.y = lerpAngle(this.group.rotation.y, Math.atan2(dir.x, dir.z), dt * 3)
      if (this.fireCd <= 0) {
        this.fireCd = 1.7 * this.world.fireBoostMul(this.team, this.group.position) // 2.0→1.7: 50TP・脆弱に見合う手数へ
        const muzzle = p.clone()
        this.fireBoltAt(t, muzzle, 18, 200, 0.006)
        this.sfx.shotFar(0.14)
      }
    }
    this.group.updateMatrixWorld()
  }
}

/** デコイ(リコのスキル等で出現する将の偽物) */
export class DecoyUnit extends TokenUnit {
  private lifeT = 6

  constructor(world: World, combat: Combat, sfx: Sfx, team: Team, pos: THREE.Vector3, char: CharacterDef, yaw: number) {
    super(world, combat, sfx, team, 'decoy', 'デコイ', resolveModel(`char_${char.key}`, team, () => buildDecoy(char, team)), pos, 60, 0.45, 1.8)
    this.group.rotation.y = yaw
  }

  update(dt: number) {
    this.updateFlash(dt)
    this.lifeT -= dt
    this.group.position.y = Math.sin(this.world.time * 2.2) * 0.02
    if (this.lifeT <= 0) {
      this.alive = false
      this.world.removeUnit(this)
      this.combat.fx.ring(this.group.position.clone(), TEAM_COLOR[this.team])
    }
    this.group.updateMatrixWorld()
  }
}

// トークンは「盤面制圧の道具」。プレイヤー級の対人戦闘力は持たせず、占領支援/かく乱/迎撃に役割分担する。
// 起動ディレイ・対将ダメ減・追尾上限などで、設置位置を読み合う戦略ゲームに寄せる。
export const TOKENS: Record<string, TokenDef> = {
  gunner: {
    key: 'gunner', name: 'ガンナー', cost: 30, maxActive: 3,
    desc: '占領支援。スフィアへ前進し占領を供給。近接の敵トークンと撃ち合う(対将は弱い)。',
    spawn: (w, c, s, t, p) => new GunnerUnit(w, c, s, t, p),
  },
  sentry: {
    key: 'sentry', name: 'セントリー', cost: 50, maxActive: 2,
    desc: '迎撃砲台。射程26mで侵入トークンを撃ち落とす固定防衛。',
    spawn: (w, c, s, t, p) => new SentryUnit(w, c, s, t, p),
  },
  healer: {
    key: 'healer', name: 'ヒールドローン', cost: 40, maxActive: 1,
    desc: '占領支援。スフィア直下を低空で回り占領供給+近くの味方トークンを回復。低空=撃墜可。',
    spawn: (w, c, s, t, p) => new HealDroneUnit(w, c, s, t, p),
  },
  striker: {
    key: 'striker', name: 'ストライカー', cost: 45, maxActive: 2,
    desc: '突撃自爆。敵へ突進し接触自爆(48dmg)。至近で2秒振り切れば自滅。',
    spawn: (w, c, s, t, p) => new StrikerUnit(w, c, s, t, p),
  },
  mine: {
    key: 'mine', name: 'スパイダーマイン', cost: 35, maxActive: 3,
    desc: '徘徊地雷。近づいた敵を追尾自爆(52dmg)。3秒で振り切れる。',
    spawn: (w, c, s, t, p) => new SpiderMineUnit(w, c, s, t, p),
  },
  wallpod: {
    key: 'wallpod', name: 'ウォールポッド', cost: 40, maxActive: 2,
    desc: '遮蔽壁を展開(1秒)。射線とAI経路を塞ぎ占領ラインを作る。',
    spawn: (w, c, s, t, p, d) => new WallPodUnit(w, c, s, t, p, d),
  },
  booster: {
    key: 'booster', name: 'ブースターパイロン', cost: 40, maxActive: 1,
    desc: '半径10mの味方トークンの連射+20%。占領圏の手数を底上げ。',
    spawn: (w, c, s, t, p) => new BoosterUnit(w, c, s, t, p),
  },
  chaser: {
    key: 'chaser', name: 'チェイサー', cost: 35, maxActive: 2,
    desc: '偵察犬。敵将を追跡、接触で12dmg+5秒マップ表示。近接でステルスを暴く。',
    spawn: (w, c, s, t, p) => new ChaserUnit(w, c, s, t, p),
  },
  bomber: {
    key: 'bomber', name: 'ボムスリンガー', cost: 45, maxActive: 1,
    desc: '曲射砲台。遮蔽越しに爆発弾(24dmg)。占領圏の面制圧に。',
    spawn: (w, c, s, t, p) => new BomberUnit(w, c, s, t, p),
  },
  jammer: {
    key: 'jammer', name: 'ジャマーポッド', cost: 35, maxActive: 1,
    desc: '半径9mの敵トークンの索敵を半減。敵の占領網をかく乱。',
    spawn: (w, c, s, t, p) => new JammerUnit(w, c, s, t, p),
  },
  sniperdrone: {
    key: 'sniperdrone', name: 'スナイパードローン', cost: 45, maxActive: 1,
    desc: '浮遊狙撃機。射程38m・18dmg。要所の敵トークンを点で潰す。脆い。',
    spawn: (w, c, s, t, p) => new SniperDroneUnit(w, c, s, t, p),
  },
}

/** キャラごとの配備スロット(標準3+固有1) */
export function loadoutFor(uniqueToken: string): string[] {
  return ['gunner', 'sentry', 'healer', uniqueToken]
}
