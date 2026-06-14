import * as THREE from 'three'
import type { Team, Unit } from './types'

export interface AABB {
  min: THREE.Vector3
  max: THREE.Vector3
}

/** 2mセルのナビゲーショングリッド(BFS経路探索) */
export class NavGrid {
  cell = 2
  half: number
  n: number
  blocked: Uint8Array

  constructor(half: number) {
    this.half = half
    this.n = Math.floor((half * 2) / this.cell)
    this.blocked = new Uint8Array(this.n * this.n)
  }

  clear() {
    this.blocked.fill(0)
  }

  blockBox(box: AABB, inflate = 0.7) {
    const x0 = this.toCell(box.min.x - inflate)
    const x1 = this.toCell(box.max.x + inflate)
    const z0 = this.toCell(box.min.z - inflate)
    const z1 = this.toCell(box.max.z + inflate)
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) this.blocked[z * this.n + x] = 1
  }

  toCell(v: number) {
    return Math.min(this.n - 1, Math.max(0, Math.floor((v + this.half) / this.cell)))
  }

  center(cx: number, cz: number) {
    return new THREE.Vector3(
      cx * this.cell - this.half + this.cell / 2,
      0,
      cz * this.cell - this.half + this.cell / 2,
    )
  }

  isFree(x: number, z: number) {
    return !this.blocked[this.toCell(z) * this.n + this.toCell(x)]
  }

  findPath(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3[] | null {
    const n = this.n
    const sx = this.toCell(from.x)
    const sz = this.toCell(from.z)
    let tx = this.toCell(to.x)
    let tz = this.toCell(to.z)
    if (this.blocked[tz * n + tx]) {
      outer: for (let r = 1; r <= 5; r++) {
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            const nx = tx + dx
            const nz = tz + dz
            if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue
            if (!this.blocked[nz * n + nx]) {
              tx = nx
              tz = nz
              break outer
            }
          }
        }
      }
    }
    const start = sz * n + sx
    const goal = tz * n + tx
    if (start === goal) return [to.clone()]
    const prev = new Int32Array(n * n).fill(-1)
    prev[start] = start
    const queue = [start]
    const dirs = [1, -1, n, -n, n + 1, n - 1, -n + 1, -n - 1]
    for (let qi = 0; qi < queue.length && qi < 4000; qi++) {
      const cur = queue[qi]
      if (cur === goal) break
      const cx = cur % n
      for (const d of dirs) {
        const nxt = cur + d
        if (nxt < 0 || nxt >= n * n) continue
        if (Math.abs((nxt % n) - cx) > 1) continue
        if (this.blocked[nxt] || prev[nxt] !== -1) continue
        prev[nxt] = cur
        queue.push(nxt)
      }
    }
    if (prev[goal] === -1) return null
    const path: THREE.Vector3[] = []
    let cur = goal
    while (cur !== start) {
      path.push(this.center(cur % n, Math.floor(cur / n)))
      cur = prev[cur]
      if (path.length > n * n) return null
    }
    path.reverse()
    path.push(new THREE.Vector3(to.x, 0, to.z))
    return path
  }
}

/** フィールドのエナジーコア(トークン配備の燃料) */
export interface Core {
  pos: THREE.Vector3
  mesh: THREE.Group
  tp: number
  small: boolean
  life: number // smallコアの残存時間
}

export class World {
  scene = new THREE.Scene()
  units: Unit[] = []
  colliders: AABB[] = []
  /** LOS・弾・配備レイを遮るメッシュ(地面含む) */
  obstacleMeshes: THREE.Object3D[] = []
  coverPoints: THREE.Vector3[] = []
  basePos: Record<Team, THREE.Vector3> = {
    blue: new THREE.Vector3(0, 0, 33),
    red: new THREE.Vector3(0, 0, -33),
  }
  arenaHalf = 40
  nav = new NavGrid(40)
  time = 0
  onKill: ((victim: Unit, killer: Unit | null) => void) | null = null
  onDamage: ((victim: Unit, attacker: Unit | null, amount: number) => void) | null = null

