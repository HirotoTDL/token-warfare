import * as THREE from 'three'
import { falloffMul, type FalloffPoint, type Team, type Unit } from './types'
import { World } from './world'
import { Sfx } from './sfx'

// レイ(origin, 正規化dir)とAABBの交差距離を返す(区間[0,maxDist]の最初の交点。無交差は-1)。割り当て無しのスラブ法。
// ユニットのヒット判定用: キャラはスキンドメッシュ(数十万tri)でmesh raycastが秒単位に激重なため、
// pos/radius/heightのAABB(=カプセル相当の箱)で解析判定して桁違いに軽くする。
function rayAabb(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  minx: number, miny: number, minz: number, maxx: number, maxy: number, maxz: number, maxDist: number,
): number {
  let t0 = 0
  let t1 = maxDist
  if (Math.abs(dx) < 1e-8) { if (ox < minx || ox > maxx) return -1 }
  else { const inv = 1 / dx; let ta = (minx - ox) * inv; let tb = (maxx - ox) * inv; if (ta > tb) { const s = ta; ta = tb; tb = s } if (ta > t0) t0 = ta; if (tb < t1) t1 = tb; if (t0 > t1) return -1 }
  if (Math.abs(dy) < 1e-8) { if (oy < miny || oy > maxy) return -1 }
  else { const inv = 1 / dy; let ta = (miny - oy) * inv; let tb = (maxy - oy) * inv; if (ta > tb) { const s = ta; ta = tb; tb = s } if (ta > t0) t0 = ta; if (tb < t1) t1 = tb; if (t0 > t1) return -1 }
  if (Math.abs(dz) < 1e-8) { if (oz < minz || oz > maxz) return -1 }
  else { const inv = 1 / dz; let ta = (minz - oz) * inv; let tb = (maxz - oz) * inv; if (ta > tb) { const s = ta; ta = tb; tb = s } if (ta > t0) t0 = ta; if (tb < t1) t1 = tb; if (t0 > t1) return -1 }
  return t0
}

interface FxItem {
  obj: THREE.Object3D
  mat: THREE.Material & { opacity: number; color: THREE.Color }
  life: number
  maxLife: number
  baseOpacity: number
  growTo?: number
  kind: string
}

export class Effects {
  private items: FxItem[] = []
  private group = new THREE.Group()
  // GC回避: エフェクトもプールで再利用(毎ヒットの火花/毎発の発砲フラッシュ等の生成破棄を無くす)。共有ジオメトリ。
  private pools: Record<string, { obj: THREE.Object3D; mat: THREE.Material & { opacity: number; color: THREE.Color } }[]> = {}
  private sphereGeo = new THREE.SphereGeometry(1, 10, 8) // flash/spark/explosion 共有(scaleで調整)
  private torusGeo = new THREE.TorusGeometry(0.5, 0.06, 8, 28)
  private cylGeo = new THREE.CylinderGeometry(0.7, 0.9, 7, 16, 1, true)

  constructor(scene: THREE.Scene) {
    scene.add(this.group)
  }

  /** 計測用(__tw.perf): 生存中エフェクト数 */
  get fxCount() { return this.items.length }

