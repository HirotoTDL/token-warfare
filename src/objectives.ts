import * as THREE from 'three'
import { TEAM_COLOR, type Team } from './types'

// スフィア占領モードのコア。3つのスフィア(中央/青陣/赤陣)を charge[-1,+1] で奪い合い、
// 中央＋敵陣を確保している間カウントが進み、CAPTURE_TO_WIN で勝利。
export type SphereId = 'center' | 'blueBase' | 'redBase'

export const CAP_THRESHOLD = 0.95 // |charge|がこれ以上で「占領済み(その色)」
export const CAPTURE_PER_DAMAGE = 1 / 150 // 与ダメ1あたりのcharge変化(150ネットで0→満タン)
export const CAPTURE_TO_WIN = 30 // 勝利カウント(両拠点保持の累計秒)
export const SPHERE_RADIUS = 1.6 // 当たり判定/見た目半径

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
    this.charge += (team === 'blue' ? 1 : -1) * amount * CAPTURE_PER_DAMAGE
    this.charge = Math.max(-1, Math.min(1, this.charge))
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
    this.core.rotation.y += dt * 0.5
    this.core.position.y = Math.sin(this.t * 1.2) * 0.18
    const owned = this.owner() !== null
    this.mat.emissiveIntensity = owned ? 0.9 + Math.sin(this.t * 3) * 0.25 : 0.5
    this.ring.scale.setScalar(owned ? 1 + Math.sin(this.t * 4) * 0.05 : 1)
    this.applyVisual()
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
  update(dt: number): { ticked: Team | null } {
    for (const s of this.spheres) s.update(dt)
    let ticked: Team | null = null
    for (const team of ['blue', 'red'] as Team[]) {
      if (this.dominating(team)) {
        const before = Math.floor(this.count[team])
        this.count[team] = Math.min(CAPTURE_TO_WIN, this.count[team] + dt)
        if (Math.floor(this.count[team]) > before) ticked = team
        if (this.count[team] >= CAPTURE_TO_WIN && !this.winner) this.winner = team
      }
    }
    return { ticked }
  }
}
