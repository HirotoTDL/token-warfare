import * as THREE from 'three'
import { World, type AABB } from './world'
import { TEAM_COLOR, type Team } from './types'
import { getScenery } from './modelLoader'

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
  { key: 'skyhaven', name: 'スカイガーデン', desc: '天空の花畑。中央監視塔と十字の遮蔽。バランス型' },
  { key: 'neondocks', name: 'トワイライトフォレスト', desc: '夜の魔法の森。長い射線と側道の裏取り' },
  { key: 'crystalsprings', name: 'クリスタルスプリング', desc: '妖精の泉。中央クリスタルと対角の遮蔽。開けた撃ち合い' },
]

export function buildArena(world: World, mapKey = 'skyhaven') {
  const scene = world.scene
  const half = world.arenaHalf
  const updates: ((dt: number, t: number) => void)[] = []
  const dusk = mapKey === 'neondocks'
  const crystal = mapKey === 'crystalsprings'

  // 空気遠近: 近景はクリア、遠景は緩やかに霞ませて広大な奥行きを出す
  scene.fog = new THREE.Fog(crystal ? 0xd6f0ff : dusk ? 0xd98aa6 : 0xf0dcec, 130, 760)

  // --- ライティング ---
  const sunDir = new THREE.Vector3(40, dusk ? 30 : 62, 26)
  const sun = new THREE.DirectionalLight(crystal ? 0xeaf6ff : dusk ? 0xffc090 : 0xfff2e0, crystal ? 2.85 : dusk ? 2.3 : 2.7)
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
  scene.add(new THREE.HemisphereLight(crystal ? 0xd2f2ff : dusk ? 0x9a86c8 : 0xc8d8f5, crystal ? 0x9cc8e4 : dusk ? 0x55384a : 0x5a4a50, crystal ? 0.9 : dusk ? 0.75 : 0.8))

  // --- 浮遊島本体 ---
  const groundMat = new THREE.MeshStandardMaterial({
    map: groundTexture(),
    roughness: 0.85,
    metalness: 0.1,
  })
  // AI生成の地面テクスチャがあれば差し替え(無ければプロシージャル)
  applyExtTexture(groundMat, crystal ? 'tex_ground_crystal' : dusk ? 'tex_ground_dusk' : 'tex_ground', [11, 11])
  const ground = new THREE.Mesh(new THREE.BoxGeometry(half * 2 + 4, 2, half * 2 + 4), groundMat)
  ground.position.y = -1
  ground.receiveShadow = true
  scene.add(ground)
  world.obstacleMeshes.push(ground)

  // --- 広大な外周フィールド: プレイ範囲外にも地形が連続し、箱庭感を消す ---
  // 小さな浮遊島の基盤を廃し、遠方まで続く大地に。プレイ床はこの上にわずかに乗る。
  const outerMat = new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 0.92, metalness: 0.04 })
  applyExtTexture(outerMat, crystal ? 'tex_ground_crystal' : dusk ? 'tex_ground_dusk' : 'tex_ground', [86, 86])
  const outer = new THREE.Mesh(new THREE.PlaneGeometry(560, 560), outerMat)
  outer.rotation.x = -Math.PI / 2
  outer.position.y = -0.04
  outer.receiveShadow = true
  scene.add(outer)

  // --- 境界の曖昧化: 硬い壁を廃し、散在する草叢・花・小岩で縁をぼかす ---
  // プレイ縁(half)を「線」として見せず、外側へ不規則に植生を散らして大地に溶かす。
  {
    const tuftGeo = new THREE.ConeGeometry(0.6, 1.5, 5)
    const bushGeo = new THREE.SphereGeometry(0.9, 7, 6)
    const tuftMats = [0x8fe39a, 0xa7e8b0, 0x7fd6c0, 0x9be0a8].map(
      (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.95 }),
    )
    const flowerMats = [0xff9ec7, 0xc6a7ff, 0xfff1a8, 0xffffff, 0x9fe8ff].map(
      (c) => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.35, roughness: 0.6 }),
    )
    const rockMat2 = new THREE.MeshStandardMaterial({ color: 0x97a6b8, roughness: 0.95 })
    for (let i = 0; i < 150; i++) {
      const ang = Math.random() * Math.PI * 2
      // プレイ縁付近を濃く、外へ向かって疎に(pow>1 で内側に偏らせる)
      const rad = half - 2 + Math.pow(Math.random(), 1.7) * 120
      const x = Math.cos(ang) * rad
      const z = Math.sin(ang) * rad
      const s = 0.7 + Math.random() * 2.0
      const tuft = new THREE.Mesh(tuftGeo, tuftMats[i % tuftMats.length])
      tuft.scale.set(s, s * (1 + Math.random() * 1.2), s)
      tuft.position.set(x, s * 0.75, z)
      tuft.castShadow = true
      scene.add(tuft)
      if (i % 3 === 0) {
        const bush = new THREE.Mesh(bushGeo, tuftMats[(i + 1) % tuftMats.length])
        const bs = 0.8 + Math.random() * 1.6
        bush.scale.set(bs, bs * 0.7, bs)
        bush.position.set(x + (Math.random() - 0.5) * 2, bs * 0.5, z + (Math.random() - 0.5) * 2)
        bush.castShadow = true
        scene.add(bush)
      }
      if (i % 2 === 0) {
        const fl = new THREE.Mesh(new THREE.SphereGeometry(0.16 * s, 6, 5), flowerMats[i % flowerMats.length])
        fl.position.set(x + (Math.random() - 0.5) * 1.5, 0.22 * s, z + (Math.random() - 0.5) * 1.5)
        scene.add(fl)
      }
      if (i % 5 === 0) {
        const rk = new THREE.Mesh(new THREE.DodecahedronGeometry(0.5 + Math.random()), rockMat2)
        rk.position.set(x + (Math.random() - 0.5) * 3, 0.3, z + (Math.random() - 0.5) * 3)
        rk.rotation.set(Math.random(), Math.random(), Math.random())
        scene.add(rk)
      }
    }
  }

  // --- 障害物 ---
  const graffiti = graffitiTexture()
  const wallMat = new THREE.MeshStandardMaterial({ map: graffiti, roughness: 0.6, metalness: 0.2 })
  // 壁・胸壁・屋根を魔法石ブロックに(クレートのクリスタルパネルと差別化し砦感を出す)
  applyExtTexture(wallMat, 'tex_magic_stone_blocks', [1.5, 1.5])
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
  applyExtTexture(pillarMat, 'tex_jewel_inlay_panel', [1, 2])

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
  } else if (crystal) {
    // ===== クリスタルスプリング: 中央クリスタル群+対角クリスタル壁 =====
    const crystalMat = new THREE.MeshStandardMaterial({
      color: 0x9fe8ff, emissive: 0x4fc6ff, emissiveIntensity: 0.55,
      metalness: 0.2, roughness: 0.22, transparent: true, opacity: 0.92,
    })
    // 中央の大クリスタル群(登れない遮蔽。各シャードを衝突体に)
    for (const [px, pz, h] of [[0, 0, 5.6], [2.7, 1.5, 3.8], [-2.5, 1.7, 3.3], [1.9, -2.3, 3.1], [-2.1, -2.1, 3.6]] as const) {
      solid(new THREE.ConeGeometry(h * 0.34, h, 6), crystalMat, px, h / 2, pz, aabb(px, pz, h * 0.6, h, h * 0.6))
    }
    emblemAt(0, 4.6, 0)
    // 対角のクリスタル壁(射線カット)
    wall(10, 10, 0.9, 8, 2.4); wall(-10, -10, 0.9, 8, 2.4)
    wall(10, -10, 8, 0.9, 2.4); wall(-10, 10, 8, 0.9, 2.4)
    // 外周の散開クレート
    crate(16, 4, 2.2); crate(-16, -4, 2.2)
    crate(6, 18, 2.0); crate(-6, -18, 2.0)
    crate(22, -14, 2.4); crate(-22, 14, 2.4)
    crate(24, 12, 1.8); crate(-24, -12, 1.8)
    crate(14, -22, 2.0); crate(-14, 22, 2.0)
    crate(15.6, 4.4, 1.1); crate(-15.6, -4.4, 1.1)
    // コーナーバリケード+バレル
    wall(27, 22, 6, 0.9, 2.2); wall(-27, -22, 6, 0.9, 2.2)
    barrel(12, 12); barrel(-12, -12); barrel(0, 20); barrel(0, -20)
    world.coreSpots = [
      new THREE.Vector3(0, 0, 15), new THREE.Vector3(0, 0, -15),
      new THREE.Vector3(18, 0, 0), new THREE.Vector3(-18, 0, 0),
      new THREE.Vector3(22, 0, 18), new THREE.Vector3(-22, 0, -18),
      new THREE.Vector3(22, 0, -18), new THREE.Vector3(-22, 0, 18),
    ]
  } else {
    // ===== スカイガーデン(立体構造・高所争奪): 中央コマンドデッキ＋段差＋四隅足場 =====
    // プラットフォーム素材(後でテクスチャ張替)。上に立てる箱コライダー。
    const deckMat = new THREE.MeshStandardMaterial({ color: 0xb9c4d4, roughness: 0.7, metalness: 0.25 })
    const stepMat = new THREE.MeshStandardMaterial({ color: 0x9aa6ba, roughness: 0.72, metalness: 0.2 })
    applyExtTexture(deckMat, 'tex_deck', [3, 3])
    applyExtTexture(stepMat, 'tex_step', [2, 1])
    // 床から topY までの箱。上面に乗れる(プレイヤー)。
    const platform = (cx: number, cz: number, w: number, d: number, topY: number, mat = deckMat) => {
      solid(new THREE.BoxGeometry(w, topY, d), mat, cx, topY / 2, cz, aabb(cx, cz, w, topY, d))
    }
    // 高所の縁に置く胸壁(遮蔽)。baseYは床面の高さ。
    const parapet = (cx: number, cz: number, w: number, d: number, baseY: number, h = 1.1) => {
      solid(new THREE.BoxGeometry(w, h, d), wallMat, cx, baseY + h / 2, cz, {
        min: new THREE.Vector3(cx - w / 2, baseY, cz - d / 2),
        max: new THREE.Vector3(cx + w / 2, baseY + h, cz + d / 2),
      }, false)
    }

    // --- 中央コマンドデッキ(高所拠点 top=2.4, 12x12)。中央を取ると有利、3方向から登れる ---
    const DECK = 2.4
    platform(0, 0, 12, 12, DECK)
    // 登り口ステップ(各≤1.1mでジャンプ登攀可)。北/南東/南西の3ルート
    platform(0, 8.4, 5.5, 2.0, 0.8, stepMat); platform(0, 6.9, 5.5, 2.2, 1.6, stepMat)
    platform(8.4, -5.0, 2.0, 5.5, 0.8, stepMat); platform(6.9, -5.0, 2.2, 5.5, 1.6, stepMat)
    platform(-8.4, -5.0, 2.0, 5.5, 0.8, stepMat); platform(-6.9, -5.0, 2.2, 5.5, 1.6, stepMat)
    // デッキ上の胸壁(四辺の遮蔽。中央は開けて撃ち合い)
    parapet(0, 5.6, 7.5, 0.5, DECK); parapet(0, -5.6, 7.5, 0.5, DECK)
    parapet(5.6, 0, 0.5, 7.5, DECK); parapet(-5.6, 0, 0.5, 7.5, DECK)

    // --- 左右フランク台(top=1.6, 中段の回り込み+遮蔽) ---
    for (const sx of [1, -1]) {
      platform(sx * 16, 2, 6, 7, 1.6); platform(sx * 16, 6.0, 4.5, 1.8, 0.8, stepMat)
      parapet(sx * 16, -1.4, 6, 0.5, 1.6)
    }

    // --- 四隅スナイパー足場(top=2.4, 長射線・露出リスク) ---
    for (const [sx, sz] of [[1, 1], [-1, -1], [1, -1], [-1, 1]] as const) {
      platform(sx * 24, sz * 24, 6, 6, 2.4)
      platform(sx * 20.5, sz * 24, 2.0, 5, 0.9, stepMat); platform(sx * 22.2, sz * 24, 2.0, 5, 1.7, stepMat)
      parapet(sx * 24, sz * 26.0, 6, 0.5, 2.4, 1.0)
      parapet(sx * 26.0, sz * 24, 0.5, 6, 2.4, 1.0)
    }

    // --- 地上の多層遮蔽(低い箱=飛び乗り可 / 中段の壁=射線カット) ---
    crate(11, -10, 1.1); crate(-11, 10, 1.1)
    crate(20, -8, 1.2); crate(-20, 8, 1.2)
    crate(9, 16, 2.0); crate(-9, -16, 2.0)
    crate(15, 14, 1.1); crate(-15, -14, 1.1)
    wall(0, 20, 6, 0.9, 2.2); wall(0, -20, 6, 0.9, 2.2)
    wall(28, 10, 0.9, 6, 2.2); wall(-28, -10, 0.9, 6, 2.2)
    barrel(12.5, 12.5); barrel(-12.5, -12.5); barrel(19, 0); barrel(-19, 0)

    // --- 中央監視塔(デッキ上に屹立。ランドマーク+最上部の見張り台) ---
    for (const [px, pz] of [[2.6, 2.6], [-2.6, 2.6], [2.6, -2.6], [-2.6, -2.6]] as const) {
      solid(new THREE.BoxGeometry(1.0, 3.4, 1.0), pillarMat, px, DECK + 1.7, pz, {
        min: new THREE.Vector3(px - 0.5, DECK, pz - 0.5),
        max: new THREE.Vector3(px + 0.5, DECK + 3.4, pz + 0.5),
      }, false)
    }
    const roof = new THREE.Mesh(new THREE.BoxGeometry(7.2, 0.5, 7.2), wallMat)
    roof.position.y = DECK + 3.85
    roof.castShadow = true
    roof.receiveShadow = true
    scene.add(roof)
    world.obstacleMeshes.push(roof)
    const neonRing = new THREE.Mesh(
      new THREE.TorusGeometry(3.9, 0.08, 8, 40),
      new THREE.MeshStandardMaterial({ color: 0xff4fa3, emissive: 0xff4fa3, emissiveIntensity: 1.6 }),
    )
    neonRing.rotation.x = Math.PI / 2
    neonRing.position.y = DECK + 4.2
    scene.add(neonRing)
    const beacon = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xff4040, emissiveIntensity: 2 }),
    )
    beacon.position.y = DECK + 5.0
    scene.add(beacon)
    updates.push((_dt, t) => {
      ;(beacon.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.2 + Math.sin(t * 4) * 1.0
    })
    emblemAt(0, DECK + 1.0, 0)

    // --- フェアリィ・プロップ作り込み(Codex生成テクスチャを活用) ---
    {
      const texMat = (name: string, opt: THREE.MeshStandardMaterialParameters = {}) => {
        const m = new THREE.MeshStandardMaterial({ roughness: 0.72, metalness: 0.08, ...opt })
        applyExtTexture(m, name, [1, 1])
        return m
      }
      const chestMat = texMat('tex_treasure_chest_surface')
      const lanternMat = texMat('tex_lantern_paper', { emissive: 0xffcf86, emissiveIntensity: 0.9 })
      const fountainMat = texMat('tex_fountain_stone')
      const waterMat = texMat('tex_luminous_water', { transparent: true, opacity: 0.82, roughness: 0.2, metalness: 0.3, emissive: 0x6fd0e8, emissiveIntensity: 0.4 })
      const flagMat = texMat('tex_flag_cloth', { side: THREE.DoubleSide })
      const mushMat = texMat('tex_mushroom_cap_surface')
      const soilMat = texMat('tex_flower_bed_soil')
      const poleMat = new THREE.MeshStandardMaterial({ color: 0xcdbfae, roughness: 0.8, metalness: 0.2 })

      // 宝箱(低い遮蔽=飛び乗り可)
      const chest = (x: number, z: number, ry: number) => {
        const g = new THREE.Group()
        const body = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.72, 0.82), chestMat)
        body.position.y = 0.36
        const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.41, 0.41, 1.1, 14, 1, false, 0, Math.PI), chestMat)
        lid.rotation.z = Math.PI / 2
        lid.position.y = 0.72
        g.add(body, lid)
        g.position.set(x, 0, z)
        g.rotation.y = ry
        g.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true } })
        scene.add(g)
        world.addCollider(aabb(x, z, 1.2, 1.0, 0.95))
        world.obstacleMeshes.push(body)
      }
      chest(13, -3, 0.5); chest(-13, 3, -0.7); chest(21, 17, 1.2); chest(-21, -17, 2.1)

      // 提灯ポスト(発光・雰囲気づくり)
      const lantern = (x: number, z: number) => {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.11, 3.0, 8), poleMat)
        pole.position.set(x, 1.5, z)
        pole.castShadow = true
        const shade = new THREE.Mesh(new THREE.SphereGeometry(0.46, 14, 12), lanternMat)
        shade.scale.y = 1.3
        shade.position.set(x, 3.15, z)
        scene.add(pole, shade)
        const lt = new THREE.PointLight(0xffcf86, 7, 13, 2)
        lt.position.set(x, 3.0, z)
        scene.add(lt)
        updates.push((_dt, t) => {
          ;(shade.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.8 + Math.sin(t * 2.5 + x) * 0.2
        })
      }
      lantern(9, 9); lantern(-9, -9); lantern(9, -9); lantern(-9, 9)

      // 噴水(フランク広場の装飾。小さな遮蔽)
      const fountain = (x: number, z: number) => {
        const base = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.3, 0.6, 18), fountainMat)
        base.position.set(x, 0.3, z)
        base.castShadow = true; base.receiveShadow = true
        const water = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.7, 0.18, 18), waterMat)
        water.position.set(x, 0.56, z)
        const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.32, 1.3, 10), fountainMat)
        stem.position.set(x, 1.05, z)
        const top = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 10), waterMat)
        top.position.set(x, 1.85, z)
        scene.add(base, water, stem, top)
        world.addCollider(aabb(x, z, 4.0, 0.8, 4.0))
        world.obstacleMeshes.push(base)
        updates.push((_dt, t) => { top.position.y = 1.85 + Math.sin(t * 2) * 0.06 })
      }
      fountain(24, -2); fountain(-24, 2)

      // 花壇(低い装飾)とキノコ叢(雰囲気)
      const flowerbed = (x: number, z: number, w: number, d: number) => {
        const bed = new THREE.Mesh(new THREE.BoxGeometry(w, 0.4, d), soilMat)
        bed.position.set(x, 0.2, z)
        bed.receiveShadow = true
        scene.add(bed)
      }
      flowerbed(6, -19, 5, 1.6); flowerbed(-6, 19, 5, 1.6); flowerbed(19, -19, 3, 3)
      const mushroom = (x: number, z: number, s: number) => {
        const stem = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.22, s * 0.28, s, 8), poleMat)
        stem.position.set(x, s / 2, z)
        const cap = new THREE.Mesh(new THREE.SphereGeometry(s * 0.55, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), mushMat)
        cap.position.set(x, s, z)
        cap.castShadow = true
        scene.add(stem, cap)
      }
      mushroom(7, -18, 1.6); mushroom(8.4, -18.6, 1.0); mushroom(-7, 18, 1.6); mushroom(-8.4, 18.6, 1.0)
      mushroom(18, -20, 1.3); mushroom(-18, 20, 1.3)

      // 両軍ベース上の旗(陣営の旗布)
      for (const team of ['blue', 'red'] as Team[]) {
        const bp = world.basePos[team]
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 5.5, 8), poleMat)
        pole.position.set(bp.x, 2.75, bp.z)
        const flag = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.5), flagMat)
        flag.position.set(bp.x + 1.25, 4.6, bp.z)
        scene.add(pole, flag)
        updates.push((_dt, t) => { flag.rotation.y = Math.sin(t * 1.5 + (team === 'red' ? 1 : 0)) * 0.25 })
      }
    }

    // --- フェアリィ3Dプロップ(Tripo生成。手続きプロップを格上げ。未ロード時は遅延配置) ---
    {
      const placeProp = (
        key: string, x: number, z: number, sc: number, ry: number,
        opt: { collide?: number; light?: number } = {},
      ) => {
        let done = false
        const tryPlace = () => {
          if (done) return
          const g = getScenery(key)
          if (!g) return
          done = true
          g.position.set(x, -0.05, z)
          g.scale.multiplyScalar(sc)
          g.rotation.y = ry
          g.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true } })
          scene.add(g)
          if (opt.collide) { world.addCollider(aabb(x, z, opt.collide, opt.collide, opt.collide)); world.obstacleMeshes.push(g as unknown as THREE.Mesh) }
          if (opt.light) { const lt = new THREE.PointLight(opt.light, 7, 14, 2); lt.position.set(x, 3.0, z); scene.add(lt) }
        }
        tryPlace()
        if (!done) updates.push(() => tryPlace())
      }
      placeProp('prop_altar', 0, 19, 1.0, 0)
      placeProp('prop_fountain', 26, 10, 1.0, 0.4, { collide: 2.2 })
      placeProp('prop_fountain', -26, -10, 1.0, -0.4, { collide: 2.2 })
      placeProp('prop_lamp', 14, -14, 1.0, 0, { light: 0xffcf86 })
      placeProp('prop_lamp', -14, 14, 1.0, 0, { light: 0xffcf86 })
      placeProp('prop_mushroom', -20, -7, 1.1, 0.6)
      placeProp('prop_mushroom', 20, 7, 1.0, -0.6)
      placeProp('prop_chest', 10, 18, 1.0, 0.5, { collide: 1.1 })
      placeProp('prop_chest', -10, -18, 1.0, 2.0, { collide: 1.1 })
      placeProp('prop_flowercart', 23, 21, 1.0, 2.4)
      placeProp('prop_flowercart', -23, -21, 1.0, 0.6)
    }

    // コア出現スポット(地上+高所デッキで縦の駆け引き)
    world.coreSpots = [
      new THREE.Vector3(0, DECK, 0), new THREE.Vector3(16, 1.6, 2), new THREE.Vector3(-16, 1.6, 2),
      new THREE.Vector3(0, 0, 22), new THREE.Vector3(0, 0, -22),
      new THREE.Vector3(22, 0, -8), new THREE.Vector3(-22, 0, 8),
      new THREE.Vector3(24, 2.4, 24), new THREE.Vector3(-24, 2.4, -24),
    ]
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
      color: crystal ? 0xbfeaff : dusk ? 0xffa0c8 : 0xaee8ff,
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

  // --- 遠景: 広大な世界を示す大型オブジェクト群(空気遠近でフォグに溶ける) ---
  const landMat = new THREE.MeshStandardMaterial({ color: crystal ? 0x9fb8d4 : dusk ? 0x6a5a7e : 0x8aa6c4, roughness: 0.96 })
  const foliMat = new THREE.MeshStandardMaterial({ color: crystal ? 0xaadbe6 : dusk ? 0x4f7060 : 0x74bd92, roughness: 0.95 })
  const floaters: { g: THREE.Group; phase: number; amp: number }[] = []

  // 大型浮遊島のリング(空に世界が続く印象。様々な高さ・大きさ)
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + 0.3
    const r = 155 + (i % 4) * 72 + ((i * 23) % 55)
    const s = 14 + ((i * 11) % 28)
    const g = new THREE.Group()
    const base = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.9, s * 0.18, s * 0.8, 7), landMat)
    const top = new THREE.Mesh(new THREE.CylinderGeometry(s, s * 0.92, s * 0.28, 7), foliMat)
    top.position.y = s * 0.5
    const tip = new THREE.Mesh(new THREE.ConeGeometry(s * 0.34, s * 0.9, 6), foliMat)
    tip.position.y = s * 1.0
    g.add(base, top, tip)
    g.position.set(Math.cos(a) * r, 8 + ((i * 17) % 78) - 34, Math.sin(a) * r)
    g.rotation.y = a * 2
    scene.add(g)
    floaters.push({ g, phase: i * 1.5, amp: 0.8 + (i % 3) * 0.6 })
  }

  // 巨大樹(プレイ外周。Tripo製の3D大樹で森の縁を表現。未ロード時は遅延配置)
  for (let i = 0; i < 11; i++) {
    const a = (i / 11) * Math.PI * 2 + 0.9
    const r = 70 + (i % 3) * 26 + ((i * 13) % 18)
    const x = Math.cos(a) * r
    const z = Math.sin(a) * r
    const sc = 0.85 + ((i * 7) % 10) / 10
    const key = i % 2 ? 'prop_tree2' : 'prop_tree'
    let done = false
    const tryTree = () => {
      if (done) return
      const g = getScenery(key)
      if (!g) return
      done = true
      g.position.set(x, -0.1, z)
      g.scale.multiplyScalar(sc)
      g.rotation.y = a * 1.3
      g.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true } })
      scene.add(g)
    }
    tryTree()
    if (!done) updates.push(() => tryTree())
  }

  // 遠方の山/丘の影(地平を埋め、世界の果てを霞ませる)
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2 + 0.15
    const r = 370 + ((i * 29) % 170)
    const s = 64 + ((i * 37) % 96)
    const hill = new THREE.Mesh(new THREE.ConeGeometry(s, s * 0.75, 6), landMat)
    hill.position.set(Math.cos(a) * r, -10, Math.sin(a) * r)
    hill.rotation.y = i
    scene.add(hill)
  }

  updates.push((_dt, t) => {
    for (const f of floaters) f.g.position.y += Math.sin(t * 0.3 + f.phase) * 0.004 * f.amp
  })

  // --- フェアリィ装飾構造物(プレイ範囲外のランドマーク) ---
  // 28MB→最適化済GLB。配置時に未ロードなら、ロード完了まで毎フレーム再試行する。
  {
    const edge = half + 16
    // [key, x, z, scale, faceCenter]
    const placements: [string, number, number, number][] = [
      ['struct_tower', edge, edge, 1.0],
      ['struct_tower', -edge, -edge, 1.0],
      ['struct_house', -edge, edge * 0.55, 1.1],
      ['struct_house', edge, -edge * 0.55, 1.1],
      ['struct_arch', 0, -edge, 1.2],
      ['struct_arch', 0, edge, 1.2],
    ]
    for (const [key, x, z, sc] of placements) {
      let placed = false
      const tryPlace = () => {
        if (placed) return
        const g = getScenery(key)
        if (!g) return
        placed = true
        g.position.set(x, -0.1, z)
        g.scale.multiplyScalar(sc)
        g.rotation.y = Math.atan2(-x, -z) // 中央を向く
        g.traverse((o) => {
          const m = o as THREE.Mesh
          if (m.isMesh) m.castShadow = m.receiveShadow = true
        })
        scene.add(g)
      }
      tryPlace()
      if (!placed) updates.push(() => tryPlace())
    }
  }

  return {
    sunDir,
    dusk,
    crystal,
    update(dt: number, t: number) {
      for (const u of updates) u(dt, t)
    },
  }
}
