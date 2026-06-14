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

  constructor(world: World, combat: Combat, sfx: Sfx, team: Team, pos: THREE.Vector3) {
    super(world, combat, sfx, team, 'gunner', 'ガンナー', resolveModel('token_gunner', team, () => buildGunner(team)), pos, 60, 0.4, 1.3)
  }

  update(dt: number) {
    this.updateFlash(dt)
    this.retargetT -= dt
    this.fireCd -= dt
    this.bobT += dt
    if (this.retargetT <= 0) {
      this.retargetT = 0.45
      this.target = this.findTarget(45, 1.1)
    }
    const t = this.target
    if (t && t.alive && !t.stealthed) {
      const dist = flatDist(t.group.position, this.group.position)
      const dir = t.group.position.clone().sub(this.group.position)
      dir.y = 0
      dir.normalize()
      this.faceDir(dir, dt)
      if (dist > 14) this.moveToward(t.group.position, 3.2, dt, false)
      if (this.fireCd <= 0) {
        this.fireCd = 0.5 * this.world.fireBoostMul(this.team, this.group.position)
        const muzzle = this.group.position.clone()
        muzzle.y += 1.0
        this.fireBoltAt(t, muzzle, 7, 80, 0.03)
        this.sfx.shotFar(0.07)
      }
    } else {
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
  }

  update(dt: number) {
    this.updateFlash(dt)
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

class HealDroneUnit extends TokenUnit {
  private healT = 0
  private orbitT = Math.random() * 6

  constructor(world: World, combat: Combat, sfx: Sfx, team: Team, pos: THREE.Vector3) {
    super(world, combat, sfx, team, 'healer', 'ヒールドローン', resolveModel('token_healer', team, () => buildHealDrone(team)), pos, 40, 0.35, 0.6)
    this.group.position.y = 2.0
  }

  update(dt: number) {
    this.updateFlash(dt)
    this.orbitT += dt
    this.healT -= dt
    const owner = this.world.commanderOf(this.team)
    const p = this.group.position
    if (owner && owner.alive) {
      const target = owner.group.position.clone()
      target.x += Math.cos(this.orbitT * 0.9) * 1.8
      target.z += Math.sin(this.orbitT * 0.9) * 1.8
      target.y = owner.group.position.y + 2.3 + Math.sin(this.orbitT * 2.2) * 0.15
      p.lerp(target, Math.min(1, dt * 2.8))
      const lim = this.world.arenaHalf - 1
      p.x = Math.max(-lim, Math.min(lim, p.x))
      p.z = Math.max(-lim, Math.min(lim, p.z))
      if (this.healT <= 0 && owner.hp < owner.maxHp && p.distanceTo(owner.group.position) < 9) {
        this.healT = 0.5
        owner.hp = Math.min(owner.maxHp, owner.hp + 3)
        const chest = owner.group.position.clone()
        chest.y += owner.height * 0.6
        this.combat.fx.tracer(p.clone(), chest, 0x6effa8)
      }
    } else {
      p.y = 2.0 + Math.sin(this.orbitT * 2) * 0.2
    }
    this.group.rotation.y += dt * 1.5
    this.group.updateMatrixWorld()
  }
}

class StrikerUnit extends TokenUnit {
  private retargetT = 0
  private target: Unit | null = null

  constructor(world: World, combat: Combat, sfx: Sfx, team: Team, pos: THREE.Vector3) {
    super(world, combat, sfx, team, 'striker', 'ストライカー', resolveModel('token_striker', team, () => buildStriker(team)), pos, 50, 0.4, 0.6)
  }

  update(dt: number) {
    this.updateFlash(dt)
    this.retargetT -= dt
    if (this.retargetT <= 0 || !this.target || !this.target.alive) {
      this.retargetT = 0.5
      this.target = this.findTarget(10, 0.5) ?? this.world.commanderOf(enemyOf(this.team))
    }
    const t = this.target
    if (t && t.alive) {
      this.moveToward(t.group.position, 7, dt)
      this.group.rotation.z = Math.sin(this.world.time * 14) * 0.06
      if (flatDist(t.group.position, this.group.position) < 1.6) {
        this.alive = false
        this.world.removeUnit(this)
        const p = this.group.position.clone()
        p.y += 0.4
        this.combat.explode(p, 4.5, 55, this.team, this)
      }
    }
    this.group.updateMatrixWorld()
  }
}

class SpiderMineUnit extends TokenUnit {
  private retargetT = 0
  private target: Unit | null = null
  private lamp: THREE.MeshStandardMaterial | null

  constructor(world: World, combat: Combat, sfx: Sfx, team: Team, pos: THREE.Vector3) {
    super(world, combat, sfx, team, 'mine', 'スパイダーマイン', resolveModel('token_mine', team, () => buildSpiderMine(team)), pos, 30, 0.3, 0.5)
    this.lamp = (this.group.userData.lamp as THREE.MeshStandardMaterial) ?? null
  }

  update(dt: number) {
    this.updateFlash(dt)
    this.retargetT -= dt
    if (this.retargetT <= 0) {
      this.retargetT = 0.35
      this.target = this.findTarget(9, 0.4)
    }
    const t = this.target
    if (t && t.alive && !t.stealthed) {
      this.moveToward(t.group.position, 6.5, dt)
      if (this.lamp) this.lamp.emissiveIntensity = 2.2
      if (flatDist(t.group.position, this.group.position) < 1.35) {
        this.alive = false
        this.world.removeUnit(this)
        const p = this.group.position.clone()
        p.y += 0.3
        this.combat.explode(p, 3.5, 62, this.team, this) // 75→62: 最安(35TP)・最大3・追尾で過剰だった爆発火力を是正
      }
    } else if (this.lamp) {
      this.lamp.emissiveIntensity = 0.8 + Math.sin(this.world.time * 5) * 0.6
    }
    this.group.updateMatrixWorld()
  }
}

/** ウォールポッド: 遮蔽壁を展開。射線とAI経路を塞ぐ */
class WallPodUnit extends TokenUnit {
  private box: AABB
  private deployed = false
  private deployT = 0.35

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
      this.group.scale.y = Math.min(1, this.group.scale.y + dt * 3.2)
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
  }

  update(dt: number) {
    this.updateFlash(dt)
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
    super(world, combat, sfx, team, 'chaser', 'チェイサー', resolveModel('token_chaser', team, () => buildChaser(team)), pos, 45, 0.35, 0.7)
  }

  update(dt: number) {
    this.updateFlash(dt)
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
  }

  update(dt: number) {
    this.updateFlash(dt)
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
      this.fireCd = 2.2 * this.world.fireBoostMul(this.team, this.group.position) // 2.5→2.2: 割高で低出力だった曲射の手数を改善
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
        explosive: { radius: 2.5 }, gravity: g, maxRange: 80,
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
  }

  update(dt: number) {
    this.updateFlash(dt)
    this.group.rotation.y += dt * 1.4
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
  }

  update(dt: number) {
    this.updateFlash(dt)
    this.fireCd -= dt
    this.retargetT -= dt
    const p = this.group.position
    p.y = 3.2 + Math.sin(this.world.time * 1.8) * 0.2
    p.x = this.home.x + Math.cos(this.world.time * 0.7) * 1.2
    p.z = this.home.z + Math.sin(this.world.time * 0.7) * 1.2
    if (this.retargetT <= 0) {
      this.retargetT = 0.5
      this.target = this.findTarget(45, 0)
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

export const TOKENS: Record<string, TokenDef> = {
  gunner: {
    key: 'gunner', name: 'ガンナー', cost: 30, maxActive: 3,
    desc: '歩兵。索敵射撃、いなければ敵将へ進軍。',
    spawn: (w, c, s, t, p) => new GunnerUnit(w, c, s, t, p),
  },
  sentry: {
    key: 'sentry', name: 'セントリー', cost: 50, maxActive: 2,
    desc: '固定砲台。射程26mの高DPS。',
    spawn: (w, c, s, t, p) => new SentryUnit(w, c, s, t, p),
  },
  healer: {
    key: 'healer', name: 'ヒールドローン', cost: 40, maxActive: 1,
    desc: '自将に追従して回復し続ける。',
    spawn: (w, c, s, t, p) => new HealDroneUnit(w, c, s, t, p),
  },
  striker: {
    key: 'striker', name: 'ストライカー', cost: 45, maxActive: 2,
    desc: '敵将へ突撃して接触自爆(55dmg)。',
    spawn: (w, c, s, t, p) => new StrikerUnit(w, c, s, t, p),
  },
  mine: {
    key: 'mine', name: 'スパイダーマイン', cost: 35, maxActive: 3,
    desc: '徘徊地雷。近づいた敵を追尾自爆(75dmg)。',
    spawn: (w, c, s, t, p) => new SpiderMineUnit(w, c, s, t, p),
  },
  wallpod: {
    key: 'wallpod', name: 'ウォールポッド', cost: 35, maxActive: 2,
    desc: '幅3mの遮蔽壁を展開。射線とAI経路を塞ぐ。',
    spawn: (w, c, s, t, p, d) => new WallPodUnit(w, c, s, t, p, d),
  },
  booster: {
    key: 'booster', name: 'ブースターパイロン', cost: 40, maxActive: 1,
    desc: '半径10mの味方トークンの連射+30%。',
    spawn: (w, c, s, t, p) => new BoosterUnit(w, c, s, t, p),
  },
  chaser: {
    key: 'chaser', name: 'チェイサー', cost: 35, maxActive: 2,
    desc: '犬型。敵将を追跡し、接触で12dmg+5秒マップ表示。',
    spawn: (w, c, s, t, p) => new ChaserUnit(w, c, s, t, p),
  },
  bomber: {
    key: 'bomber', name: 'ボムスリンガー', cost: 50, maxActive: 1,
    desc: '曲射砲台。遮蔽越しに爆発弾(18dmg)を撃ち込む。',
    spawn: (w, c, s, t, p) => new BomberUnit(w, c, s, t, p),
  },
  jammer: {
    key: 'jammer', name: 'ジャマーポッド', cost: 40, maxActive: 1,
    desc: '半径9mの敵トークンの索敵距離を半減。',
    spawn: (w, c, s, t, p) => new JammerUnit(w, c, s, t, p),
  },
  sniperdrone: {
    key: 'sniperdrone', name: 'スナイパードローン', cost: 50, maxActive: 1,
    desc: '浮遊狙撃機。射程45m・18dmg。脆い。',
    spawn: (w, c, s, t, p) => new SniperDroneUnit(w, c, s, t, p),
  },
}

/** キャラごとの配備スロット(標準3+固有1) */
export function loadoutFor(uniqueToken: string): string[] {
  return ['gunner', 'sentry', 'healer', uniqueToken]
}
