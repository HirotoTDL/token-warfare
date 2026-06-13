import * as THREE from 'three'
import { World, type AABB } from './world'
import { TEAM_COLOR, type Team } from './types'

const POP = [0xff4fa3, 0x29d3e8, 0xffd23e, 0x9b5cff, 0x49c46a, 0xff7a2f]

const _texLoader = new THREE.TextureLoader()
/**
 * 外部テクスチャ(public/art/<name>.png)を読み込む。
 * 既存のフォールバック・テクスチャに上書きする形でマテリアルへ適用するため、
 * マテリアルを渡すとロード完了時に自動で差し替える。無ければフォールバックのまま。
 */
function applyExtTexture(
  mat: THREE.MeshStandardMaterial,
  name: string,
  repeat: [number, number] = [1, 1],
) {
  _texLoader.load(
    `art/${name}.png`,
    (tex) => {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping
      tex.repeat.set(repeat[0], repeat[1])
      tex.colorSpace = THREE.SRGBColorSpace
      mat.map = tex
      mat.color.set(0xffffff)
      mat.needsUpdate = true
    },
    undefined,
    () => {}, // 無ければフォールバックのまま
  )
}

function aabb(cx: number, cz: number, w: number, h: number, d: number, y0 = 0): AABB {
  return {
    min: new THREE.Vector3(cx - w / 2, y0, cz - d / 2),
    max: new THREE.Vector3(cx + w / 2, y0 + h, cz + d / 2),
  }
}

