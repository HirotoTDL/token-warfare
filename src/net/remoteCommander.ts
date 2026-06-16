import * as THREE from 'three'
import { World } from '../world'
import { Combat } from '../combat'
import { Sfx } from '../sfx'
import {
  ENERGY_MAX, ENERGY_CHARGE_RATE, ENERGY_PASSIVE_RATE, ENERGY_PASSIVE_DELAY, CHARGE_SPEED_MUL,
  TP_REGEN_BASE, TEAM_COLOR, INVULN_ON_FIRE, enemyOf,
  type CharacterDef, type Team, type Unit, type WeaponDef,
} from '../types'
import { buildMonsterCommander } from '../models'
import { TOKENS, loadoutFor, DecoyUnit } from '../tokens'
import { getModel, animateSkeleton, animateGlbBody } from '../modelLoader'
import { ChargeState, chargeShotParams } from '../chargeWeapon'
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
  chargeLevel = 0
  private chargeState = new ChargeState()
  tp = 50
  tpRegenMul = 1
  invulnT = 0
  skillCd = 0
  private skillActiveT = 0
  private skillKey = ''
  private armorT = 0
  private regenDelay = 0 // 被弾後この秒数はHP回復しない(PlayerCommanderと同一の自動回復モデル)

  private world: World
  private combat: Combat
  private sfx: Sfx
  private muzzle: THREE.Object3D | null
  private input: NetInput | null = null
  private lastSeq = -1
  private fireCd = 0
  private burstLeft = 0 // バースト武器(リコ等)の残発数。PlayerCommanderと同じ3点バースト挙動を再現
  private burstT = 0
  private pendingFire = false // セミオート発砲エッジ(クリック)の蓄積。update毎に1回だけ消費(ローカルのendFrameクリアと対称)
  private lastInputT = 0 // 最後に入力フレームを受理した実時刻(performance.now)。鮮度判定用(停滞中の暴走防止)
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
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      this.hitMeshes.push(mesh)
      // ステルス半透明化用に素材を収集(BotCommander/puppetと同様)。cloak/decoy中はホスト画面でも薄く表示する。
      const mats = Array.isArray(mesh.material) ? mesh.material : (mesh.material ? [mesh.material] : [])
      for (const m of mats) { m.transparent = true; this.stealthMats.push({ m, opacity: (m as any).opacity ?? 1 }) }
    })
    this.animPrev.copy(this.pos)
  }

  private stealthMats: { m: THREE.Material; opacity: number }[] = []
  /** cloak/decoy中はモデルを半透明(0.13)化、解除で元の不透明度へ。ホスト画面で赤将のステルスを可視化(BotCommander/puppetと対称) */
  private setStealthVisual(on: boolean) {
    for (const s of this.stealthMats) {
      const want = on ? 0.13 : s.opacity
      if (s.m.opacity !== want) { s.m.opacity = want; s.m.needsUpdate = true }
    }
  }

  /** 受信した入力を反映(最新フレームを採用。Phase1でジッタバッファ/補間を追加)。
   *  P2Pでは相手peerは非信頼境界なので、数値の有限性を必ず検証する。NaN/Inf/欠損seqを通すと
   *  順序保証が恒久破壊され、yaw等のNaNが座標→snapshotへ伝播して全員の画面が壊れる(マッチ破壊DoS)。 */
  setInput(ni: NetInput) {
    if (!ni || !Number.isFinite(ni.seq) || !Number.isFinite(ni.mx) || !Number.isFinite(ni.mz) ||
        !Number.isFinite(ni.yaw) || !Number.isFinite(ni.pitch)) return // 不正フレームは破棄(lastSeqは壊さない)
    if (ni.seq <= this.lastSeq) return // 古い/重複フレームは破棄
    this.lastSeq = ni.seq
    // 移動軸は[-1,1]へクランプ(過大値で異常加速させない)
    ni.mx = Math.max(-1, Math.min(1, ni.mx))
    ni.mz = Math.max(-1, Math.min(1, ni.mz))
    // セミオート発砲エッジは別フラグへOR蓄積する。クライアントFPS>ホストFPSや回線ジッタで firePressed=true の直後に
    // firePressed未設定フレームが来て this.input を上書きしてもエッジを取りこぼさない(コアレッシング耐性)。
    if (ni.firePressed) this.pendingFire = true
    // 非信頼peer対策: triggers は許可語のみ(現状 'skill')に限定。未知/偽装トリガ('dash'等)を sim に到達させない。
    if (Array.isArray(ni.triggers)) ni.triggers = ni.triggers.filter((t) => t === 'skill')
    else ni.triggers = undefined
    this.input = ni
    this.lastInputT = (typeof performance !== 'undefined' ? performance.now() : Date.now())
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
    if (!this.alive) return // 死亡中の発動を拒否(ローカルPlayerCommanderはupdate早期returnで不可能=対称化)
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
        this.setStealthVisual(true) // ホスト画面でも赤将を半透明化(cloak/decoyを可視化)
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
    if (!this.alive) return // 死亡中の配備を拒否(ローカルPlayerCommanderと対称化)
    if (!Number.isFinite(x) || !Number.isFinite(z)) return // 非信頼peer由来の不正座標を拒否
    // 照準到達距離ガード: 正規clientは player.ts の MAXD=30m 以内しか要求できない(deployRay.far)。改造clientが
    // 将から遠隔(敵スフィア/敵スポーン)へ配備し占領支援/スポーンキャンプするのを防ぐ。relocateは将方向へ寄せ距離を
    // 縮めるだけなので要求点(クランプ前)で判定。+3 はレイ投影/relocate誤差の吸収マージン(=MAXD+3=33m)。
    const ddx = x - this.group.position.x, ddz = z - this.group.position.z
    if (ddx * ddx + ddz * ddz > 33 * 33) return // 過遠要求はTPも消費せず破棄
    const def = TOKENS[key]
    if (!def || !loadoutFor(this.char.uniqueToken).includes(key)) return // 不正キー拒否
    if (this.tp < def.cost) return
    if (this.world.countActive(this.team, def.key) >= def.maxActive) return
    // 配置先をホスト権威で検証(PlayerCommander.tryDeploy と同一): アリーナ内へクランプし、塞がっていれば将方向へ
    // 寄せて空きセルを探す(見つからなければ拒否)。これが無いと改造クライアントがアリーナ外/壁内/敵スフィア直上へ
    // 配備でき、静止トークン(壁/砲台)は恒久ナビ汚染も起こす。relocateで正規の near-obstacle 配備は従来どおり通す。
    const lim = this.world.arenaHalf - 1.5
    let tx = Math.max(-lim, Math.min(lim, x))
    let tz = Math.max(-lim, Math.min(lim, z))
    if (!this.world.nav.isFree(tx, tz)) {
      let dx = this.group.position.x - tx, dz = this.group.position.z - tz
      const len = Math.hypot(dx, dz) || 1
      dx /= len; dz /= len
      let found = false
      for (let step = 1.5; step <= 9; step += 1.5) {
        const cx = tx + dx * step, cz = tz + dz * step
        if (this.world.nav.isFree(cx, cz)) { tx = cx; tz = cz; found = true; break }
      }
      if (!found) return // 近くに空きが無ければ配備しない(TPも消費しない)
    }
    this.tp -= def.cost
    const pos = new THREE.Vector3(tx, 0, tz)
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
    if (this.armorT > 0) amt *= 0.2 // beatdropのスーパーアーマー(-80%)。PlayerCommander/BotCommanderと同等(パリティ)
    this.hp -= amt
    this.regenDelay = 6 // 被弾で回復遅延を再武装(PlayerCommander.takeDamageと同一)
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
    this.chargeState.reset()
    this.chargeLevel = 0
    this.charging = false
    // PlayerCommander.respawnと項目を揃える: ステルス/スキル状態を死を跨いで残さない。
    // 残すと、cloak中に死亡→リスポーン直後の赤将を青タレットが索敵しない不公平窓ができる。
    this.stealthed = false
    this.skillActiveT = 0
    this.skillKey = ''
    this.dashT = 0
    this.regenDelay = 0 // 復帰時は回復待ちを残さない(PlayerCommander.respawnと対称)
    this.pendingFire = false // 死亡前に溜まったクリックで復帰直後に暴発しない
    this.setStealthVisual(false) // 復帰時は不透明へ戻す
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
    // 被弾後のパッシブHP回復(PlayerCommanderと同一: 6秒の遅延後 10/s)。これが無いとclient赤将だけ永久に回復せず一方的に不利だった
    if (this.regenDelay > 0) this.regenDelay -= dt
    else this.hp = Math.min(this.maxHp, this.hp + 10 * dt)
    // スキル持続の終了処理(cloak/decoyのステルス解除)
    if (this.skillActiveT > 0) {
      this.skillActiveT -= dt
      if (this.skillActiveT <= 0 && (this.skillKey === 'cloak' || this.skillKey === 'decoy')) { this.stealthed = false; this.setStealthVisual(false) }
    }

    const ni = this.input
    if (ni) {
      this.yaw = ni.yaw
      this.pitch = Math.max(-1.45, Math.min(1.45, ni.pitch))
    }
    // 入力鮮度: 一定時間(700ms)新フレームが来ない=パケット停滞中は、最後の入力で移動/発砲し続けず中立入力に倒す
    // (視点yaw/pitchは保持してその場で停止)。完全切断は transport の onStateChange→finish が別途検知する。
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now())
    const stale = !ni || (now - this.lastInputT) > 700
    const mx = (ni && !stale) ? ni.mx : 0
    const mz = (ni && !stale) ? ni.mz : 0
    const wantFire = !!ni && !stale && ni.fire
    const wantJump = !!ni && !stale && ni.jump
    const wantCharge = !!ni && !stale && ni.charge
    const charger = this.weapon.charger

    // --- チャージ / エネルギー(player.ts と同一モデル) ---
    let chargeFire = 0
    if (charger) {
      // チャージ武器: トリガー(fire)ホールドで溜め、離す/フル維持超過で発射。エネルギー制は使わない。
      chargeFire = this.chargeState.step(charger, wantFire, dt)
      this.charging = this.chargeState.level > 0
      this.chargeLevel = this.chargeState.level
    } else {
      this.charging = wantCharge && this.energy < ENERGY_MAX - 0.5
      if (this.charging) this.energy = Math.min(ENERGY_MAX, this.energy + ENERGY_CHARGE_RATE * dt)
      else if (this.lastFireT > ENERGY_PASSIVE_DELAY) this.energy = Math.min(ENERGY_MAX, this.energy + ENERGY_PASSIVE_RATE * dt)
    }
    // チャージ武器は溜め中(charging)に加え右クリックADS(ni.zoom)もズーム扱い=player.ts:211と対称。
    // これが欠けると、ガロが右クリックADS中(未チャージ)にホストだけ減速せず最大2.6倍速になり、巻き戻り/サーバ側機動有利が出る。
    const zoomed = charger ? (this.charging || (!!ni && ni.zoom)) : (!!ni && ni.zoom && !this.charging)

    // --- 移動(player.ts と同一モデル) ---
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw))
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw))
    const wish = new THREE.Vector3()
    wish.addScaledVector(fwd, mz)
    wish.addScaledVector(right, mx)
    const moving = wish.lengthSq() > 0
    if (moving) wish.normalize()
    // sprintは受信フラグで判定(旧: 移動から幾何推定していたが、Shift未押下の純前進でhost=走8.5/client=歩6となり
    // 前進時に定常2.5m/s乖離→自機が周期x/zスナップ＋走り撃ちspread不公平を生んでいた)。player.ts:248 と同条件に揃える。
    const sprinting = !!ni && !stale && !!ni.sprint && mz > 0 && !zoomed && !this.charging
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

    // ダッシュの始動は権威の activateSkill('dash') のみ(skillCd 12s でゲート済)。
    // 旧: 無検証の triggers:['dash'] で dashT を立てる分岐があったが、クールダウン/スキル種別を一切見ず
    // 改造クライアントが毎フレーム送れば 24m/s 連続ダッシュし放題の権威ホールだったため撤去。dashT>0 の移動だけ残す。
    if (this.dashT > 0) {
      this.dashT -= dt
      this.vel.x = this.dashDir.x * 24
      this.vel.z = this.dashDir.z * 24
    }

    this.integrate(dt)

    // 発砲より前に体の位置/向きを当フレームへ同期する。muzzleはthis.groupの子なので、これが発砲後だと
    // emitShotのgetWorldPositionが前フレームのgroup行列を読み、発射元が1フレーム古くなる(player.tsはcamera行列を
    // emitShot前に更新済み=同フレーム発射)。ここで揃えて host/client の発射元をフレーム一致させる。
    this.group.position.copy(this.pos)
    this.group.rotation.y = this.yaw
    this.group.updateMatrixWorld()

    // --- 発砲(player.ts と同一モデル: バースト/オーバードライブのコスト・連射を一致させる) ---
    if (charger) {
      if (chargeFire > 0) this.emitChargedShot(charger, chargeFire, moving)
    } else {
      const w = this.weapon
      const od = this.skillKey === 'overdrive' && this.skillActiveT > 0 // 連射+60%・燃費半減
      const rate = w.rate * (od ? 1.6 : 1)
      const cost = w.energyCost * (od ? 0.5 : 1)
      // バースト継続(burstInterval毎に1発)。これが無いとクライアントのリコ等が単発化していた。
      if (this.burstLeft > 0) {
        this.burstT -= dt
        if (this.burstT <= 0) {
          this.burstT = w.burstInterval ?? 0.07
          this.burstLeft--
          this.emitShot(moving, zoomed, sprinting)
        }
      }
      // オート武器=ホールド(wantFire)、セミオート(auto:false=ジン/ナナセ)=クリックの立ち上がりエッジで判定。
      // エッジ(pendingFire)はこのupdateで必ず1回だけ消費する(発射可否に依らずクリア)=ローカルのendFrame毎クリアと対称。
      // これで「撃てない間(CD/エネ不足)にエッジが残留し回復時に勝手に発射」「同一エッジを複数update再利用」を両方防ぐ。
      const semiPressed = this.pendingFire
      this.pendingFire = false
      const trigger = w.auto ? wantFire : semiPressed
      if (trigger && this.fireCd <= 0 && !this.charging && this.burstLeft <= 0 && this.energy >= cost) {
        this.energy -= cost
        this.fireCd = 1 / rate
        this.lastFireT = 0
        if (w.burst) { this.burstLeft = w.burst; this.burstT = 0 }
        else this.emitShot(moving, zoomed, sprinting)
      }
    }

    // 歩行アニメ(ポーズ更新)→最終matrix更新(位置/向きは発砲前に同期済み)
    this.updateWalkAnim(dt)
    this.group.updateMatrixWorld()
  }

  private emitShot(moving: boolean, zoomed: boolean, sprinting: boolean) {
    const w = this.weapon
    if (this.invulnT > INVULN_ON_FIRE) this.invulnT = INVULN_ON_FIRE // 発砲でスポーン無敵を解除(無敵撃ち返し封じ)
    // 発砲でステルス解除(cloak/decoyの「発砲で解除」契約。これが無いとホスト権威の索敵抑制が残り撃ち放題になる)
    if (this.stealthed) { this.stealthed = false; this.skillActiveT = 0; this.setStealthVisual(false) }
    // fireCd/energy消費・連射処理は呼び出し側(update発火ゲート/バーストループ)が管理する=player.tsと同一。
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

  /** チャージ武器の発射(player.ts と同一モデル)。frac=溜め量で威力/弾速/射程が伸び、フルは貫通1撃。 */
  private emitChargedShot(cd: NonNullable<WeaponDef['charger']>, frac: number, moving: boolean) {
    const w = this.weapon
    const p = chargeShotParams(cd, frac)
    if (this.invulnT > INVULN_ON_FIRE) this.invulnT = INVULN_ON_FIRE
    if (this.stealthed) { this.stealthed = false; this.setStealthVisual(false) }
    const cp = Math.cos(this.pitch)
    const dir = new THREE.Vector3(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp)
    const spread = w.spread * (moving ? 1.6 : 1) * (1.2 - p.frac * 0.4)
    const d = this.combat.spreadDir(dir, spread)
    const origin = this.muzzle ? this.muzzle.getWorldPosition(new THREE.Vector3()) : this.pos.clone().setY(this.pos.y + 1.45)
    this.combat.fireBolt(origin.clone(), d, {
      damage: p.damage, team: this.team, from: this, speed: p.speed,
      color: w.boltColor, maxRange: p.range, pierce: p.pierce, size: 0.1 + p.frac * 0.13,
    })
    this.combat.fx.flash(origin, w.boltColor, 0.06 + p.frac * 0.06)
    this.sfx.shot(true)
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