  private take(kind: string): { obj: THREE.Object3D; mat: THREE.Material & { opacity: number; color: THREE.Color } } {
    const pool = this.pools[kind] || (this.pools[kind] = [])
    const e = pool.pop()
    if (e) { e.obj.visible = true; return e }
    let obj: THREE.Object3D
    let mat: THREE.Material & { opacity: number; color: THREE.Color }
    if (kind === 'tracer') {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3))
      mat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.85 })
      obj = new THREE.Line(g, mat)
    } else {
      const geo = kind === 'ring' ? this.torusGeo : kind === 'column' ? this.cylGeo : this.sphereGeo
      mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, side: kind === 'column' ? THREE.DoubleSide : THREE.FrontSide })
      obj = new THREE.Mesh(geo, mat)
    }
    this.group.add(obj)
    return { obj, mat }
  }

  private add(kind: string, obj: THREE.Object3D, mat: FxItem['mat'], life: number, baseOpacity: number, growTo?: number) {
    this.items.push({ obj, mat, life, maxLife: life, baseOpacity, growTo, kind })
  }

  tracer(a: THREE.Vector3, b: THREE.Vector3, color = 0xffe9a0) {
    const { obj, mat } = this.take('tracer')
    const pos = (obj as THREE.Line).geometry.attributes.position as THREE.BufferAttribute
    pos.setXYZ(0, a.x, a.y, a.z); pos.setXYZ(1, b.x, b.y, b.z); pos.needsUpdate = true
    ;(obj as THREE.Line).geometry.computeBoundingSphere()
    mat.color.setHex(color); mat.opacity = 0.85
    this.add('tracer', obj, mat, 0.08, 0.85)
  }

  flash(pos: THREE.Vector3, color = 0xffd080, size = 0.14) {
    const { obj, mat } = this.take('flash')
    obj.position.copy(pos); obj.scale.setScalar(size); obj.rotation.set(0, 0, 0)
    mat.color.setHex(color).multiplyScalar(1.6); mat.opacity = 0.9
    this.add('flash', obj, mat, 0.06, 0.9)
  }

  spark(pos: THREE.Vector3, color = 0xffc080) {
    const { obj, mat } = this.take('spark')
    obj.position.copy(pos); obj.scale.setScalar(0.09); obj.rotation.set(0, 0, 0)
    mat.color.setHex(color); mat.opacity = 0.95
    this.add('spark', obj, mat, 0.14, 0.95, 0.2) // 元:半径0.09をscale2.2 → unit球の最終scale≈0.2
  }

  ring(pos: THREE.Vector3, color: number) {
    const { obj, mat } = this.take('ring')
    obj.position.copy(pos); obj.position.y += 0.1
    obj.scale.setScalar(1); obj.rotation.set(-Math.PI / 2, 0, 0)
    mat.color.setHex(color); mat.opacity = 0.9
    this.add('ring', obj, mat, 0.45, 0.9, 3.4)
  }

  /** リスポーン/ワープ演出の光柱 */
  column(pos: THREE.Vector3, color: number) {
    const { obj, mat } = this.take('column')
    obj.position.copy(pos); obj.position.y += 3.5
    obj.scale.setScalar(1); obj.rotation.set(0, 0, 0)
    mat.color.setHex(color); mat.opacity = 0.55
    this.add('column', obj, mat, 0.7, 0.55)
  }

  explosion(pos: THREE.Vector3, radius: number, color = 0xff8830) {
    const a = this.take('explosion')
    a.obj.position.copy(pos); a.obj.scale.setScalar(0.3); a.obj.rotation.set(0, 0, 0)
    a.mat.color.setHex(color).multiplyScalar(2.0); a.mat.opacity = 0.85
    this.add('explosion', a.obj, a.mat, 0.35, 0.85, radius)
    const b = this.take('explosion')
    b.obj.position.copy(pos); b.obj.scale.setScalar(0.2); b.obj.rotation.set(0, 0, 0)
    b.mat.color.setHex(0xfff0c0); b.mat.opacity = 0.9
    this.add('explosion', b.obj, b.mat, 0.18, 0.9, radius * 0.55)
  }

  update(dt: number) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i]
      it.life -= dt
      if (it.life <= 0) {
        it.obj.visible = false // 破棄せずプールへ返す(GC源にしない)
        ;(this.pools[it.kind] || (this.pools[it.kind] = [])).push({ obj: it.obj, mat: it.mat })
        this.items.splice(i, 1)
        continue
      }
      const k = it.life / it.maxLife
      it.mat.opacity = it.baseOpacity * k
      if (it.growTo) {
        const s = it.obj.scale.x + (it.growTo - it.obj.scale.x) * Math.min(1, dt * 14)
        it.obj.scale.setScalar(s)
      }
    }
  }

  dispose() {
    this.group.clear()
    this.items = []
    this.pools = {}
    this.sphereGeo.dispose(); this.torusGeo.dispose(); this.cylGeo.dispose()
  }
}

export interface BoltOpts {
  damage: number
  team: Team
  from: Unit | null
  speed: number
  falloff?: FalloffPoint[]
  color?: number
  explosive?: { radius: number }
  gravity?: number
  maxRange?: number
  size?: number
  /** オンラインclient用の見た目専用弾: ユニット命中もスフィア占領も起こさない(ダメージはホスト権威) */
  visual?: boolean
}

interface Bolt {
  pos: THREE.Vector3
  vel: THREE.Vector3
  traveled: number
  opts: BoltOpts
  mesh: THREE.Mesh
  alive: boolean
}

/** エネルギー弾・爆発・ダメージ処理 */
export class Combat {
  private ray = new THREE.Raycaster()
  private bolts: Bolt[] = []
  private boltGroup = new THREE.Group()
  // --- GC回避: 弾はプールで再利用し、毎発の生成破棄を無くす(打ち合い時のGCスパイク解消) ---
  private boltGeo = new THREE.SphereGeometry(1, 8, 6) // 全弾共有の単位球(meshをsizeでスケール)
  private boltPool: Bolt[] = [] // 非アクティブな弾(mesh/pos/vel を保持して再利用)
  private matCache = new Map<number, THREE.MeshBasicMaterial>() // 色→共有マテリアル(生成は色ごと一度きり)
  private tmpDir = new THREE.Vector3()
  private tmpV = new THREE.Vector3()
  private tmpHit = new THREE.Vector3() // ユニットヒット点の使い回し