/** ストリート風アスファルト+ペイント */
function groundTexture(): THREE.Texture {
  const c = document.createElement('canvas')
  c.width = c.height = 512
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#454c5c'
  ctx.fillRect(0, 0, 512, 512)
  // アスファルトノイズ
  for (let i = 0; i < 600; i++) {
    ctx.fillStyle = Math.random() < 0.5 ? '#3d4452' : '#4d5566'
    ctx.fillRect(Math.random() * 510, Math.random() * 510, 2.5, 2.5)
  }
  // ペイントスプラット
  const colors = ['#ff4fa3', '#29d3e8', '#ffd23e', '#9b5cff', '#49c46a']
  for (let i = 0; i < 7; i++) {
    ctx.fillStyle = colors[i % colors.length] + '38'
    ctx.beginPath()
    ctx.arc(40 + Math.random() * 432, 40 + Math.random() * 432, 14 + Math.random() * 26, 0, Math.PI * 2)
    ctx.fill()
  }
  // レーンライン
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)'
  ctx.lineWidth = 5
  ctx.setLineDash([26, 18])
  ctx.beginPath()
  ctx.moveTo(0, 256); ctx.lineTo(512, 256)
  ctx.moveTo(256, 0); ctx.lineTo(256, 512)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.strokeStyle = 'rgba(255, 79, 163, 0.3)'
  ctx.lineWidth = 4
  ctx.strokeRect(6, 6, 500, 500)
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(10, 10)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/** グラフィティ風の壁テクスチャ */
function graffitiTexture(): THREE.Texture {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 128
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#7c8595'
  ctx.fillRect(0, 0, 256, 128)
  const colors = ['#ff4fa3', '#29d3e8', '#ffd23e', '#9b5cff', '#ffffff']
  // ストロークとサークルでそれっぽく
  for (let i = 0; i < 9; i++) {
    ctx.strokeStyle = colors[Math.floor(Math.random() * colors.length)] + 'cc'
    ctx.lineWidth = 4 + Math.random() * 7
    ctx.lineCap = 'round'
    ctx.beginPath()
    const x = Math.random() * 220 + 18
    const y = Math.random() * 90 + 19
    ctx.moveTo(x, y)
    ctx.quadraticCurveTo(x + (Math.random() - 0.5) * 90, y + (Math.random() - 0.5) * 70, x + (Math.random() - 0.5) * 120, y + (Math.random() - 0.5) * 50)
    ctx.stroke()
  }
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = colors[Math.floor(Math.random() * colors.length)] + '90'
    ctx.beginPath()
    ctx.arc(Math.random() * 256, Math.random() * 128, 8 + Math.random() * 16, 0, Math.PI * 2)
    ctx.fill()
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

export interface MapInfo {
  key: string
  name: string
  desc: string
}

export const MAPS: MapInfo[] = [
  { key: 'skyhaven', name: 'スカイヘイヴン', desc: '中央監視塔と十字の遮蔽。バランス型' },
  { key: 'neondocks', name: 'ネオンドックス', desc: '夕暮れの大通り。長い射線と側道の裏取り' },
]

export function buildArena(world: World, mapKey = 'skyhaven') {
  const scene = world.scene
  const half = world.arenaHalf
  const updates: ((dt: number, t: number) => void)[] = []
  const dusk = mapKey === 'neondocks'

  scene.fog = new THREE.Fog(dusk ? 0xd98aa6 : 0xf0dcec, 80, 460)

  // --- ライティング ---
  const sunDir = new THREE.Vector3(40, dusk ? 30 : 62, 26)
  const sun = new THREE.DirectionalLight(dusk ? 0xffc090 : 0xfff2e0, dusk ? 2.3 : 2.7)
  sun.position.copy(sunDir)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.camera.left = -55
  sun.shadow.camera.right = 55
  sun.shadow.camera.top = 55
  sun.shadow.camera.bottom = -55
  sun.shadow.camera.near = 10
  sun.shadow.camera.far = 180
  sun.shadow.bias = -0.0004
  scene.add(sun)
  scene.add(new THREE.HemisphereLight(dusk ? 0x9a86c8 : 0xc8d8f5, dusk ? 0x55384a : 0x5a4a50, dusk ? 0.75 : 0.8))

  // --- 浮遊島本体 ---
  const groundMat = new THREE.MeshStandardMaterial({
    map: groundTexture(),
    roughness: 0.85,
    metalness: 0.1,
  })
  // AI生成の地面テクスチャがあれば差し替え(無ければプロシージャル)
  applyExtTexture(groundMat, dusk ? 'tex_ground_dusk' : 'tex_ground', [11, 11])
  const ground = new THREE.Mesh(new THREE.BoxGeometry(half * 2 + 4, 2, half * 2 + 4), groundMat)
  ground.position.y = -1
  ground.receiveShadow = true
  scene.add(ground)
  world.obstacleMeshes.push(ground)

  const rockMat = new THREE.MeshStandardMaterial({ color: 0x5a4a3c, roughness: 0.95 })
  const rock1 = new THREE.Mesh(new THREE.BoxGeometry(68, 6, 68), rockMat)
  rock1.position.y = -5
  scene.add(rock1)
  const rock2 = new THREE.Mesh(new THREE.BoxGeometry(42, 8, 42), rockMat)
  rock2.position.y = -11
  scene.add(rock2)
  const rockTip = new THREE.Mesh(new THREE.ConeGeometry(18, 16, 8), rockMat)
  rockTip.rotation.x = Math.PI
  rockTip.position.y = -22
  scene.add(rockTip)

  // --- ネオンエッジ+境界ホロフェンス ---
  for (let i = 0; i < 4; i++) {
    const neonMat = new THREE.MeshStandardMaterial({
      color: i % 2 ? 0xff4fa3 : 0x29d3e8,
      emissive: i % 2 ? 0xff4fa3 : 0x29d3e8,
      emissiveIntensity: 1.4,
    })
    const strip = new THREE.Mesh(new THREE.BoxGeometry(half * 2, 0.14, 0.14), neonMat)
    strip.position.y = 0.07
    if (i === 0) strip.position.z = half + 1.9
    if (i === 1) strip.position.z = -half - 1.9
    if (i === 2) { strip.position.x = half + 1.9; strip.rotation.y = Math.PI / 2 }
    if (i === 3) { strip.position.x = -half - 1.9; strip.rotation.y = Math.PI / 2 }
    scene.add(strip)

    const fenceMat = new THREE.MeshBasicMaterial({
      color: i % 2 ? 0xff4fa3 : 0x29d3e8,
      transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false,
    })
    const f = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, 4), fenceMat)
    f.position.y = 2
    if (i === 0) f.position.z = half
    if (i === 1) f.position.z = -half
    if (i === 2) { f.position.x = half; f.rotation.y = Math.PI / 2 }
    if (i === 3) { f.position.x = -half; f.rotation.y = Math.PI / 2 }
    scene.add(f)
  }

  // --- 障害物 ---
  const graffiti = graffitiTexture()
  const wallMat = new THREE.MeshStandardMaterial({ map: graffiti, roughness: 0.6, metalness: 0.2 })
  let crateIdx = 0

  function solid(geo: THREE.BufferGeometry, mat: THREE.Material, cx: number, cy: number, cz: number, box: AABB, cover = true) {
    const m = new THREE.Mesh(geo, mat)
    m.position.set(cx, cy, cz)
    m.castShadow = true
    m.receiveShadow = true
    scene.add(m)
    world.obstacleMeshes.push(m)
    world.addCollider(box)
    if (cover) {
      const exX = (box.max.x - box.min.x) / 2 + 1.3
      const exZ = (box.max.z - box.min.z) / 2 + 1.3
      const pts = [
        new THREE.Vector3(cx + exX, 0, cz), new THREE.Vector3(cx - exX, 0, cz),
        new THREE.Vector3(cx, 0, cz + exZ), new THREE.Vector3(cx, 0, cz - exZ),
      ]
      for (const p of pts) {
        if (Math.abs(p.x) < half - 2 && Math.abs(p.z) < half - 2) world.coverPoints.push(p)
      }
    }
    return m
  }

  // コンテナ箱のテクスチャ(AI生成 tex_crate があれば使用、無ければポップ単色)
  const crateMatBase = new THREE.MeshStandardMaterial({ color: 0x9aa3b2, roughness: 0.55, metalness: 0.35 })
  applyExtTexture(crateMatBase, 'tex_crate', [1, 1])
  function crate(cx: number, cz: number, size: number) {
    crateIdx++
    // テクスチャは共有(非同期ロード後に全クレートへ反映)。立体感はエッジトリムで付与
    const m = solid(new THREE.BoxGeometry(size, size, size), crateMatBase, cx, size / 2, cz, aabb(cx, cz, size, size, size))
    const trimColor = POP[crateIdx % POP.length]
    const trim = new THREE.Mesh(
      new THREE.BoxGeometry(size * 1.02, size * 0.06, size * 1.02),
      new THREE.MeshStandardMaterial({ color: trimColor, emissive: trimColor, emissiveIntensity: 0.6, roughness: 0.4 }),
    )
    trim.position.set(cx, size - size * 0.03, cz)
    scene.add(trim)
    return m
  }

  function wall(cx: number, cz: number, w: number, d: number, h = 2.4) {
    solid(new THREE.BoxGeometry(w, h, d), wallMat, cx, h / 2, cz, aabb(cx, cz, w, h, d))
  }

  const barrelMat = new THREE.MeshStandardMaterial({ color: 0xff5040, roughness: 0.45, metalness: 0.3 })
  const barrelMat2 = new THREE.MeshStandardMaterial({ color: 0x29d3e8, roughness: 0.45, metalness: 0.3 })
  const barrelGeo = new THREE.CylinderGeometry(0.5, 0.5, 1.15, 14)
  let bIdx = 0
  function barrel(bx: number, bz: number) {
    solid(barrelGeo, bIdx++ % 2 ? barrelMat : barrelMat2, bx, 0.575, bz, aabb(bx, bz, 1.0, 1.15, 1.0), false)
  }
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0x8a94a2, roughness: 0.5, metalness: 0.45 })

  // 回転エンブレム(両マップ共通の中央モチーフ)
  function emblemAt(x: number, y: number, z: number) {
    const emblemMat = new THREE.MeshStandardMaterial({
      color: 0xffe066, emissive: 0xcfa830, emissiveIntensity: 0.9,
      metalness: 0.8, roughness: 0.3,
    })
    const emblem = new THREE.Mesh(new THREE.OctahedronGeometry(0.7), emblemMat)
    emblem.position.set(x, y, z)
    scene.add(emblem)
    updates.push((dt, t) => {
      emblem.rotation.y += dt * 0.8
      emblem.position.y = y + Math.sin(t * 1.2) * 0.18
    })
  }

  if (mapKey === 'neondocks') {
    // ===== ネオンドックス: 中央大通り+両翼の側道 =====
    // 大通りの長壁(中央に横断ギャップ)
    wall(7, -9, 0.9, 12, 2.6); wall(-7, -9, 0.9, 12, 2.6)
    wall(7, 9, 0.9, 12, 2.6); wall(-7, 9, 0.9, 12, 2.6)
    // 中央ゲート(プラザの目印)
    for (const px of [-2.4, 2.4]) {
      solid(new THREE.BoxGeometry(1.0, 5.0, 1.0), pillarMat, px, 2.5, 0, aabb(px, 0, 1.0, 5.0, 1.0))
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(6.2, 0.5, 1.2), wallMat)
    beam.position.y = 5.2
    beam.castShadow = true
    scene.add(beam)
    world.obstacleMeshes.push(beam)
    emblemAt(0, 3.6, 0)
    // 側道フィールドのクレート群
    crate(16, 5, 2.2); crate(-16, -5, 2.2)
    crate(16, -5, 2.0); crate(-16, 5, 2.0)
    crate(23, 11, 2.4); crate(-23, -11, 2.4)
    crate(23, -11, 1.8); crate(-23, 11, 1.8)
    crate(13, 20, 2.0); crate(-13, -20, 2.0)
    crate(13.8, 20.7, 1.1); crate(-13.8, -20.7, 1.1)
    // コーナーバリケード
    wall(27, 22, 6, 0.9, 2.2); wall(-27, -22, 6, 0.9, 2.2)
    wall(27, -22, 6, 0.9, 2.2); wall(-27, 22, 6, 0.9, 2.2)
    // 大通り出入口のバレル
    barrel(0, 18.5); barrel(1.2, 19.3); barrel(0, -18.5); barrel(-1.2, -19.3)
    barrel(20, 0); barrel(-20, 0)
    world.coreSpots = [
      new THREE.Vector3(0, 0, 16), new THREE.Vector3(0, 0, -16),
      new THREE.Vector3(17, 0, 0), new THREE.Vector3(-17, 0, 0),
      new THREE.Vector3(24, 0, 16), new THREE.Vector3(-24, 0, -16),
      new THREE.Vector3(24, 0, -16), new THREE.Vector3(-24, 0, 16),
    ]
  } else {
    // ===== スカイヘイヴン: 中央監視塔+十字遮蔽 =====
    crate(10, 8, 2.2); crate(-10, -8, 2.2)
    crate(-12, 14, 2.0); crate(12, -14, 2.0)
    crate(22, 3, 2.4); crate(-22, -3, 2.4)
    crate(5, 22, 1.8); crate(-5, -22, 1.8)
    crate(18, 18, 2.0); crate(-18, -18, 2.0)
    crate(16, -22, 1.8); crate(-16, 22, 1.8)
    crate(27, -12, 2.0); crate(-27, 12, 2.0)
    crate(9.7, 8.2, 1.2); crate(-9.7, -8.2, 1.2)

    wall(0, 13, 7, 0.9); wall(0, -13, 7, 0.9)
    wall(13, 0, 0.9, 7); wall(-13, 0, 0.9, 7)
    wall(26, 20, 6, 0.9, 2.2); wall(-26, -20, 6, 0.9, 2.2)
    wall(30, -2, 0.9, 6, 2.2); wall(-30, 2, 0.9, 6, 2.2)

    barrel(12.2, 2.4); barrel(13.1, 3.1); barrel(-12.2, -2.4); barrel(3.2, -24); barrel(-3.2, 24)

    // 中央監視塔
    for (const [px, pz] of [[2.9, 2.9], [-2.9, 2.9], [2.9, -2.9], [-2.9, -2.9]] as const) {
      solid(new THREE.BoxGeometry(1.15, 5.6, 1.15), pillarMat, px, 2.8, pz, aabb(px, pz, 1.15, 5.6, 1.15))
    }
    const roof = new THREE.Mesh(new THREE.BoxGeometry(8.6, 0.5, 8.6), wallMat)
    roof.position.y = 5.85
    roof.castShadow = true
    roof.receiveShadow = true
    scene.add(roof)
    world.obstacleMeshes.push(roof)
    const neonRing = new THREE.Mesh(
      new THREE.TorusGeometry(4.6, 0.08, 8, 40),
      new THREE.MeshStandardMaterial({ color: 0xff4fa3, emissive: 0xff4fa3, emissiveIntensity: 1.6 }),
    )
    neonRing.rotation.x = Math.PI / 2
    neonRing.position.y = 6.2
    scene.add(neonRing)
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.09, 3.2, 8), pillarMat)
    antenna.position.y = 7.7
    scene.add(antenna)
    const beacon = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xff4040, emissiveIntensity: 2 }),
    )
    beacon.position.y = 9.4
    scene.add(beacon)
    updates.push((_dt, t) => {
      ;(beacon.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.2 + Math.sin(t * 4) * 1.0
    })
    emblemAt(0, 3.4, 0)
  }

  // --- 両軍基地 ---
  for (const team of ['blue', 'red'] as Team[]) {
    const bp = world.basePos[team]
    const tc = TEAM_COLOR[team]
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(5.5, 5.8, 0.3, 28),
      new THREE.MeshStandardMaterial({ color: 0x4a525e, roughness: 0.6, metalness: 0.4 }),
    )
    pad.position.set(bp.x, 0.15, bp.z)
    pad.receiveShadow = true
    pad.castShadow = true
    scene.add(pad)
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(4.9, 0.1, 8, 40),
      new THREE.MeshStandardMaterial({ color: tc, emissive: tc, emissiveIntensity: 1.4 }),
    )
    ring.rotation.x = -Math.PI / 2
    ring.position.set(bp.x, 0.32, bp.z)
    scene.add(ring)
    const wallM = new THREE.MeshStandardMaterial({ color: 0x808a96, roughness: 0.6, metalness: 0.4 })
    for (const sx of [-4, 4]) {
      const px = bp.x + sx
      const pz = bp.z
      solid(new THREE.BoxGeometry(1, 4.2, 1), wallM, px, 2.1, pz, aabb(px, pz, 1, 4.2, 1), false)
      const cap = new THREE.Mesh(
        new THREE.BoxGeometry(1.15, 0.25, 1.15),
        new THREE.MeshStandardMaterial({ color: tc, emissive: tc, emissiveIntensity: 1.2 }),
      )
      cap.position.set(px, 4.35, pz)
      scene.add(cap)
    }
    const bannerMat = new THREE.MeshBasicMaterial({
      color: tc, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false,
    })
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.8), bannerMat)
    banner.position.set(bp.x, 5.6, bp.z)
    scene.add(banner)
    updates.push((dt, t) => {
      banner.material.opacity = 0.3 + Math.sin(t * 2 + (team === 'red' ? 2 : 0)) * 0.12
      banner.rotation.y += dt * 0.4
    })
    world.coverPoints.push(
      new THREE.Vector3(bp.x + 6, 0, bp.z * 0.82),
      new THREE.Vector3(bp.x - 6, 0, bp.z * 0.82),
    )
  }

  // --- ランプポスト(ピンク/シアンのネオン) ---
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x39414e, roughness: 0.6, metalness: 0.5 })
  let lampIdx = 0
  for (const [lx, lz] of [[15, 15], [-15, 15], [15, -15], [-15, -15]] as const) {
    const neon = lampIdx++ % 2 ? 0xff4fa3 : 0x29d3e8
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 3.6, 8), poleMat)
    pole.position.set(lx, 1.8, lz)
    pole.castShadow = true
    scene.add(pole)
    const head = new THREE.Mesh(
      new THREE.BoxGeometry(0.35, 0.2, 0.35),
      new THREE.MeshStandardMaterial({ color: neon, emissive: neon, emissiveIntensity: 1.6 }),
    )
    head.position.set(lx, 3.7, lz)
    scene.add(head)
    const light = new THREE.PointLight(neon, 12, 15, 2)
    light.position.set(lx, 3.5, lz)
    scene.add(light)
  }

  // --- エナジーコア出現スポット(レイアウト側で未設定ならデフォルト) ---
  if (!world.coreSpots.length) {
    world.coreSpots = [
      new THREE.Vector3(18, 0, 0), new THREE.Vector3(-18, 0, 0),
      new THREE.Vector3(0, 0, 18), new THREE.Vector3(0, 0, -18),
      new THREE.Vector3(24, 0, 20), new THREE.Vector3(-24, 0, -20),
      new THREE.Vector3(24, 0, -20), new THREE.Vector3(-24, 0, 20),
    ]
  }
  // スポットの目印(うっすら光る円)
  for (const sp of world.coreSpots) {
    const marker = new THREE.Mesh(
      new THREE.RingGeometry(0.7, 0.95, 24),
      new THREE.MeshBasicMaterial({ color: 0xffd23e, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }),
    )
    marker.rotation.x = -Math.PI / 2
    marker.position.set(sp.x, 0.06, sp.z)
    scene.add(marker)
  }

  // --- 浮遊パーティクル(空気感の演出) ---
  {
    const count = 240
    const pos = new Float32Array(count * 3)
    const vel = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * half * 2
      pos[i * 3 + 1] = Math.random() * 12
      pos[i * 3 + 2] = (Math.random() - 0.5) * half * 2
      vel[i] = 0.2 + Math.random() * 0.5
    }
    const pGeo = new THREE.BufferGeometry()
    pGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    const pMat = new THREE.PointsMaterial({
      color: dusk ? 0xffa0c8 : 0xaee8ff,
      size: 0.08, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    })
    pMat.color.multiplyScalar(1.6)
    const points = new THREE.Points(pGeo, pMat)
    scene.add(points)
    updates.push((dt, t) => {
      for (let i = 0; i < count; i++) {
        pos[i * 3 + 1] += vel[i] * dt
        pos[i * 3] += Math.sin(t * 0.6 + i) * dt * 0.25
        if (pos[i * 3 + 1] > 13) pos[i * 3 + 1] = 0
      }
      pGeo.attributes.position.needsUpdate = true
    })
  }

  // --- 遠景の浮遊岩 ---
  const farMat = new THREE.MeshStandardMaterial({ color: 0x6e8096, roughness: 0.9 })
  const floaters: { g: THREE.Group; phase: number; amp: number }[] = []
  for (let i = 0; i < 9; i++) {
    const g = new THREE.Group()
    const a = (i / 9) * Math.PI * 2 + 0.4
    const r = 130 + (i % 3) * 55 + (i * 13) % 30
    const s = 6 + (i * 7) % 12
    const rock = new THREE.Mesh(new THREE.BoxGeometry(s, s * 0.5, s * 0.8), farMat)
    const tip = new THREE.Mesh(new THREE.ConeGeometry(s * 0.4, s * 0.7, 6), farMat)
    tip.rotation.x = Math.PI
    tip.position.y = -s * 0.55
    const top = new THREE.Mesh(new THREE.BoxGeometry(s * 0.7, s * 0.2, s * 0.6), farMat)
    top.position.y = s * 0.32
    g.add(rock, tip, top)
    g.position.set(Math.cos(a) * r, -14 + ((i * 17) % 46), Math.sin(a) * r)
    g.rotation.y = a * 2
    scene.add(g)
    floaters.push({ g, phase: i * 1.7, amp: 0.8 + (i % 3) * 0.5 })
  }
  updates.push((_dt, t) => {
    for (const f of floaters) f.g.position.y += Math.sin(t * 0.35 + f.phase) * 0.004 * f.amp
  })

  return {
    sunDir,
    dusk,
    update(dt: number, t: number) {
      for (const u of updates) u(dt, t)
    },
  }
}
