import * as THREE from 'three'
import { World } from './world'
import { Combat } from './combat'
import { Sfx } from './sfx'
import { Input } from './input'
import {
  TEAM_COLOR, enemyOf,
  ENERGY_MAX, ENERGY_CHARGE_RATE, ENERGY_PASSIVE_RATE, ENERGY_PASSIVE_DELAY, CHARGE_SPEED_MUL,
  TP_REGEN_BASE, INVULN_ON_FIRE,
  type CharacterDef, type Team, type Unit,
} from './types'
import { TOKENS, DecoyUnit, loadoutFor } from './tokens'
import { buildViewmodel } from './models'
import { getScenery } from './modelLoader'
import { settings, keybinds, keyLabel, type KeyAction } from './settings'
import { ChargeState, chargeShotParams } from './chargeWeapon'

const GRAVITY = 20 // 上昇時の基本重力
const FALL_MULT = 1.7 // 落下時は重力を強めて締まったアーチに(浮わつき防止)
const LOWJUMP_MULT = 3.0 // 上昇中にジャンプを離したら追加重力(短ホップ=可変ジャンプ高)
const JUMP_VEL = 7.8
const COYOTE_TIME = 0.11 // 縁を離れてからジャンプを許す猶予
const STEP_HEIGHT = 0.4 // この高さ以下の段差は自動で乗り越える
const EYE = 1.6
const HALF = 0.4
const HEIGHT = 1.7

/**
 * FP武器ビューモデルを作る。フェアリィ・エネルギーブラスターのGLBが
 * ロード済みならそれを使い(銃口を-Zへ正規化・先端にマズル)、
 * 無ければ従来のプロシージャル武器(キャラ別)にフォールバックする。
 */
