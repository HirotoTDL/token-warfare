import * as THREE from 'three'
import { falloffMul, type FalloffPoint, type Team, type Unit } from './types'
import { World } from './world'
import { Sfx } from './sfx'

interface FxItem {
  obj: THREE.Object3D
  mat: THREE.Material & { opacity: number }
  life: number
  maxLife: number
  baseOpacity: number
  growTo?: number
  geo?: THREE.BufferGeometry
}

export class Effects {
  private items: FxItem[] = []
  private group = new THREE.Group()

  constructor(scene: THREE.Scene) {
    scene.add(this.group)
  }

  private push(obj: THREE.Object3D, life: number, geo?: THREE.BufferGeometry, growTo?: number) {
    const m = (obj as THREE.Mesh).material as FxItem['mat']
    this.group.add(obj)
    this.items.push({ obj, mat: m, life, maxLife: life, baseOpacity: m.opacity ?? 1, geo, growTo })
  }

  tracer(a: THREE.Vector3, b: THREE.Vector3, color = 0xffe9a0) {
    const geo = new THREE.BufferGeometry().setFromPoints([a, b])
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 })
    this.push(new THREE.Line(geo, mat), 0.08, geo)
  }

  flash(pos: THREE.Vector3, color = 0xffd080, size = 0.14) {
    const geo = new THREE.SphereGeometry(size, 8, 6)
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false,
    })
    mat.color.multiplyScalar(1.6)
    const m = new THREE.Mesh(geo, mat)
    m.position.copy(pos)
    this.push(m, 0.06, geo)
  }

  spark(pos: THREE.Vector3, color = 0xffc080) {
    const geo = new THREE.SphereGeometry(0.09, 6, 5)
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false,
    })
    const m = new THREE.Mesh(geo, mat)
    m.position.copy(pos)
    this.push(m, 0.14, geo, 2.2)
  }

  ring(pos: THREE.Vector3, color: number) {
    const geo = new THREE.TorusGeometry(0.5, 0.06, 8, 28)
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false,
    })
    const m = new THREE.Mesh(geo, mat)
    m.position.copy(pos)
    m.position.y += 0.1
    m.rotation.x = -Math.PI / 2
    this.push(m, 0.45, geo, 3.4)
  }

  /** リスポーン/ワープ演出の光柱 */
  column(pos: THREE.Vector3, color: number) {
    const geo = new THREE.CylinderGeometry(0.7, 0.9, 7, 16, 1, true)
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide,
    })
    const m = new THREE.Mesh(geo, mat)
    m.position.copy(pos)
    m.position.y += 3.5
    this.push(m, 0.7, geo)
  }

  explosion(pos: THREE.Vector3, radius: number, color = 0xff8830) {
    const geo = new THREE.SphereGeometry(1, 16, 12)
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false,
    })
    mat.color.multiplyScalar(2.0)
    const m = new THREE.Mesh(geo, mat)
    m.position.copy(pos)
    m.scale.setScalar(0.3)
    this.push(m, 0.35, geo, radius)
    const geo2 = new THREE.SphereGeometry(1, 12, 8)
    const mat2 = new THREE.MeshBasicMaterial({
      color: 0xfff0c0, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false,
    })
    const m2 = new THREE.Mesh(geo2, mat2)
    m2.position.copy(pos)
    m2.scale.setScalar(0.2)
    this.push(m2, 0.18, geo2, radius * 0.55)
  }

  update(dt: number) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i]
      it.life -= dt
      if (it.life <= 0) {
        this.group.remove(it.obj)
        it.geo?.dispose()
        it.mat.dispose()
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
    for (const it of this.items) {
      this.group.remove(it.obj)
      it.geo?.dispose()
      it.mat.dispose()
    }
    this.items = []
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
  private hitMeshes: THREE.Mesh[] = [] // ユニット交差判定用の使い回し配列

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

      // 敵ユニットとの交差(配列は使い回し=毎フレームの確保を回避)
      const meshes = this.hitMeshes
      meshes.length = 0
      for (const u of this.world.units) {
        if (u.alive && u.team !== b.opts.team && u !== b.opts.from) { for (const hm of u.hitMeshes) meshes.push(hm) }
      }
      const hits = this.ray.intersectObjects(meshes, false)
      const unitDist = hits.length ? hits[0].distance : Infinity

      if (unitDist < obsDist && unitDist <= step) {
        const hitUnit = hits[0].object.userData.unit as Unit
        const point = hits[0].point
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

      // スフィア占領: 弾がスフィアに入ったら占領ダメージを与えて消滅(爆発弾は爆発で処理)
      const sphere = this.world.objectives?.sphereNear(b.pos, 0.4)
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
          this.explode(b.pos.clone(), b.opts.explosive.radius, dmg, b.opts.team, b.opts.from)
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