  /** エナジーコア */
  cores: Core[] = []
  coreSpots: THREE.Vector3[] = []

  /** スフィア占領モードの目標(BattleView/simが生成して差し込む) */
  objectives: import('./objectives').Objectives | null = null

  /** pos近傍のスフィアに team の占領ダメージを与える。命中したらtrue(弾/爆発から呼ぶ) */
  damageSphereAt(pos: THREE.Vector3, team: Team, amount: number, extra = 0): boolean {
    const s = this.objectives?.sphereNear(pos, extra)
    if (!s) return false
    s.damage(team, amount)
    return true
  }

  /** 敵将リビール(チーム→残り秒。>0ならそのチームの将がマップに映る) */
  revealT: Record<Team, number> = { blue: 0, red: 0 }
  onReveal: ((team: Team, sec: number) => void) | null = null

  private nextId = 1
  private ray = new THREE.Raycaster()

  allocId() {
    return this.nextId++
  }

  addCollider(box: AABB) {
    this.colliders.push(box)
    this.nav.blockBox(box)
  }

  removeCollider(box: AABB) {
    const i = this.colliders.indexOf(box)
    if (i >= 0) this.colliders.splice(i, 1)
    this.rebuildNav()
  }

  rebuildNav() {
    this.nav.clear()
    for (const c of this.colliders) this.nav.blockBox(c)
  }

  addUnit(u: Unit) {
    this.units.push(u)
    this.scene.add(u.group)
    u.group.updateMatrixWorld(true)
    for (const m of u.hitMeshes) m.userData.unit = u
  }

  removeUnit(u: Unit) {
    const i = this.units.indexOf(u)
    if (i >= 0) this.units.splice(i, 1)
    this.scene.remove(u.group)
  }

  notifyKill(victim: Unit, killer: Unit | null) {
    this.onKill?.(victim, killer)
  }

  notifyDamage(victim: Unit, attacker: Unit | null, amount: number) {
    this.onDamage?.(victim, attacker, amount)
  }

  reveal(team: Team, sec: number) {
    this.revealT[team] = Math.max(this.revealT[team], sec)
    this.onReveal?.(team, sec)
  }

  enemiesOf(team: Team): Unit[] {
    return this.units.filter((u) => u.alive && u.team !== team)
  }

  commanderOf(team: Team): Unit | null {
    return this.units.find((u) => u.isCommander && u.team === team) ?? null
  }

  countActive(team: Team, kind: string): number {
    let c = 0
    for (const u of this.units) if (u.alive && u.team === team && u.kind === kind) c++
    return c
  }

  /** ブースターパイロン圏内なら連射クールダウン倍率(<1で強化) */
  fireBoostMul(team: Team, pos: THREE.Vector3): number {
    for (const u of this.units) {
      if (u.alive && u.team === team && u.kind === 'booster') {
        if (u.group.position.distanceTo(pos) < 10) return 0.7
      }
    }
    return 1
  }

  /** 敵ジャマー圏内なら索敵距離倍率(<1で妨害) */
  senseRangeMul(team: Team, pos: THREE.Vector3): number {
    for (const u of this.units) {
      if (u.alive && u.team !== team && u.kind === 'jammer') {
        if (u.group.position.distanceTo(pos) < 9) return 0.5
      }
    }
    return 1
  }

  /** a→b の射線が障害物に遮られていないか */
  hasLOS(a: THREE.Vector3, b: THREE.Vector3): boolean {
    const dir = b.clone().sub(a)
    const dist = dir.length()
    if (dist < 0.01) return true
    dir.normalize()
    this.ray.set(a, dir)
    this.ray.near = 0.01
    this.ray.far = dist - 0.15
    return this.ray.intersectObjects(this.obstacleMeshes, false).length === 0
  }
}