  /** オンラインhost: 弾発射ごとに呼ばれる(発射イベントをクライアントへ中継して相手にも弾が見えるようにする) */
  onFire: ((origin: THREE.Vector3, dir: THREE.Vector3, opts: BoltOpts) => void) | null = null

  /** 計測用(__tw.perf): アクティブ弾数 / プール退避数。プールが青天井に伸びていなければリーク無し */
  get boltCount() { return this.bolts.length }
  get boltPoolSize() { return this.boltPool.length }

  constructor(
    public world: World,
    public fx: Effects,
    public sfx: Sfx,
  ) {
    world.scene.add(this.boltGroup)
  }

  private boltMaterial(color: number): THREE.MeshBasicMaterial {
    let m = this.matCache.get(color)
    if (!m) {
      m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false })
      m.color.multiplyScalar(2.6) // HDR輝度に押し上げてブルームで光らせる
      this.matCache.set(color, m)
    }
    return m
  }

  /** エネルギー弾を発射(spreadは呼び出し側でdirに適用済みであること) */
  fireBolt(origin: THREE.Vector3, dir: THREE.Vector3, opts: BoltOpts) {
    const d = this.tmpDir.copy(dir).normalize()
    const size = opts.size ?? 0.09
    const color = opts.color ?? 0xffe9a0
    const stretch = Math.min(6, 1.5 + opts.speed * 0.025)
    let b = this.boltPool.pop()
    if (!b) {
      // プールが空なら1個だけ生成(以降は再利用される)
      const mesh = new THREE.Mesh(this.boltGeo, this.boltMaterial(color))
      this.boltGroup.add(mesh)
      b = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), traveled: 0, opts, mesh, alive: true }
    }
    b.mesh.material = this.boltMaterial(color)
    b.mesh.visible = true
    b.mesh.position.copy(origin)
    b.mesh.scale.set(size, size, size * stretch)
    this.tmpV.copy(origin).add(d)
    b.mesh.lookAt(this.tmpV)
    b.pos.copy(origin)
    b.vel.copy(d).multiplyScalar(opts.speed)
    b.traveled = 0
    b.opts = opts
    b.alive = true
    this.bolts.push(b)
    // オンラインhost: 発射をクライアントへ中継(相手画面でも弾が見える)。視覚弾(client再生分)は中継しない。
    if (this.onFire && !opts.visual) this.onFire(origin, d, opts)
  }

  /** 拡散角を加えた方向ベクトルを作るユーティリティ */
  spreadDir(dir: THREE.Vector3, spread: number): THREE.Vector3 {
    const d = dir.clone()
    d.x += (Math.random() - 0.5) * 2 * spread
    d.y += (Math.random() - 0.5) * 2 * spread
    d.z += (Math.random() - 0.5) * 2 * spread
    return d.normalize()
  }

  update(dt: number) {
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i]
      if (b.opts.gravity) b.vel.y -= b.opts.gravity * dt
      const step = b.vel.length() * dt
      const dir = this.tmpDir.copy(b.vel).normalize() // clone回避(使い回し)

      // 障害物との交差
      this.ray.set(b.pos, dir)
      this.ray.near = 0
      this.ray.far = step
      const obs = this.ray.intersectObjects(this.world.obstacleMeshes, false) // 非再帰: obstacleMeshesは全て単純な箱/円柱プロキシ(軽い)
      const obsDist = obs.length ? obs[0].distance : Infinity

      // 敵ユニットとの交差: キャラ等はスキンドメッシュ(数十万tri)でmesh raycastが秒単位に激重
      // (打ち合いで深刻な処理落ちの主因だった)。pos/radius/heightのAABB(カプセル相当)で解析判定する=
      // 割り当て無し・桁違いに軽い。step区間で最も近いユニットを選ぶ。
      let hitUnit: Unit | null = null
      let unitDist = Infinity
      if (!b.opts.visual) { // 視覚弾(client再生)はダメージ判定しない(ホスト権威)
        for (const u of this.world.units) {
          if (!u.alive || u.team === b.opts.team || u === b.opts.from) continue
          const up = u.group.position
          const r = u.radius
          const t = rayAabb(b.pos.x, b.pos.y, b.pos.z, dir.x, dir.y, dir.z, up.x - r, up.y, up.z - r, up.x + r, up.y + u.height, up.z + r, step)
          if (t >= 0 && t < unitDist) { unitDist = t; hitUnit = u }
        }
      }

      if (hitUnit && unitDist < obsDist && unitDist <= step) {
        const point = this.tmpHit.copy(dir).multiplyScalar(unitDist).add(b.pos)
        const dist = b.traveled + unitDist
        const dmg = b.opts.damage * (b.opts.falloff ? falloffMul(b.opts.falloff, dist) : 1)
        if (b.opts.explosive) {
          this.explode(point, b.opts.explosive.radius, dmg, b.opts.team, b.opts.from)
        } else {
          this.fx.spark(point, b.opts.color ?? 0xff9060)
          hitUnit.takeDamage(dmg, b.opts.from)
          ;(b.opts.from as any)?.onBoltHit?.(hitUnit)
        }
        this.killBolt(i)
        continue
      }
      if (obsDist <= step) {
        const point = obs[0].point
        if (b.opts.explosive) {
          const dist = b.traveled + obsDist
          const dmg = b.opts.damage * (b.opts.falloff ? falloffMul(b.opts.falloff, dist) : 1)
          this.explode(point, b.opts.explosive.radius, dmg, b.opts.team, b.opts.from)
        } else {
          this.fx.spark(point, 0x9aa6b4)
        }
        this.killBolt(i)
        continue
      }

      // スフィア占領: 弾がスフィアに入ったら占領ダメージを与えて消滅(爆発弾は爆発で処理)。視覚弾は占領しない。
      const sphere = b.opts.visual ? null : this.world.objectives?.sphereNear(b.pos, 0.4)
      if (sphere) {
        const dmg = b.opts.damage * (b.opts.falloff ? falloffMul(b.opts.falloff, b.traveled) : 1)
        if (b.opts.explosive) {
          this.explode(this.tmpV.copy(b.pos), b.opts.explosive.radius, dmg, b.opts.team, b.opts.from)
        } else {
          sphere.damage(b.opts.team, dmg)
          this.fx.spark(this.tmpV.copy(b.pos), b.opts.color ?? 0xff9060)
        }
        this.killBolt(i)
        continue
      }

      b.pos.addScaledVector(dir, step)
      b.traveled += step
      b.mesh.position.copy(b.pos)
      if (b.opts.gravity) b.mesh.lookAt(this.tmpV.copy(b.pos).add(b.vel))
      const maxRange = b.opts.maxRange ?? 110
      if (b.traveled > maxRange || b.pos.y < -10) {
        // 爆発弾がmaxRange到達(=届かず飛びすぎ)で消える場合は不発にせず着弾点で爆発させる。
        // 場外へ落下(y<-10)した場合は虚空なので爆発しない(PHYS-08: 曲射の不発感を解消)。
        if (b.opts.explosive && b.traveled > maxRange && b.pos.y > 0) {
          const dmg = b.opts.damage * (b.opts.falloff ? falloffMul(b.opts.falloff, b.traveled) : 1)
          this.explode(this.tmpV.copy(b.pos), b.opts.explosive.radius, dmg, b.opts.team, b.opts.from)
        }
        this.killBolt(i)
      }
    }
  }

  private killBolt(i: number) {
    const b = this.bolts[i]
    b.mesh.visible = false // groupには残し非表示(再利用。add/removeのchurnも回避)。dispose しない=GC源にならない
    b.alive = false
    this.bolts.splice(i, 1)
    this.boltPool.push(b)
  }

  /** 爆発。team の敵にのみダメージ(距離減衰あり) */
  explode(pos: THREE.Vector3, radius: number, damage: number, team: Team, from: Unit | null, color = 0xff8830) {
    this.fx.explosion(pos, radius, color)
    this.sfx.explosion()
    // 範囲内のスフィアにも占領ダメージ(爆発は占領を一気に進める)
    const sphere = this.world.objectives?.sphereNear(pos, radius)
    if (sphere) sphere.damage(team, damage)
    for (const u of [...this.world.units]) {
      if (!u.alive || u.team === team) continue
      const center = u.group.position.clone()
      center.y += u.height / 2
      const dist = center.distanceTo(pos)
      const reach = radius + u.radius
      if (dist < reach) {
        const fall = 1 - 0.6 * Math.min(1, dist / reach)
        u.takeDamage(damage * fall, from)
      }
    }
  }

  dispose() {
    this.boltGroup.clear()
    this.bolts = []
    this.boltPool = []
    this.boltGeo.dispose()
    for (const m of this.matCache.values()) m.dispose()
    this.matCache.clear()
  }
}
