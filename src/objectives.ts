import * as THREE from 'three'
import { TEAM_COLOR, type Team } from './types'

// スフィア占領モードのコア。3つのスフィア(中央/青陣/赤陣)を charge[-1,+1] で奪い合い、
// 中央＋敵陣を確保している間カウントが進み、CAPTURE_TO_WIN で勝利。
export type SphereId = 'center' | 'blueBase' | 'redBase'

// リサーチ(ゾーン制圧FPS先行事例)に基づく値:
export const CAP_THRESHOLD = 0.55 // |charge|がこれ以上で占領。±0.55未満は「無色=係争帯」を残す(Overwatch/Halo KOTH)
// 与ダメ1あたりのcharge変化。将(50〜88DPS)で中央0→0.55を約2.6〜4.6秒射撃で確保=瞬間占領を防ぐバッファ。
// (旧0.012は約0.9秒で瞬間占領になっていた=研究の禁止事項。0.0025へ是正。トークン供給はsupply()で直値charge/s)
export const CAPTURE_PER_DAMAGE = 0.0025
export const CAPTURE_TO_WIN = 30 // 勝利カウント
export const SPHERE_RADIUS = 1.6 // 当たり判定/見た目半径
export const CONTEST_WINDOW = 0.5 // 直近この秒数に両軍から被弾していれば「係争中」

export class Sphere {
  charge: number
  readonly id: SphereId
  readonly pos: THREE.Vector3
  readonly home: Team | null // 陣スフィアの初期所有(中央はnull)
  mesh: THREE.Group
  private core: THREE.Mesh
  private ring: THREE.Mesh
  private mat: THREE.MeshStandardMaterial
  private ringMat: THREE.MeshBasicMaterial
  private t = 0
  private hitBlue = 99 // 直近で青/赤に撃たれてからの経過秒(係争判定用)
  private hitRed = 99
  private lastOwner: Team | null = null // 占有変化検出用
  private penaltyTeam: Team | null = null // 奪われた側(再奪取の供給-50%)
  private penaltyT = 0
  justFlipped: Team | null = null // このフレームに占有が反転した(ジュース演出用)

  constructor(id: SphereId, pos: THREE.Vector3, initialCharge: number, home: Team | null) {
    this.id = id
    this.pos = pos.clone()
    this.charge = initialCharge
    this.home = home
    this.mesh = new THREE.Group()
    this.mesh.position.copy(pos)
    this.mat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.6, roughness: 0.25, metalness: 0.1, transparent: true, opacity: 0.92 })
    this.core = new THREE.Mesh(new THREE.IcosahedronGeometry(SPHERE_RADIUS, 2), this.mat)
    this.mesh.add(this.core)
    this.ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false })
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(SPHERE_RADIUS * 1.5, 0.12, 8, 40), this.ringMat)
    this.ring.rotation.x = Math.PI / 2
    this.mesh.add(this.ring)
    // 占領進捗バー(地面の弧)は省略。色と発光で表現。
    this.applyVisual()
  }

  owner(): Team | null {
    if (this.charge >= CAP_THRESHOLD) return 'blue'
    if (this.charge <= -CAP_THRESHOLD) return 'red'
    return null
  }

  /** team の攻撃で占領を進める(青=+/赤=−)。相殺は呼び出し側が同フレームで両軍分加算することで自然に起きる */
  damage(team: Team, amount: number) {
    // 逆転ペナルティ: 奪われた直後の側は、その球への供給が一時的に半減(即時取り返しを抑制)
    let amt = amount
    if (this.penaltyTeam === team && this.penaltyT > 0) amt *= 0.5
    this.charge += (team === 'blue' ? 1 : -1) * amt * CAPTURE_PER_DAMAGE
    this.charge = Math.max(-1, Math.min(1, this.charge))
    if (team === 'blue') this.hitBlue = 0
    else this.hitRed = 0
  }

  /** 占領支援トークンの持続供給(charge/秒の直値。damage()を経由しない)。係争・ペナルティに乗せ対処可能を担保 */
  supply(team: Team, chargePerSec: number, dt: number) {
    let amt = chargePerSec * dt
    if (this.penaltyTeam === team && this.penaltyT > 0) amt *= 0.5
    this.charge += (team === 'blue' ? 1 : -1) * amt
    this.charge = Math.max(-1, Math.min(1, this.charge))
    if (team === 'blue') this.hitBlue = 0
    else this.hitRed = 0
  }

  /** 両軍から直近に撃たれている=係争中(占領が拮抗。相殺で動きが止まる) */
  contested(): boolean {
    return this.hitBlue < CONTEST_WINDOW && this.hitRed < CONTEST_WINDOW
  }

  private colorFor(): THREE.Color {
    const o = this.owner()
    const c = new THREE.Color(o ? TEAM_COLOR[o] : 0xdedede)
    // 占領途中はcharge強度で陣営色へ寄せる(視覚フィードバック)
    const lean = new THREE.Color(this.charge > 0 ? TEAM_COLOR.blue : TEAM_COLOR.red)
    const k = Math.min(1, Math.abs(this.charge))
    return c.lerp(lean, o ? 0 : k * 0.6)
  }

  private applyVisual() {
    const col = this.colorFor()
    this.mat.color.copy(col)
    this.mat.emissive.copy(col)
    this.ringMat.color.copy(col)
  }

  update(dt: number) {
    this.t += dt
    this.hitBlue += dt
    this.hitRed += dt
    this.penaltyT = Math.max(0, this.penaltyT - dt)
    this.justFlipped = null
    // 占有が反転したら「奪われた側」に再奪取ペナルティ(3秒・供給半減)+フリップ演出フラグ
    const own = this.owner()
    if (own && own !== this.lastOwner) {
      this.justFlipped = own
      if (this.lastOwner) { this.penaltyTeam = this.lastOwner; this.penaltyT = 3 }
      this.lastOwner = own
    } else if (own) {
      this.lastOwner = own
    }
    this.core.rotation.y += dt * 0.5
    this.core.position.y = Math.sin(this.t * 1.2) * 0.18
    const owned = this.owner() !== null
    const contested = this.contested()
    this.mat.emissiveIntensity = owned ? 0.9 + Math.sin(this.t * 3) * 0.25 : 0.5
    this.ring.scale.setScalar(owned ? 1 + Math.sin(this.t * 4) * 0.05 : 1)
    this.applyVisual()
    // 係争中は白く明滅して「拮抗(占領が止まっている)」を伝える
    if (contested) {
      const f = 0.5 + Math.sin(this.t * 16) * 0.5
      this.mat.emissive.lerp(new THREE.Color(0xffffff), f * 0.7)
      this.ringMat.color.lerp(new THREE.Color(0xffffff), f)
    }
  }
}

