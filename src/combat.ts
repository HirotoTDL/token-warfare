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
  geo: THREE.BufferGeometry
  mat: THREE.MeshBasicMaterial
  alive: boolean
}

/** エネルギー弾・爆発・ダメージ処理 */
export class Combat {
  private ray = new THREE.Raycaster()
  private bolts: Bolt[] = []
  private boltGroup = new THREE.Group()

  constructor(
    public world: World,
    public fx: Effects,
    public sfx: Sfx,
  ) {
    world.scene.add(this.boltGroup)
  }

  /** エネルギー弾を発射(spreadは呼び出し側でdirに適用済みであること) */
  fireBolt(origin: THREE.Vector3, dir: THREE.Vector3, opts: BoltOpts) {
    const d = dir.clone().normalize()
    const size = opts.size ?? 0.09
    const geo = new THREE.SphereGeometry(size, 8, 6)
    const mat = new THREE.MeshBasicMaterial({
      color: opts.color ?? 0xffe9a0,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    mat.color.multiplyScalar(2.6) // HDR輝度に押し上げてブルームで光らせる
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.copy(origin)
    // 進行方向に引き伸ばして光条に見せる
    const stretch = Math.min(6, 1.5 + opts.speed * 0.025)
    mesh.scale.set(1, 1, stretch)
    mesh.lookAt(origin.clone().add(d))
    this.boltGroup.add(mesh)
    this.bolts.push({
      pos: origin.clone(),
      vel: d.multiplyScalar(opts.speed),
      traveled: 0,
      opts,
      mesh,
      geo,
      mat,
      alive: true,
    })
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
      const dir = b.vel.clone().normalize()

      // 障害物との交差
      this.ray.set(b.pos, dir)
      this.ray.near = 0
      this.ray.far = step
      const obs = this.ray.intersectObjects(this.world.obstacleMeshes, true) // 再帰: GLB props(噴水/宝箱)のGroupは子Meshにジオメトリがあるため
      const obsDist = obs.length ? obs[0].distance : Infinity

      // 敵ユニットとの交差
      const meshes: THREE.Mesh[] = []
      for (const u of this.world.units) {
        if (u.alive && u.team !== b.opts.team && u !== b.opts.from) meshes.push(...u.hitMeshes)
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
          this.explode(b.pos.clone(), b.opts.explosive.radius, dmg, b.opts.team, b.opts.from)
        } else {
          sphere.damage(b.opts.team, dmg)
          this.fx.spark(b.pos.clone(), b.opts.color ?? 0xff9060)
        }
        this.killBolt(i)
        continue
      }

      b.pos.addScaledVector(dir, step)
      b.traveled += step
      b.mesh.position.copy(b.pos)
      if (b.opts.gravity) b.mesh.lookAt(b.pos.clone().add(b.vel))
      const maxRange = b.opts.maxRange ?? 110
      if (b.traveled > maxRange || b.pos.y < -10) {
        this.killBolt(i)
      }
    }
  }

  private killBolt(i: number) {
    const b = this.bolts[i]
    this.boltGroup.remove(b.mesh)
    b.geo.dispose()
    b.mat.dispose()
    this.bolts.splice(i, 1)
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
    for (const b of this.bolts) {
      this.boltGroup.remove(b.mesh)
      b.geo.dispose()
      b.mat.dispose()
    }
    this.bolts = []
  }
}
