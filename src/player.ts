import * as THREE from 'three'
import { World } from './world'
import { Combat } from './combat'
import { Sfx } from './sfx'
import { Input } from './input'
import {
  TEAM_COLOR, enemyOf,
  ENERGY_MAX, ENERGY_CHARGE_RATE, ENERGY_PASSIVE_RATE, ENERGY_PASSIVE_DELAY, CHARGE_SPEED_MUL,
  TP_REGEN_BASE,
  type CharacterDef, type Team, type Unit,
} from './types'
import { TOKENS, DecoyUnit, loadoutFor } from './tokens'
import { buildViewmodel } from './models'
import { settings } from './settings'

const GRAVITY = 20
const EYE = 1.6
const HALF = 0.4
const HEIGHT = 1.7

export class PlayerCommander implements Unit {
  id: number
  team: Team = 'blue'
  kind = 'commander'
  name: string
  hp: number
  maxHp: number
  alive = true
  isCommander = true
  stealthed = false
  group = new THREE.Group()
  hitMeshes: THREE.Mesh[] = []
  radius = 0.45
  height = HEIGHT

  char: CharacterDef
  loadout: string[]
  pos = new THREE.Vector3()
  vel = new THREE.Vector3()
  yaw = 0
  pitch = 0
  onGround = true
  energy = ENERGY_MAX
  charging = false
  skillCd = 0
  skillActiveT = 0
  tp = 50
  tpMax = 100
  tpRegenMul = 1
  regenDelay = 0
  invulnT = 0
  /** 戦績カウンタ */
  shotsFired = 0
  shotsHit = 0
  deploysCount = 0

  onHit: (() => void) | null = null
  onDamaged: ((amount: number) => void) | null = null
  onMessage: ((msg: string) => void) | null = null

  private world: World
  private combat: Combat
  private sfx: Sfx
  private input: Input
  private camera: THREE.PerspectiveCamera
  private viewmodel: THREE.Group
  private muzzle: THREE.Object3D
  private fireCd = 0
  private burstLeft = 0
  private burstT = 0
  private lastFireT = 99
  private dashT = 0
  private dashDir = new THREE.Vector3()
  private armorT = 0
  private bobT = 0
  private vmKick = 0
  private deployRay = new THREE.Raycaster()
  private energyWarned = false
  private shakeT = 0
  private shakeAmp = 0
  private recoilP = 0
  private recoilY = 0

  constructor(
    world: World, combat: Combat, sfx: Sfx, input: Input,
    char: CharacterDef, spawn: THREE.Vector3, camera: THREE.PerspectiveCamera,
  ) {
    this.world = world
    this.combat = combat
    this.sfx = sfx
    this.input = input
    this.char = char
    this.camera = camera
    this.id = world.allocId()
    this.name = char.name
    this.hp = this.maxHp = char.hp
    this.loadout = loadoutFor(char.uniqueToken)
    this.pos.copy(spawn)
    // 中央を向いてスタート(カメラは-Zが前方: forward = (-sin yaw, -cos yaw))
    this.yaw = Math.atan2(spawn.x, spawn.z)
    this.camera.rotation.order = 'YXZ'

    const hitGeo = new THREE.CylinderGeometry(0.42, 0.42, HEIGHT, 8)
    const hitMat = new THREE.MeshBasicMaterial({ visible: false })
    const hitbox = new THREE.Mesh(hitGeo, hitMat)
    hitbox.position.y = HEIGHT / 2
    this.group.add(hitbox)
    this.hitMeshes = [hitbox]
    this.group.position.copy(this.pos)

    this.viewmodel = buildViewmodel(char)
    this.viewmodel.scale.setScalar(0.8)
    this.viewmodel.position.set(0.22, -0.2, -0.48)
    this.muzzle = this.viewmodel.userData.muzzle as THREE.Object3D
    camera.add(this.viewmodel)
    // マズルライト(発砲時に周囲を照らす)
    this.muzzleLight = new THREE.PointLight(char.weapon.boltColor, 0, 9, 2)
    this.muzzleLight.position.set(0.22, -0.15, -0.9)
    camera.add(this.muzzleLight)
  }