export class Objectives {
  spheres: Sphere[] = []
  center: Sphere
  base: Record<Team, Sphere>
  count: Record<Team, number> = { blue: 0, red: 0 }
  winner: Team | null = null

  constructor(scene: THREE.Scene, centerPos: THREE.Vector3, basePos: Record<Team, THREE.Vector3>) {
    this.center = new Sphere('center', centerPos, 0, null)
    const blueBase = new Sphere('blueBase', basePos.blue.clone().setY(centerPos.y), 1, 'blue')
    const redBase = new Sphere('redBase', basePos.red.clone().setY(centerPos.y), -1, 'red')
    this.base = { blue: blueBase, red: redBase }
    this.spheres = [this.center, blueBase, redBase]
    for (const s of this.spheres) scene.add(s.mesh)
  }

  /** pos近傍のスフィアを返す(弾/爆発のヒット判定用) */
  sphereNear(pos: THREE.Vector3, extra = 0): Sphere | null {
    for (const s of this.spheres) {
      if (pos.distanceTo(s.pos) <= SPHERE_RADIUS + extra) return s
    }
    return null
  }

  /** team視点で「中央＋敵陣」を確保しているか */
  dominating(team: Team): boolean {
    const enemy: Team = team === 'blue' ? 'red' : 'blue'
    return this.center.owner() === team && this.base[enemy].owner() === team
  }

  /** 毎フレーム: カウント加算・勝敗判定。戻り値=この更新でスコアが動いた側(HUD演出用) */
  update(dt: number): { ticked: Team | null; flips: { id: SphereId; owner: Team }[] } {
    const flips: { id: SphereId; owner: Team }[] = []
    for (const s of this.spheres) {
      s.update(dt)
      if (s.justFlipped) flips.push({ id: s.id, owner: s.justFlipped })
    }
    let ticked: Team | null = null
    for (const team of ['blue', 'red'] as Team[]) {
      if (this.dominating(team)) {
        const before = Math.floor(this.count[team])
        this.count[team] = Math.min(CAPTURE_TO_WIN, this.count[team] + dt)
        if (Math.floor(this.count[team]) > before) ticked = team
        if (this.count[team] >= CAPTURE_TO_WIN && !this.winner) this.winner = team
      }
    }
    return { ticked, flips }
  }
}
