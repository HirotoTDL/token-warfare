import * as THREE from 'three'
import { World } from '../world'
import { Combat } from '../combat'
import { Sfx } from '../sfx'
import {
  ENERGY_MAX, ENERGY_CHARGE_RATE, ENERGY_PASSIVE_RATE, ENERGY_PASSIVE_DELAY, CHARGE_SPEED_MUL,
  TP_REGEN_BASE, TEAM_COLOR, INVULN_ON_FIRE, enemyOf,
  type CharacterDef, type Team, type Unit,
} from '../types'
import { buildMonsterCommander } from '../models'
import { TOKENS, loadoutFor, DecoyUnit } from '../tokens'
import { getModel, animateSkeleton, animateGlbBody } from '../modelLoader'
import type { NetTransport } from './transport'
import type { NetInput } from './netInput'

// 移動物理: player.ts と同一定数(ホスト権威では両プレイヤーが同じ物理で動く必要があるため忠実に複製。
// 【将来課題】PlayerCommander と共有モジュール化して厳密パリティを保証する=Phase1の整理対象)。
const GRAVITY = 20
const FALL_MULT = 1.7
const LOWJUMP_MULT = 3.0
const JUMP_VEL = 7.8
const COYOTE_TIME = 0.11
const STEP_HEIGHT = 0.4
const HALF = 0.4
const HEIGHT = 1.7

/**
 * リモートプレイヤーの将。ホスト側で動作し、ネット越しに受信した NetInput でユニットを駆動する
 * (ローカルの PlayerCommander が input でやることを、受信入力で行う3人称版)。bot と同じくボディを持つ。
 * Phase0=移動/視点/発砲を実装し LoopbackTransport で検証。スキル/配備/デコイ等は Phase1 で拡充。
 */
export class RemoteCommander implements Unit {
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
  height = HEIGHT

  char: CharacterDef
  pos = new THREE.Vector3()
  vel = new THREE.Vector3()
  yaw = 0
  pitch = 0
  onGround = true
  energy = ENERGY_MAX
  charging = false
  tp = 50
  tpRegenMul = 1
  invulnT = 0
  skillCd = 0
  private skillActiveT = 0
  private skillKey = ''
  private armorT = 0

  private world: World
  private combat: Combat
  private sfx: Sfx
  private muzzle: THREE.Object3D | null
  private input: NetInput | null = null
  private lastSeq = -1
  private fireCd = 0
  private lastFireT = 0
  private coyote = 0
  private jumpHeld = false
  private dashT = 0
  private dashDir = new THREE.Vector3()
  private animT = 0
  private animAmp = 0
  private animPrev = new THREE.Vector3()