function buildWeaponViewmodel(char: CharacterDef): THREE.Group {
  const glb = getScenery('weapon_blaster')
  if (!glb) return buildViewmodel(char)
  // 元モデルは銃身が+Z(カメラ側)向き → -Z(前方)へ180°回転
  glb.rotation.set(0, Math.PI, 0)
  const box = new THREE.Box3().setFromObject(glb)
  const size = box.getSize(new THREE.Vector3())
  const s = 0.46 / Math.max(0.001, size.z, size.x)
  glb.scale.setScalar(s)
  const c = new THREE.Box3().setFromObject(glb).getCenter(new THREE.Vector3())
  glb.position.sub(c)
  glb.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.isMesh) { m.castShadow = false; m.receiveShadow = false }
  })
  const wrap = new THREE.Group()
  wrap.add(glb)
  const muzzleZ = new THREE.Box3().setFromObject(glb).min.z - 0.02
  const muzzle = new THREE.Object3D()
  muzzle.position.set(0, 0, muzzleZ)
  wrap.add(muzzle)
  wrap.userData.muzzle = muzzle
  return wrap
}

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
  /** チャージ武器の溜め量 0..1(HUD表示用。非チャージ武器は常に0) */
  chargeLevel = 0
  private chargeState = new ChargeState()
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
  /** オンラインclient用: 配備先(token,x,z)決定時に呼ぶ。trueを返すとローカル生成を抑止(ホスト権威でspawn) */
  onDeploy: ((tokenKey: string, x: number, z: number) => boolean) | null = null
  /** オンラインclient用: スキル発動時に呼ぶ。trueを返すとローカル効果を抑止(ホスト権威で適用、結果はsnapshot反映) */
  onSkill: (() => boolean) | null = null
  /** 同時数カウント源。オンラインclientは自配備トークンがworld.units外のpuppetなので注入で上書きする(既定=world.countActive) */
  countActiveFn: ((team: Team, kind: string) => number) | null = null

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
  private vmKick = 0 // ビューモデルの後方(+Z)押し戻し量
  private vmRotX = 0 // ビューモデルの銃口跳ね上がり(発砲反動。+Xで銃口が上=muzzle climb)
  private deployRay = new THREE.Raycaster()
  private energyWarned = false
  private shakeT = 0
  private shakeAmp = 0
  private recoilP = 0
  private recoilY = 0
  // --- プレイ感(物理フィール) ---
  private coyote = 0 // 接地後の猶予(縁を離れた直後も飛べる)
  private jumpHeld = false // ジャンプ保持中か(可変ジャンプ高用)
  private landDip = 0 // 着地のカメラ沈み込み量(自然減衰)
  private prevVelY = 0 // 直前フレームの落下速度(着地衝撃の算出)
  private stepPhase = 0 // 足音用の歩行位相

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

    this.viewmodel = buildWeaponViewmodel(char)
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
    this.chargeState.reset()
    this.chargeLevel = 0
    this.charging = false
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
    // チャージ武器は溜め中にスコープイン(右クリックでも可)。通常武器は従来どおり右クリックADS。
    const zoomed = w.charger ? (this.charging || input.mouseRight) : (input.mouseRight && !this.charging)
    const sens = 0.0022 * settings.sens * (this.camera.fov / 75)
    this.yaw -= input.mouseDX * sens
    this.pitch -= input.mouseDY * sens
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch))

    // --- チャージ / エネルギー ---
    let chargeFire = 0 // チャージ武器: このフレームで発射するなら frac>0
    if (w.charger) {
      // トリガー(左クリック)ホールドで溜める。エネルギー残量制は使わない。溜め中は this.charging=移動スロー&構え
      chargeFire = this.chargeState.step(w.charger, input.mouseDown, dt)
      this.charging = this.chargeState.level > 0
      this.chargeLevel = this.chargeState.level
    } else {
      // エネルギーチャージ(Rホールド。無防備)
      this.charging = input.down('charge') && this.energy < ENERGY_MAX - 0.5
      if (this.charging) {
        this.energy = Math.min(ENERGY_MAX, this.energy + ENERGY_CHARGE_RATE * dt)
      } else if (this.lastFireT > ENERGY_PASSIVE_DELAY) {
        this.energy = Math.min(ENERGY_MAX, this.energy + ENERGY_PASSIVE_RATE * dt)
      }
      if (this.energy > 25) this.energyWarned = false
    }

    // --- 移動 ---
    const fwd = this.flatForward()
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw))
    const wish = new THREE.Vector3()
    if (input.down('forward')) wish.add(fwd)
    if (input.down('back')) wish.sub(fwd)
    if (input.down('right')) wish.add(right)
    if (input.down('left')) wish.sub(right)
    const moving = wish.lengthSq() > 0
    if (moving) wish.normalize()
    const sprinting = input.down('sprint') && input.down('forward') && !zoomed && !this.charging
    let speed = sprinting ? 8.5 : 6
    if (zoomed) speed *= 0.55
    if (this.charging) speed *= CHARGE_SPEED_MUL
    // 地上は機敏に、空中もそこそこ利く(被弾回避・微調整が気持ちよく決まる)
    const accel = this.onGround ? 13 : 5.5
    const k = 1 - Math.exp(-accel * dt)
    this.vel.x += (wish.x * speed - this.vel.x) * k
    this.vel.z += (wish.z * speed - this.vel.z) * k

    // --- ジャンプ(コヨーテタイム + 可変ジャンプ高 + 非対称重力) ---
    this.coyote = this.onGround ? COYOTE_TIME : Math.max(0, this.coyote - dt)
    const spaceDown = input.down('jump')
    // 接地中/猶予中に押下した瞬間だけ踏み切る(上昇中の連続発火は防ぐ)
    if (spaceDown && !this.jumpHeld && this.coyote > 0 && this.vel.y <= 0.1) {
      this.vel.y = JUMP_VEL
      this.onGround = false
      this.coyote = 0
      this.sfx.jump()
    }
    this.jumpHeld = spaceDown
    // 非対称重力: 落下は重く、上昇中にボタンを離すと一気に減速(短ホップ)
    let g = GRAVITY
    if (this.vel.y < 0) g *= FALL_MULT
    else if (this.vel.y > 0 && !spaceDown) g *= LOWJUMP_MULT
    this.vel.y -= g * dt

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
    if (input.hit('skill') && this.skillCd <= 0) this.activateSkill(moving ? wish : fwd)

    // --- カメラ更新 ---
    const stepRate = sprinting ? 13 : 10
    this.bobT += dt * (moving && this.onGround ? stepRate : 0)
    const bob = Math.sin(this.bobT) * 0.035 * (moving && this.onGround ? 1 : 0)
    // 足音: 歩行位相が半周(=一歩)するたびに控えめに鳴らす
    if (moving && this.onGround) {
      this.stepPhase += dt * stepRate
      if (this.stepPhase >= Math.PI) {
        this.stepPhase -= Math.PI
        this.sfx.footstep(sprinting ? 0.07 : 0.045)
      }
    } else {
      this.stepPhase = Math.PI * 0.5 // 歩き出しの一歩目が早く出るように位相を進めておく
    }
    // 着地の沈み込み(自然に戻る)
    this.landDip += (0 - this.landDip) * Math.min(1, dt * 11)
    // リコイルは視覚オフセットとして適用し、自動で戻る(エイムは安定)
    const decay = Math.exp(-dt * 9)
    this.recoilP *= decay
    this.recoilY *= decay
    this.camera.position.set(this.pos.x, this.pos.y + EYE + bob - this.landDip, this.pos.z)
    this.camera.rotation.set(this.pitch + this.recoilP, this.yaw + this.recoilY, 0)
    // 被弾カメラシェイク
    if (this.shakeT > 0) {
      this.shakeT -= dt
      const k = this.shakeAmp * (this.shakeT / 0.18)
      this.camera.rotation.x += (Math.random() - 0.5) * k
      this.camera.rotation.z += (Math.random() - 0.5) * k * 0.6
    }
    // スプリント中はFOVをわずかに広げて疾走感を出す
    const targetFov = zoomed ? w.zoomFov : (sprinting && moving && this.onGround ? 82 : 75)
    if (Math.abs(this.camera.fov - targetFov) > 0.05) {
      this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 14)
      this.camera.updateProjectionMatrix()
    }
    // 反動は指数減衰で素早く戻す(線形だと戻りが間延びして「ふわっ」と感じる。カメラリコイルの減衰感と揃える)
    this.vmKick *= Math.exp(-dt * 12)
    this.vmRotX *= Math.exp(-dt * 10)
    this.muzzleLight.intensity *= Math.exp(-dt * 16)
    this.viewmodel.position.set(
      zoomed ? 0.09 : 0.22,
      (zoomed ? -0.15 : -0.2) + Math.sin(this.bobT * 0.5) * 0.006,
      (this.charging ? -0.36 : -0.48) + this.vmKick,
    )
    // チャージの構え(0.5)に、発砲ごとの銃口跳ね上がり(vmRotX)を加算合成
    this.viewmodel.rotation.x = (this.charging ? 0.5 : 0) + this.vmRotX
    this.camera.updateMatrixWorld()

    // --- 射撃 ---
    this.fireCd -= dt
    // チャージ武器: 溜め完了/離した瞬間に1撃。通常のトリガー/エネルギー処理は通さない。
    if (w.charger) {
      if (chargeFire > 0) this.emitChargedShot(w.charger, chargeFire, moving, zoomed)
      // 以降の通常射撃ロジックはスキップ(配備処理へ)
    } else {
    const od = this.char.skill.key === 'overdrive' && this.skillActiveT > 0
    const rate = w.rate * (od ? 1.6 : 1)
    const cost = w.energyCost * (od ? 0.5 : 1)
    // バースト処理
    if (this.burstLeft > 0) {
      this.burstT -= dt
      if (this.burstT <= 0) {
        this.burstT = w.burstInterval ?? 0.07
        this.burstLeft--
        this.emitShot(moving, zoomed, sprinting)
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
          this.emitShot(moving, zoomed, sprinting)
        }
      } else if (!this.energyWarned) {
        this.energyWarned = true
        this.onMessage?.(`エネルギー不足 — ${keyLabel(keybinds.charge)}長押しでチャージ`)
        this.sfx.denied()
      }
    }
    } // end 通常射撃(非チャージ武器)

    // --- 配備 ---
    for (let i = 0; i < 4; i++) {
      if (input.hit(`deploy${i + 1}` as KeyAction)) this.tryDeploy(i)
    }

    // --- 回復・TP ---
    if (this.regenDelay > 0) this.regenDelay -= dt
    else this.hp = Math.min(this.maxHp, this.hp + 10 * dt)
    this.tp = Math.min(this.tpMax, this.tp + TP_REGEN_BASE * this.tpRegenMul * dt)

    this.group.position.copy(this.pos)
    this.group.updateMatrixWorld()
  }

  /** 1発(ペレット束)を発射 */
  private emitShot(moving: boolean, zoomed: boolean, sprinting = false) {
    const w = this.weapon
    // 発砲した瞬間にスポーン無敵を解除(短く残す)=無敵のまま撃ち返す悪用を封じる(アリーナFPSの確立手法)
    if (this.invulnT > INVULN_ON_FIRE) this.invulnT = INVULN_ON_FIRE
    if (this.stealthed) {
      this.stealthed = false
      this.skillActiveT = 0
      this.onMessage?.('迷彩解除')
    }
    const dir = this.camera.getWorldDirection(new THREE.Vector3())
    let spread = w.spread * (zoomed ? 0.45 : 1)
    // 速度⇄精度のスキル選択: 立ち撃ち=最精密、歩き撃ち=やや散る、スプリント撃ち=大きく散る、空中=最も散る。
    // 止まって/しゃがんで(ADS)正確に当てる判断と、機動で被弾を避ける判断のトレードオフを作る。
    if (moving) spread *= sprinting ? 2.2 : 1.4
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
    const heavy = w.energyCost > 10
    this.vmKick = Math.min(0.08, this.vmKick + (heavy ? 0.06 : 0.022))
    // 銃口跳ね上がり: 重い弾ほど大きく跳ねる。位置キックと合わせて「撃った手応え」を出す
    this.vmRotX = Math.min(0.16, this.vmRotX + (heavy ? 0.1 : 0.045))
  }

  /** チャージ武器の発射(frac=溜め量)。威力/弾速/射程が溜め量で伸び、フルは貫通・超長距離1撃。 */
  private emitChargedShot(cd: import('./types').ChargerDef, frac: number, moving: boolean, _zoomed: boolean) {
    const w = this.weapon
    const p = chargeShotParams(cd, frac)
    if (this.invulnT > INVULN_ON_FIRE) this.invulnT = INVULN_ON_FIRE
    if (this.stealthed) { this.stealthed = false; this.skillActiveT = 0; this.onMessage?.('迷彩解除') }
    const dir = this.camera.getWorldDirection(new THREE.Vector3())
    // チャージャーは精密。溜め切れていれば散らさず、移動中のみ僅かに散る(立ち撃ち推奨)
    const spread = w.spread * (moving ? 1.6 : 1) * (1.2 - p.frac * 0.4)
    const d = this.combat.spreadDir(dir, spread)
    const muzzlePos = this.muzzle.getWorldPosition(new THREE.Vector3())
    this.shotsFired++
    this.combat.fireBolt(muzzlePos.clone(), d, {
      damage: p.damage,
      team: this.team,
      from: this,
      speed: p.speed,
      // チャージャーは距離減衰なし(射程内は満額)。射程はmaxRangeで頭打ち。
      color: w.boltColor,
      maxRange: p.range,
      pierce: p.pierce,
      size: 0.1 + p.frac * 0.13, // 溜めるほど太い極光
    })
    this.combat.fx.flash(muzzlePos, w.boltColor, 0.06 + p.frac * 0.06)
    this.muzzleLight.intensity = 9 + p.frac * 8
    this.sfx.shot(true)
    // フルチャージほど強い反動(視覚のみ。自動で戻る)
    this.recoilP = Math.min(0.18, this.recoilP + (0.05 + p.frac * 0.08))
    this.recoilY += (Math.random() - 0.5) * 0.03
    this.vmKick = Math.min(0.1, this.vmKick + 0.04 + p.frac * 0.05)
    this.vmRotX = Math.min(0.2, this.vmRotX + 0.08 + p.frac * 0.08)
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
    const wasGrounded = this.onGround
    const fallV = this.vel.y // 着地衝撃の判定用(重力適用後の下向き速度)

    // 低い段差は壁で止めず自動で乗り越える(小さな縁に引っかからず気持ちよく動ける)
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
    // 着地イベント: 落下からの接地時に衝撃の強さでカメラを沈ませSEを鳴らす
    if (this.onGround && !wasGrounded && fallV < -3) {
      const impact = Math.min(1, (-fallV - 3) / 11)
      this.landDip = 0.05 + impact * 0.19
      this.sfx.land(impact)
    }
    this.prevVelY = this.vel.y
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
    // オンラインclient: 効果はホスト権威で適用(結果はsnapshot反映)。ローカルはcd/演出のみ(HUD維持)で実効果は抑止。
    if (this.onSkill && this.onSkill()) return
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
    const activeCount = this.countActiveFn ? this.countActiveFn(this.team, def.key) : this.world.countActive(this.team, def.key)
    if (activeCount >= def.maxActive) {
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
    const hits = this.deployRay.intersectObjects(this.world.obstacleMeshes, false) // 非再帰: 全て単純プロキシ(軽い)
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

    // オンラインclient: ローカル生成せずホストへ配備要求(ホストが権威spawn→snapshotでpuppet描画)。TPはsnapshot権威。
    if (this.onDeploy && this.onDeploy(def.key, target.x, target.z)) {
      this.deploysCount++
      this.combat.fx.ring(new THREE.Vector3(target.x, 0, target.z), TEAM_COLOR[this.team]) // 予測フィードバック(リング演出のみ)
      this.sfx.deploy()
      this.onMessage?.(`${def.name} 配備要求`)
      return
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