  private muzzleLight!: THREE.PointLight

  get weapon() {
    return this.char.weapon
  }

  /** リスポーン */
  respawn(spawn: THREE.Vector3, invuln: number) {
    this.pos.copy(spawn)
    this.vel.set(0, 0, 0)
    this.yaw = Math.atan2(spawn.x, spawn.z)
    this.pitch = 0
    this.hp = this.maxHp
    this.energy = ENERGY_MAX
    this.alive = true
    this.stealthed = false
    this.skillActiveT = 0
    this.invulnT = invuln
    this.regenDelay = 0
    this.group.position.copy(this.pos)
  }

  private flatForward() {
    return new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw))
  }

  update(dt: number) {
    if (!this.alive) return
    const input = this.input
    const w = this.weapon
    this.invulnT = Math.max(0, this.invulnT - dt)
    this.lastFireT += dt

    // --- 視点 ---
    const zoomed = input.mouseRight && !this.charging
    const sens = 0.0022 * settings.sens * (this.camera.fov / 75)
    this.yaw -= input.mouseDX * sens
    this.pitch -= input.mouseDY * sens
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch))

    // --- エネルギーチャージ(Rホールド。無防備) ---
    this.charging = input.keys.has('KeyR') && this.energy < ENERGY_MAX - 0.5
    if (this.charging) {
      this.energy = Math.min(ENERGY_MAX, this.energy + ENERGY_CHARGE_RATE * dt)
    } else if (this.lastFireT > ENERGY_PASSIVE_DELAY) {
      this.energy = Math.min(ENERGY_MAX, this.energy + ENERGY_PASSIVE_RATE * dt)
    }
    if (this.energy > 25) this.energyWarned = false

    // --- 移動 ---
    const fwd = this.flatForward()
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw))
    const wish = new THREE.Vector3()
    if (input.keys.has('KeyW')) wish.add(fwd)
    if (input.keys.has('KeyS')) wish.sub(fwd)
    if (input.keys.has('KeyD')) wish.add(right)
    if (input.keys.has('KeyA')) wish.sub(right)
    const moving = wish.lengthSq() > 0
    if (moving) wish.normalize()
    const sprinting = input.keys.has('ShiftLeft') && input.keys.has('KeyW') && !zoomed && !this.charging
    let speed = sprinting ? 8.5 : 6
    if (zoomed) speed *= 0.55
    if (this.charging) speed *= CHARGE_SPEED_MUL
    const accel = this.onGround ? 12 : 3
    const k = 1 - Math.exp(-accel * dt)
    this.vel.x += (wish.x * speed - this.vel.x) * k
    this.vel.z += (wish.z * speed - this.vel.z) * k

    if (input.keys.has('Space') && this.onGround) {
      this.vel.y = 7.2
      this.onGround = false
    }
    this.vel.y -= GRAVITY * dt

    if (this.dashT > 0) {
      this.dashT -= dt
      this.vel.x = this.dashDir.x * 24
      this.vel.z = this.dashDir.z * 24
    }

    this.integrate(dt)

    // --- スキル ---
    this.skillCd = Math.max(0, this.skillCd - dt)
    this.armorT = Math.max(0, this.armorT - dt)
    if (this.skillActiveT > 0) {
      this.skillActiveT -= dt
      if (this.skillActiveT <= 0 && (this.char.skill.key === 'cloak' || this.char.skill.key === 'decoy')) {
        this.stealthed = false
      }
    }
    if (input.consume('KeyE') && this.skillCd <= 0) this.activateSkill(moving ? wish : fwd)

    // --- カメラ更新 ---
    this.bobT += dt * (moving && this.onGround ? (sprinting ? 13 : 10) : 0)
    const bob = Math.sin(this.bobT) * 0.035 * (moving && this.onGround ? 1 : 0)
    // リコイルは視覚オフセットとして適用し、自動で戻る(エイムは安定)
    const decay = Math.exp(-dt * 9)
    this.recoilP *= decay
    this.recoilY *= decay
    this.camera.position.set(this.pos.x, this.pos.y + EYE + bob, this.pos.z)
    this.camera.rotation.set(this.pitch + this.recoilP, this.yaw + this.recoilY, 0)
    // 被弾カメラシェイク
    if (this.shakeT > 0) {
      this.shakeT -= dt
      const k = this.shakeAmp * (this.shakeT / 0.18)
      this.camera.rotation.x += (Math.random() - 0.5) * k
      this.camera.rotation.z += (Math.random() - 0.5) * k * 0.6
    }
    const targetFov = zoomed ? w.zoomFov : 75
    if (Math.abs(this.camera.fov - targetFov) > 0.05) {
      this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 14)
      this.camera.updateProjectionMatrix()
    }
    this.vmKick = Math.max(0, this.vmKick - dt * 0.6)
    this.muzzleLight.intensity *= Math.exp(-dt * 16)
    this.viewmodel.position.set(
      zoomed ? 0.09 : 0.22,
      (zoomed ? -0.15 : -0.2) + Math.sin(this.bobT * 0.5) * 0.006,
      (this.charging ? -0.36 : -0.48) + this.vmKick,
    )
    this.viewmodel.rotation.x = this.charging ? 0.5 : 0
    this.camera.updateMatrixWorld()

    // --- 射撃 ---
    this.fireCd -= dt
    const od = this.char.skill.key === 'overdrive' && this.skillActiveT > 0
    const rate = w.rate * (od ? 1.6 : 1)
    const cost = w.energyCost * (od ? 0.5 : 1)
    // バースト処理
    if (this.burstLeft > 0) {
      this.burstT -= dt
      if (this.burstT <= 0) {
        this.burstT = w.burstInterval ?? 0.07
        this.burstLeft--
        this.emitShot(moving, zoomed)
      }
    }
    const trigger = w.auto ? input.mouseDown : input.mousePressed
    if (trigger && !this.charging && this.fireCd <= 0 && this.burstLeft <= 0) {
      if (this.energy >= cost) {
        this.energy -= cost
        this.fireCd = 1 / rate
        this.lastFireT = 0
        if (w.burst) {
          this.burstLeft = w.burst
          this.burstT = 0
        } else {
          this.emitShot(moving, zoomed)
        }
      } else if (!this.energyWarned) {
        this.energyWarned = true
        this.onMessage?.('エネルギー不足 — R長押しでチャージ')
        this.sfx.denied()
      }
    }

    // --- 配備 ---
    for (let i = 0; i < 4; i++) {
      if (input.consume(`Digit${i + 1}`)) this.tryDeploy(i)
    }

    // --- 回復・TP ---
    if (this.regenDelay > 0) this.regenDelay -= dt
    else this.hp = Math.min(this.maxHp, this.hp + 10 * dt)
    this.tp = Math.min(this.tpMax, this.tp + TP_REGEN_BASE * this.tpRegenMul * dt)

    this.group.position.copy(this.pos)
    this.group.updateMatrixWorld()
  }

  /** 1発(ペレット束)を発射 */
  private emitShot(moving: boolean, zoomed: boolean) {
    const w = this.weapon
    if (this.stealthed) {
      this.stealthed = false
      this.skillActiveT = 0
      this.onMessage?.('迷彩解除')
    }
    const dir = this.camera.getWorldDirection(new THREE.Vector3())
    let spread = w.spread * (zoomed ? 0.45 : 1)
    if (moving) spread *= 1.5
    if (!this.onGround) spread *= 2.0
    const muzzlePos = this.muzzle.getWorldPosition(new THREE.Vector3())
    this.shotsFired++
    for (let i = 0; i < w.pellets; i++) {
      const d = this.combat.spreadDir(dir, spread)
      this.combat.fireBolt(muzzlePos.clone(), d, {
        damage: w.damage,
        team: this.team,
        from: this,
        speed: w.boltSpeed,
        falloff: w.falloff,
        color: w.boltColor,
        explosive: w.explosive,
        gravity: w.gravity,
        maxRange: 120,
        size: w.explosive ? 0.16 : 0.085,
      })
    }
    this.combat.fx.flash(muzzlePos, w.boltColor, 0.05)
    this.muzzleLight.intensity = 9
    this.sfx.shot(w.energyCost > 10)
    // リコイル(視覚キック。自動で戻るのでエイムは安定)
    this.recoilP = Math.min(0.12, this.recoilP + w.recoil * (0.7 + Math.random() * 0.5))
    this.recoilY += (Math.random() - 0.5) * w.recoil * 0.6
    this.vmKick = Math.min(0.08, this.vmKick + (w.energyCost > 10 ? 0.06 : 0.022))
  }

  /** 着弾コールバック(combatから) */
  onBoltHit(_target: Unit) {
    this.shotsHit++
    this.onHit?.()
    this.sfx.hitmarker()
  }

  private integrate(dt: number) {
    const cs = this.world.colliders
    const lim = this.world.arenaHalf - 0.8

    this.pos.x += this.vel.x * dt
    this.pos.x = Math.max(-lim, Math.min(lim, this.pos.x))
    for (const c of cs) {
      if (!this.overlaps(c)) continue
      this.pos.x = this.vel.x > 0 ? c.min.x - HALF : c.max.x + HALF
    }
    this.pos.z += this.vel.z * dt
    this.pos.z = Math.max(-lim, Math.min(lim, this.pos.z))
    for (const c of cs) {
      if (!this.overlaps(c)) continue
      this.pos.z = this.vel.z > 0 ? c.min.z - HALF : c.max.z + HALF
    }
    const prevY = this.pos.y
    this.pos.y += this.vel.y * dt
    this.onGround = false
    if (this.pos.y <= 0) {
      this.pos.y = 0
      this.vel.y = 0
      this.onGround = true
    }
    for (const c of cs) {
      if (!this.overlaps(c)) continue
      if (this.vel.y <= 0 && prevY >= c.max.y - 0.08) {
        this.pos.y = c.max.y
        this.vel.y = 0
        this.onGround = true
      } else if (this.vel.y > 0) {
        this.pos.y = c.min.y - HEIGHT
        this.vel.y = 0
      }
    }
  }

  private overlaps(c: { min: THREE.Vector3; max: THREE.Vector3 }) {
    return (
      this.pos.x + HALF > c.min.x && this.pos.x - HALF < c.max.x &&
      this.pos.z + HALF > c.min.z && this.pos.z - HALF < c.max.z &&
      this.pos.y + HEIGHT > c.min.y && this.pos.y < c.max.y
    )
  }

  private activateSkill(dir: THREE.Vector3) {
    const s = this.char.skill
    this.skillCd = s.cooldown
    this.skillActiveT = s.duration
    this.sfx.skill()
    switch (s.key) {
      case 'dash':
        this.dashT = 0.16
        this.dashDir.copy(dir).setY(0).normalize()
        this.onMessage?.('ブリッツダッシュ!')
        break
      case 'dome':
        this.onMessage?.('バリアドーム展開')
        break
      case 'cloak':
        this.stealthed = true
        this.onMessage?.('光学迷彩 起動')
        break
      case 'repair': {
        this.hp = Math.min(this.maxHp, this.hp + 30)
        let healed = 0
        for (const u of this.world.units) {
          if (u.alive && u.team === this.team && !u.isCommander && u.kind !== 'decoy') {
            if (u.group.position.distanceTo(this.pos) < 12) {
              u.hp = Math.min(u.maxHp, u.hp + 30)
              healed++
            }
          }
        }
        this.combat.fx.ring(this.pos.clone(), 0x6effa8)
        this.onMessage?.(`リペアパルス(トークン${healed}体回復)`)
        break
      }
      case 'overdrive':
        this.onMessage?.('オーバードライブ!!')
        break
      case 'beatdrop': {
        this.armorT = 0.5
        const p = this.pos.clone()
        p.y += 0.9
        this.combat.explode(p, 6, 35, this.team, this, 0xc89bff)
        this.onMessage?.('ビートドロップ!!')
        break
      }
      case 'decoy': {
        const decoy = new DecoyUnit(this.world, this.combat, this.sfx, this.team, this.pos.clone(), this.char, this.yaw + Math.PI)
        this.world.addUnit(decoy)
        this.stealthed = true
        this.onMessage?.('フェイクアウト')
        break
      }
      case 'sonar': {
        this.world.reveal(enemyOf(this.team), s.duration)
        this.onMessage?.('ソナーパルス — 敵将を捕捉')
        break
      }
    }
  }

  private tryDeploy(slot: number) {
    const def = TOKENS[this.loadout[slot]]
    if (!def) return
    if (this.tp < def.cost) {
      this.onMessage?.('TP不足 — フィールドのコアを回収せよ')
      this.sfx.denied()
      return
    }
    if (this.world.countActive(this.team, def.key) >= def.maxActive) {
      this.onMessage?.(`${def.name}は同時${def.maxActive}体まで`)
      this.sfx.denied()
      return
    }
    // --- 配備先の決定(寛容な照準): 狙った方向を地面に投影し、必ず置ける点を探す ---
    const origin = this.camera.position.clone()
    const dir = this.camera.getWorldDirection(new THREE.Vector3())
    const MAXD = 30
    const target = new THREE.Vector3()

    // 1) まず障害物レイで「平らな低い地面」に当たればそこを使う
    this.deployRay.set(origin.clone(), dir.clone())
    this.deployRay.near = 0.1
    this.deployRay.far = MAXD
    const hits = this.deployRay.intersectObjects(this.world.obstacleMeshes, false)
    const flatHit = hits.find((h) => h.point.y < 1.2 && (!h.face || h.face.normal.y > 0.6))
    const blockedDist = hits.length ? hits[0].distance : Infinity

    if (flatHit && flatHit.distance <= blockedDist + 0.05) {
      target.copy(flatHit.point)
    } else {
      // 2) 障害物に阻まれた/空を向いている → 視線を地面平面(y=0)へ投影
      if (dir.y < -0.02) {
        const t = origin.y / -dir.y // y=0 に達するまでの距離
        if (t > 1 && t <= MAXD) target.copy(origin).addScaledVector(dir, t)
      }
      // 3) それでも決まらなければ足元前方に置く
      if (target.lengthSq() === 0) {
        const fwd = this.flatForward()
        target.copy(this.pos).addScaledVector(fwd, 6)
      }
      // 障害物の手前までに制限(壁の向こうには置かない)
      if (blockedDist < origin.distanceTo(target)) {
        target.copy(origin).addScaledVector(dir, Math.max(2, blockedDist - 1))
      }
      target.y = 0
    }
    target.y = 0

    // 4) 配備不可セルなら、プレイヤー方向へ少しずつ寄せて空きを探す
    const lim = this.world.arenaHalf - 1.5
    target.x = Math.max(-lim, Math.min(lim, target.x))
    target.z = Math.max(-lim, Math.min(lim, target.z))
    if (!this.world.nav.isFree(target.x, target.z)) {
      const toMe = this.pos.clone().sub(target).setY(0).normalize()
      let found = false
      for (let step = 1.5; step <= 9; step += 1.5) {
        const c = target.clone().addScaledVector(toMe, step)
        if (this.world.nav.isFree(c.x, c.z)) {
          target.copy(c)
          found = true
          break
        }
      }
      if (!found) {
        this.onMessage?.('近くに配備できる空きがない')
        this.sfx.denied()
        return
      }
    }

    this.tp -= def.cost
    this.deploysCount++
    const facing = dir.clone().setY(0)
    if (facing.lengthSq() < 1e-4) facing.copy(this.flatForward())
    facing.normalize()
    const unit = def.spawn(this.world, this.combat, this.sfx, this.team, new THREE.Vector3(target.x, 0, target.z), facing)
    this.world.addUnit(unit)
    this.combat.fx.ring(new THREE.Vector3(target.x, 0, target.z), TEAM_COLOR[this.team])
    this.sfx.deploy()
    this.onMessage?.(`${def.name} 配備(分裂)`)
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
    this.shakeT = 0.18
    this.shakeAmp = Math.min(0.035, 0.008 + d * 0.0009)
    this.onDamaged?.(d)
    this.sfx.damaged()
    if (this.hp <= 0) {
      this.hp = 0
      this.alive = false
      this.world.notifyKill(this, from)
    }
  }
}