  constructor(world: World, combat: Combat, sfx: Sfx, char: CharacterDef, team: Team, spawn: THREE.Vector3) {
    this.world = world
    this.combat = combat
    this.sfx = sfx
    this.char = char
    this.team = team
    this.id = world.allocId()
    this.name = char.name
    this.hp = this.maxHp = char.hp
    this.group = getModel(`char_${char.key}`, team) ?? buildMonsterCommander(char, team)
    this.pos.copy(spawn)
    this.pos.y = 0
    this.group.position.copy(this.pos)
    this.muzzle = (this.group.userData.muzzle as THREE.Object3D) ?? null
    this.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) this.hitMeshes.push(o as THREE.Mesh)
    })
    this.animPrev.copy(this.pos)
  }

  /** 受信した入力を反映(最新フレームを採用。Phase1でジッタバッファ/補間を追加) */
  setInput(ni: NetInput) {
    if (ni.seq <= this.lastSeq) return // 古い/重複フレームは破棄
    this.lastSeq = ni.seq
    this.input = ni
  }

  /** トランスポートの 'input' チャンネルを購読してリモート入力を受け取る */
  attach(transport: NetTransport) {
    transport.onMessage((ch, data: any) => {
      if (ch === 'input') this.setInput(data as NetInput)
      else if (ch === 'event' && data && data.type === 'deploy') this.deploy(data.key, data.x, data.z)
      else if (ch === 'event' && data && data.type === 'skill') this.activateSkill()
    })
  }

  /** クライアントのスキル発動をホスト権威で適用(PlayerCommander.activateSkillのミラー。効果はsnapshotで相手にも反映) */
  private activateSkill() {
    const s = this.char.skill
    if (this.skillCd > 0) return // 連打/不正の保険
    this.skillCd = s.cooldown
    this.skillActiveT = s.duration
    this.skillKey = s.key
    if (!this.world.headless) this.sfx.skill()
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw))
    switch (s.key) {
      case 'dash':
        this.dashT = 0.16; this.dashDir.copy(fwd).setY(0).normalize(); break
      case 'cloak':
      case 'decoy':
        this.stealthed = true
        if (s.key === 'decoy') {
          const decoy = new DecoyUnit(this.world, this.combat, this.sfx, this.team, this.pos.clone(), this.char, this.yaw + Math.PI)
          this.world.addUnit(decoy)
        }
        break
      case 'repair': {
        this.hp = Math.min(this.maxHp, this.hp + 30)
        for (const u of this.world.units) {
          if (u.alive && u.team === this.team && !u.isCommander && u.kind !== 'decoy' && u.group.position.distanceTo(this.pos) < 12) {
            u.hp = Math.min(u.maxHp, u.hp + 30)
          }
        }
        if (!this.world.headless) this.combat.fx.ring(this.pos.clone(), 0x6effa8)
        break
      }
      case 'beatdrop': {
        this.armorT = 0.5
        this.combat.explode(this.pos.clone().setY(this.pos.y + 0.9), 6, 35, this.team, this, 0xc89bff)
        break
      }
      case 'sonar':
        this.world.reveal(enemyOf(this.team), s.duration); break
      // dome / overdrive は自己バフ: skillActiveT中に takeDamage / emitShot で適用
    }
  }

  /** クライアントの配備要求をホスト権威で実行(TP/同時数を検証して赤陣営トークンをspawn) */
  private deploy(key: string, x: number, z: number) {
    const def = TOKENS[key]
    if (!def || !loadoutFor(this.char.uniqueToken).includes(key)) return // 不正キー拒否
    if (this.tp < def.cost) return
    if (this.world.countActive(this.team, def.key) >= def.maxActive) return
    this.tp -= def.cost
    const pos = new THREE.Vector3(x, 0, z)
    const facing = pos.clone().sub(this.group.position).setY(0)
    if (facing.lengthSq() < 1e-4) facing.set(0, 0, 1)
    facing.normalize()
    const unit = def.spawn(this.world, this.combat, this.sfx, this.team, pos, facing)
    this.world.addUnit(unit)
    if (!this.world.headless) { this.combat.fx.ring(pos.clone(), TEAM_COLOR[this.team]); this.sfx.deploy() }
  }

  private get weapon() {
    return this.char.weapon
  }

  takeDamage(amount: number, from: Unit | null) {
    if (!this.alive || this.invulnT > 0) return
    let amt = amount
    if (this.skillActiveT > 0) { if (this.skillKey === 'dome') amt *= 0.4; else if (this.skillKey === 'dash') amt *= 0.5 } // 被ダメ軽減スキル
    this.hp -= amt
    this.world.notifyDamage(this, from, amt)
    if (this.hp <= 0) {
      this.alive = false
      this.world.notifyKill(this, from)
      this.group.visible = false
    }
  }

  respawn(spawn: THREE.Vector3, invuln: number) {
    this.pos.copy(spawn)
    this.pos.y = 0
    this.vel.set(0, 0, 0)
    this.hp = this.maxHp
    this.energy = ENERGY_MAX
    this.alive = true
    this.invulnT = invuln
    this.group.visible = true
    this.group.position.copy(this.pos)
  }

  update(dt: number) {
    if (!this.alive) return
    this.invulnT = Math.max(0, this.invulnT - dt)
    this.lastFireT += dt
    this.fireCd -= dt
    this.skillCd = Math.max(0, this.skillCd - dt)
    this.armorT = Math.max(0, this.armorT - dt)
    this.tp = Math.min(100, this.tp + TP_REGEN_BASE * this.tpRegenMul * dt) // 配備用TP回復(コア回収はupdateCores経由)
    // スキル持続の終了処理(cloak/decoyのステルス解除)
    if (this.skillActiveT > 0) {
      this.skillActiveT -= dt
      if (this.skillActiveT <= 0 && (this.skillKey === 'cloak' || this.skillKey === 'decoy')) this.stealthed = false
    }

    const ni = this.input
    if (ni) {
      this.yaw = ni.yaw
      this.pitch = Math.max(-1.45, Math.min(1.45, ni.pitch))
    }
    const mx = ni ? ni.mx : 0
    const mz = ni ? ni.mz : 0
    const wantFire = !!ni && ni.fire
    const wantJump = !!ni && ni.jump
    const wantCharge = !!ni && ni.charge
    const zoomed = !!ni && ni.zoom && !this.charging

    // --- エネルギー(チャージ=無防備, 非射撃時パッシブ回復) ---
    this.charging = wantCharge && this.energy < ENERGY_MAX - 0.5
    if (this.charging) this.energy = Math.min(ENERGY_MAX, this.energy + ENERGY_CHARGE_RATE * dt)
    else if (this.lastFireT > ENERGY_PASSIVE_DELAY) this.energy = Math.min(ENERGY_MAX, this.energy + ENERGY_PASSIVE_RATE * dt)

    // --- 移動(player.ts と同一モデル) ---
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw))
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw))
    const wish = new THREE.Vector3()
    wish.addScaledVector(fwd, mz)
    wish.addScaledVector(right, mx)
    const moving = wish.lengthSq() > 0
    if (moving) wish.normalize()
    const sprinting = mz > 0 && Math.abs(mx) < 0.01 && !zoomed && !this.charging
    let speed = sprinting ? 8.5 : 6
    if (zoomed) speed *= 0.55
    if (this.charging) speed *= CHARGE_SPEED_MUL
    const accel = this.onGround ? 13 : 5.5
    const k = 1 - Math.exp(-accel * dt)
    this.vel.x += (wish.x * speed - this.vel.x) * k
    this.vel.z += (wish.z * speed - this.vel.z) * k

    // ジャンプ(コヨーテ+可変高+非対称重力)
    this.coyote = this.onGround ? COYOTE_TIME : Math.max(0, this.coyote - dt)
    if (wantJump && !this.jumpHeld && this.coyote > 0 && this.vel.y <= 0.1) {
      this.vel.y = JUMP_VEL
      this.onGround = false
      this.coyote = 0
      this.sfx.jump()
    }
    this.jumpHeld = wantJump
    let g = GRAVITY
    if (this.vel.y < 0) g *= FALL_MULT
    else if (this.vel.y > 0 && !wantJump) g *= LOWJUMP_MULT
    this.vel.y -= g * dt

    // ダッシュ(trigger 'dash' で発動。skill本体は Phase1)
    if (ni?.triggers?.includes('dash') && this.dashT <= 0) {
      this.dashT = 0.22
      this.dashDir.copy(moving ? wish : fwd)
    }
    if (this.dashT > 0) {
      this.dashT -= dt
      this.vel.x = this.dashDir.x * 24
      this.vel.z = this.dashDir.z * 24
    }

    this.integrate(dt)

    // --- 発砲 ---
    if (wantFire && this.fireCd <= 0 && !this.charging && this.energy >= this.weapon.energyCost) {
      this.emitShot(moving, zoomed, sprinting)
    }

    // 体の向き=視点ヨー(モデル前面 -Z)。歩行アニメ。
    this.group.position.copy(this.pos)
    this.group.rotation.y = this.yaw
    this.updateWalkAnim(dt)
    this.group.updateMatrixWorld()
  }

  private emitShot(moving: boolean, zoomed: boolean, sprinting: boolean) {
    const w = this.weapon
    if (this.invulnT > INVULN_ON_FIRE) this.invulnT = INVULN_ON_FIRE // 発砲でスポーン無敵を解除(無敵撃ち返し封じ)
    const od = this.skillKey === 'overdrive' && this.skillActiveT > 0 // オーバードライブ: 連射+60%・燃費半減
    this.fireCd = (1 / w.rate) / (od ? 1.6 : 1)
    this.energy -= w.energyCost * (od ? 0.5 : 1)
    this.lastFireT = 0
    // 視点方向(yaw/pitch)から弾道。射撃元は目の高さから(3人称ボディ)。
    const cp = Math.cos(this.pitch)
    const dir = new THREE.Vector3(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp)
    let spread = w.spread * (zoomed ? 0.45 : 1)
    if (moving) spread *= sprinting ? 2.2 : 1.4
    if (!this.onGround) spread *= 2.0
    const origin = this.muzzle ? this.muzzle.getWorldPosition(new THREE.Vector3()) : this.pos.clone().setY(this.pos.y + 1.45)
    for (let i = 0; i < w.pellets; i++) {
      const d = this.combat.spreadDir(dir, spread)
      this.combat.fireBolt(origin.clone(), d, {
        damage: w.damage, team: this.team, from: this, speed: w.boltSpeed,
        falloff: w.falloff, color: w.boltColor, explosive: w.explosive, gravity: w.gravity,
        maxRange: 120, size: w.explosive ? 0.16 : 0.085,
      })
    }
    this.combat.fx.flash(origin, w.boltColor, 0.05)
    this.sfx.shot(w.energyCost > 10)
  }

  /** 着弾コールバック(combatから。命中演出/集計はホスト集約) */
  onBoltHit(_target: Unit) {}

  private overlaps(c: { min: THREE.Vector3; max: THREE.Vector3 }) {
    return (
      this.pos.x + HALF > c.min.x && this.pos.x - HALF < c.max.x &&
      this.pos.z + HALF > c.min.z && this.pos.z - HALF < c.max.z &&
      this.pos.y + HEIGHT > c.min.y && this.pos.y < c.max.y
    )
  }

  private integrate(dt: number) {
    const cs = this.world.colliders
    const lim = this.world.arenaHalf - 0.8
    const tryStep = (c: { min: THREE.Vector3; max: THREE.Vector3 }) => {
      const up = c.max.y - this.pos.y
      if (this.vel.y <= 0.5 && up > 0.01 && up <= STEP_HEIGHT) {
        this.pos.y = c.max.y
        if (this.vel.y < 0) this.vel.y = 0
        this.onGround = true
        return true
      }
      return false
    }
    this.pos.x += this.vel.x * dt
    this.pos.x = Math.max(-lim, Math.min(lim, this.pos.x))
    for (const c of cs) {
      if (!this.overlaps(c)) continue
      if (tryStep(c)) continue
      this.pos.x = this.vel.x > 0 ? c.min.x - HALF : c.max.x + HALF
    }
    this.pos.z += this.vel.z * dt
    this.pos.z = Math.max(-lim, Math.min(lim, this.pos.z))
    for (const c of cs) {
      if (!this.overlaps(c)) continue
      if (tryStep(c)) continue
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

  private updateWalkAnim(dt: number) {
    const p = this.pos
    const dx = p.x - this.animPrev.x
    const dz = p.z - this.animPrev.z
    const sp = Math.sqrt(dx * dx + dz * dz) / Math.max(dt, 1e-3)
    this.animPrev.copy(p)
    const targetAmp = Math.min(1, sp / 5)
    this.animAmp += (targetAmp - this.animAmp) * Math.min(1, dt * 10)
    this.animT += dt * (5 + sp * 1.5)
    if (this.group.userData.bones) animateSkeleton(this.group, this.animT, this.animAmp, this.yaw, this.pitch)
    else animateGlbBody(this.group, this.animT, this.animAmp)
  }
}
