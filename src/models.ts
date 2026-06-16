import * as THREE from 'three'
import { TEAM_COLOR, characterByKey, type CharacterDef, type Team } from './types'

/** プリミティブ合成でモデルを組み立てるビルダー */
class B {
  g = new THREE.Group()
  mats: THREE.MeshStandardMaterial[] = []

  mat(color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.2, ...opts })
    this.mats.push(m)
    return m
  }

  private put(mesh: THREE.Mesh, x: number, y: number, z: number, ry = 0, rx = 0, rz = 0) {
    mesh.position.set(x, y, z)
    mesh.rotation.set(rx, ry, rz)
    mesh.castShadow = true
    mesh.receiveShadow = true
    this.g.add(mesh)
    return mesh
  }

  box(w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, ry = 0, rx = 0, rz = 0) {
    return this.put(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m), x, y, z, ry, rx, rz)
  }

  cyl(rt: number, rb: number, h: number, m: THREE.Material, x: number, y: number, z: number, rx = 0, rz = 0, seg = 14) {
    return this.put(new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m), x, y, z, 0, rx, rz)
  }

  sph(r: number, m: THREE.Material, x: number, y: number, z: number, seg = 14, sy = 1, sx = 1, sz = 1) {
    const mesh = this.put(new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.max(8, seg - 2)), m), x, y, z)
    mesh.scale.set(sx, sy, sz)
    return mesh
  }

  cone(r: number, h: number, m: THREE.Material, x: number, y: number, z: number, rx = 0, rz = 0, seg = 10) {
    return this.put(new THREE.Mesh(new THREE.ConeGeometry(r, h, seg), m), x, y, z, 0, rx, rz)
  }

  torus(r: number, t: number, m: THREE.Material, x: number, y: number, z: number, rx = 0, rz = 0) {
    return this.put(new THREE.Mesh(new THREE.TorusGeometry(r, t, 8, 24), m), x, y, z, 0, rx, rz)
  }

  oct(r: number, m: THREE.Material, x: number, y: number, z: number) {
    return this.put(new THREE.Mesh(new THREE.OctahedronGeometry(r), m), x, y, z)
  }

  marker(x: number, y: number, z: number) {
    const o = new THREE.Object3D()
    o.position.set(x, y, z)
    this.g.add(o)
    return o
  }

  done() {
    this.g.userData.mats = this.mats
    return this.g
  }
}

function glow(b: B, color: number, intensity = 1) {
  return b.mat(color, { emissive: color, emissiveIntensity: intensity, roughness: 0.4 })
}

/**
 * 歩行アニメ用の脚/腕(付け根ピボット)。
 * pivotを回転させると付け根から振れる。userData.animに登録して使う。
 */
function limb(
  b: B, mat: THREE.Material,
  px: number, py: number, pz: number,
  len: number, r: number,
  footMat?: THREE.Material, footR = 0,
): THREE.Group {
  const pivot = new THREE.Group()
  pivot.position.set(px, py, pz)
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.15, len, 10), mat)
  m.position.y = -len / 2
  m.castShadow = true
  m.receiveShadow = true
  pivot.add(m)
  if (footMat && footR > 0) {
    const foot = new THREE.Mesh(new THREE.SphereGeometry(footR, 10, 8), footMat)
    foot.scale.set(1, 0.7, 1.25)
    foot.position.set(0, -len - footR * 0.3, 0.03)
    foot.castShadow = true
    pivot.add(foot)
  }
  b.g.add(pivot)
  return pivot
}

/**
 * シェイプリンガー(将)— 親しみのある人型モンスター。
 * variantで角・耳などの個性、teamでトリム色が変わる。
 */
export function buildMonsterCommander(char: CharacterDef, team: Team): THREE.Group {
  const b = new B()
  const main = b.mat(char.color, { roughness: 0.6 })
  const sub = b.mat(char.subColor, { roughness: 0.65 })
  const dark = b.mat(0x2e2e3e, { roughness: 0.5 })
  const teamGlow = glow(b, TEAM_COLOR[team], 1.0)
  const white = b.mat(0xffffff, { roughness: 0.3 })

  // 体(ぷっくり)・おなかパッチ
  b.sph(0.34, main, 0, 0.78, 0, 14, 1.18, 0.95, 0.85)
  b.sph(0.25, sub, 0, 0.72, 0.13, 12, 1.05, 0.85, 0.6)
  // 脚(腰ピボットで歩行アニメ対応)
  const legL = limb(b, main, -0.14, 0.46, 0, 0.36, 0.09, dark, 0.12)
  const legR = limb(b, main, 0.14, 0.46, 0, 0.36, 0.09, dark, 0.12)
  // 腕(左腕は振り対応、右腕は銃を構えるため固定)
  const armL = limb(b, main, -0.38, 0.98, 0, 0.32, 0.07, sub, 0.09)
  armL.rotation.z = 0.25
  b.cyl(0.07, 0.08, 0.34, main, 0.36, 0.82, 0.08, -0.5, 0)
  b.sph(0.09, sub, 0.42, 0.8, 0.26, 10)
  // チームスカーフ(首元の発光リング)
  b.torus(0.21, 0.05, teamGlow, 0, 1.05, 0, Math.PI / 2)
  // 頭(大きめ)
  b.sph(0.36, main, 0, 1.4, 0, 16, 0.95, 1, 0.95)
  // 顔パッチ
  b.sph(0.27, sub, 0, 1.36, 0.14, 14, 0.78, 0.85, 0.55)

  const v = char.variant
  if (v === 2) {
    // バイザー(ジン)
    b.box(0.4, 0.1, 0.06, teamGlow, 0, 1.45, 0.31)
  } else {
    // 目(チーム色に光る)
    b.sph(0.075, white, -0.12, 1.45, 0.28, 10)
    b.sph(0.075, white, 0.12, 1.45, 0.28, 10)
    b.sph(0.038, teamGlow, -0.12, 1.45, 0.345, 8)
    b.sph(0.038, teamGlow, 0.12, 1.45, 0.345, 8)
  }

  // バリアントパーツ(角・耳・アンテナ等)
  switch (v) {
    case 0: // レンジ: 2本角+ヘッドバンド
      b.cone(0.07, 0.22, sub, -0.16, 1.74, 0, 0, 0.3)
      b.cone(0.07, 0.22, sub, 0.16, 1.74, 0, 0, -0.3)
      b.box(0.5, 0.07, 0.38, dark, 0, 1.6, 0)
      break
    case 1: // ガロ: クマ耳+ほっぺ
      b.sph(0.12, main, -0.24, 1.7, 0, 10)
      b.sph(0.12, main, 0.24, 1.7, 0, 10)
      b.sph(0.05, sub, -0.26, 1.32, 0.24, 8)
      b.sph(0.05, sub, 0.26, 1.32, 0.24, 8)
      break
    case 2: // ジン: アンテナ
      b.cyl(0.015, 0.015, 0.3, dark, 0.1, 1.85, 0)
      b.sph(0.05, teamGlow, 0.1, 2.02, 0, 8)
      break
    case 3: // ドク: ゴーグル(額)+ネジ角
      b.torus(0.09, 0.025, dark, -0.11, 1.62, 0.22, 0.5)
      b.torus(0.09, 0.025, dark, 0.11, 1.62, 0.22, 0.5)
      b.cyl(0.04, 0.06, 0.16, sub, -0.22, 1.75, -0.05)
      break
    case 4: // ミミ: 大きなうさ耳
      b.box(0.1, 0.42, 0.06, main, -0.15, 1.92, 0, 0, 0, 0.15)
      b.box(0.1, 0.42, 0.06, main, 0.15, 1.92, 0, 0, 0, -0.15)
      b.box(0.05, 0.3, 0.04, sub, -0.15, 1.9, 0.03, 0, 0, 0.15)
      b.box(0.05, 0.3, 0.04, sub, 0.15, 1.9, 0.03, 0, 0, -0.15)
      break
    case 5: // ナナセ: ヘッドホン+1本角
      b.box(0.52, 0.05, 0.05, dark, 0, 1.72, 0)
      b.cyl(0.1, 0.1, 0.08, dark, -0.3, 1.45, 0, 0, Math.PI / 2)
      b.cyl(0.1, 0.1, 0.08, dark, 0.3, 1.45, 0, 0, Math.PI / 2)
      b.cone(0.07, 0.24, sub, 0, 1.84, 0)
      break
    case 6: // リコ: キツネ耳+大きめ尻尾
      b.cone(0.11, 0.26, main, -0.18, 1.78, 0, 0, 0.25)
      b.cone(0.11, 0.26, main, 0.18, 1.78, 0, 0, -0.25)
      b.sph(0.13, sub, 0, 0.7, -0.34, 10, 1, 0.8, 1.4)
      break
    case 7: // ユメ: 天使の輪+星
      b.torus(0.16, 0.025, glow(b, 0xffe066, 1.2), 0, 1.95, 0, Math.PI / 2)
      b.oct(0.06, glow(b, 0xffe066, 1.2), 0.26, 1.62, 0.12)
      break
  }
  // 尻尾(リコ以外は小さめ)
  if (v !== 6) b.cone(0.06, 0.18, main, 0, 0.62, -0.32, -1.9)

  // ポップブラスター(右手)
  b.box(0.09, 0.12, 0.3, dark, 0.42, 0.82, 0.36)
  b.cyl(0.035, 0.035, 0.18, b.mat(char.subColor), 0.42, 0.82, 0.56, Math.PI / 2)
  b.sph(0.045, teamGlow, 0.42, 0.82, 0.66, 8)
  const muzzle = b.marker(0.42, 0.82, 0.7)

  const g = b.done()
  g.userData.muzzle = muzzle
  g.userData.anim = { legs: [legL, legR], arms: [armL] }
  return g
}

/** ガンナー(歩兵トークン)約1.3m — 小型分裂体 */
export function buildGunner(team: Team): THREE.Group {
  const b = new B()
  const body = b.mat(0xbfc6d2, { roughness: 0.5 })
  const dark = b.mat(0x39414e)
  const accent = glow(b, TEAM_COLOR[team], 0.9)
  const legL = limb(b, body, -0.12, 0.4, 0, 0.36, 0.07)
  const legR = limb(b, body, 0.12, 0.4, 0, 0.36, 0.07)
  b.sph(0.24, body, 0, 0.66, 0, 12, 1.1, 0.95, 0.8)
  b.box(0.3, 0.1, 0.06, accent, 0, 0.7, 0.18)
  b.sph(0.18, body, 0, 1.05, 0, 12)
  b.sph(0.05, accent, -0.07, 1.08, 0.15, 8)
  b.sph(0.05, accent, 0.07, 1.08, 0.15, 8)
  b.box(0.07, 0.1, 0.5, dark, 0.24, 0.72, 0.16)
  const g = b.done()
  g.userData.muzzle = b.marker(0.24, 0.72, 0.45)
  g.userData.anim = { legs: [legL, legR], arms: [] }
  return g
}

/** セントリー(固定砲台トークン)— 旋回ヘッド付き */
export function buildSentry(team: Team): THREE.Group {
  const b = new B()
  const body = b.mat(0xb2bac6, { roughness: 0.45, metalness: 0.3 })
  const dark = b.mat(0x39414e)
  b.cyl(0.5, 0.6, 0.26, body, 0, 0.13, 0, 0, 0, 16)
  b.cyl(0.16, 0.2, 0.6, dark, 0, 0.55, 0)
  const head = new THREE.Group()
  head.position.set(0, 0.95, 0)
  const hb = new B()
  const hBody = hb.mat(0xc6cdd8, { roughness: 0.45 })
  const hDark = hb.mat(0x39414e)
  const hAccent = glow(hb, TEAM_COLOR[team], 0.9)
  hb.box(0.5, 0.3, 0.6, hBody, 0, 0, -0.05)
  hb.cyl(0.045, 0.045, 0.55, hDark, -0.1, 0, 0.4, Math.PI / 2)
  hb.cyl(0.045, 0.045, 0.55, hDark, 0.1, 0, 0.4, Math.PI / 2)
  hb.box(0.16, 0.1, 0.1, hAccent, 0, 0.12, 0.2)
  head.add(hb.done())
  b.g.add(head)
  b.mats.push(...hb.mats)
  const g = b.done()
  g.userData.head = head
  return g
}

/** ヒールドローン(飛行回復トークン) */
export function buildHealDrone(team: Team): THREE.Group {
  const b = new B()
  const body = b.mat(0xdde2ea, { roughness: 0.4 })
  const heal = glow(b, 0x4dffa0, 0.9)
  const accent = glow(b, TEAM_COLOR[team], 0.9)
  b.sph(0.28, body, 0, 0, 0, 14)
  b.torus(0.42, 0.05, accent, 0, 0, 0, Math.PI / 2)
  b.box(0.26, 0.07, 0.07, heal, 0, 0, 0.27)
  b.box(0.07, 0.26, 0.07, heal, 0, 0, 0.27)
  return b.done()
}

/** ストライカー(突撃自爆トークン) */
export function buildStriker(team: Team): THREE.Group {
  const b = new B()
  const dark = b.mat(0x444c58, { roughness: 0.45 })
  const accent = glow(b, TEAM_COLOR[team], 0.9)
  const warn = glow(b, 0xffaa33, 0.8)
  b.box(0.5, 0.26, 0.8, dark, 0, 0.26, 0)
  b.cone(0.2, 0.45, accent, 0, 0.26, 0.58, Math.PI / 2, 0, 6)
  b.box(0.56, 0.06, 0.5, accent, 0, 0.42, -0.1)
  b.sph(0.09, warn, 0, 0.46, 0.12, 8)
  b.box(0.14, 0.1, 0.3, dark, -0.3, 0.18, -0.2)
  b.box(0.14, 0.1, 0.3, dark, 0.3, 0.18, -0.2)
  return b.done()
}

/** スパイダーマイン(徘徊地雷トークン) */
export function buildSpiderMine(team: Team): THREE.Group {
  const b = new B()
  const dark = b.mat(0x39414e, { roughness: 0.5 })
  const lampMat = glow(b, TEAM_COLOR[team], 1.2)
  b.sph(0.2, dark, 0, 0.26, 0, 12)
  b.sph(0.07, lampMat, 0, 0.42, 0, 8)
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4
    b.box(0.04, 0.04, 0.34, dark, Math.cos(a) * 0.22, 0.16, Math.sin(a) * 0.22, a + Math.PI / 2, 0.5)
  }
  const g = b.done()
  g.userData.lamp = lampMat
  return g
}

/** ウォールポッド(遮蔽壁トークン)— 壁本体 */
export function buildWall(team: Team, alongX: boolean): THREE.Group {
  const b = new B()
  const body = b.mat(0x9aa3b2, { roughness: 0.6, metalness: 0.3 })
  const accent = glow(b, TEAM_COLOR[team], 0.8)
  const w = alongX ? 3 : 0.42
  const d = alongX ? 0.42 : 3
  b.box(w, 2.2, d, body, 0, 1.1, 0)
  b.box(alongX ? 3.1 : 0.5, 0.12, alongX ? 0.5 : 3.1, accent, 0, 2.22, 0)
  b.box(alongX ? 3.1 : 0.5, 0.12, alongX ? 0.5 : 3.1, accent, 0, 0.1, 0)
  return b.done()
}

/** ブースターパイロン(味方強化トークン) */
export function buildBooster(team: Team): THREE.Group {
  const b = new B()
  const dark = b.mat(0x39414e)
  const accent = glow(b, TEAM_COLOR[team], 1.1)
  b.cyl(0.34, 0.42, 0.24, dark, 0, 0.12, 0, 0, 0, 6)
  b.cyl(0.06, 0.09, 0.5, dark, 0, 0.45, 0)
  const crystal = b.oct(0.22, accent, 0, 0.95, 0)
  const g = b.done()
  g.userData.crystal = crystal
  return g
}

/** チェイサー(犬型追跡トークン) */
export function buildChaser(team: Team): THREE.Group {
  const b = new B()
  const body = b.mat(0xcdd3dd, { roughness: 0.5 })
  const dark = b.mat(0x39414e)
  const accent = glow(b, TEAM_COLOR[team], 1.0)
  b.box(0.26, 0.24, 0.52, body, 0, 0.34, 0)
  b.sph(0.16, body, 0, 0.48, 0.32, 12)
  b.sph(0.045, accent, -0.06, 0.52, 0.45, 8)
  b.sph(0.045, accent, 0.06, 0.52, 0.45, 8)
  b.cone(0.05, 0.14, dark, -0.09, 0.62, 0.28)
  b.cone(0.05, 0.14, dark, 0.09, 0.62, 0.28)
  const legs: THREE.Group[] = []
  for (const [lx, lz] of [[-0.1, 0.18], [0.1, 0.18], [-0.1, -0.18], [0.1, -0.18]] as const) {
    legs.push(limb(b, dark, lx, 0.24, lz, 0.22, 0.04))
  }
  b.cone(0.04, 0.2, accent, 0, 0.42, -0.34, -2.2)
  const g = b.done()
  g.userData.anim = { legs, arms: [] }
  return g
}

/** ボムスリンガー(曲射砲台トークン) */
export function buildBomber(team: Team): THREE.Group {
  const b = new B()
  const body = b.mat(0xb2bac6, { roughness: 0.5 })
  const dark = b.mat(0x39414e)
  const accent = glow(b, TEAM_COLOR[team], 0.9)
  b.cyl(0.42, 0.5, 0.3, dark, 0, 0.15, 0, 0, 0, 14)
  b.sph(0.3, body, 0, 0.44, 0, 14, 0.8)
  const barrel = b.cyl(0.13, 0.16, 0.6, dark, 0, 0.75, 0.12, 0.6)
  b.torus(0.14, 0.03, accent, 0, 0.88, 0.28, 0.6)
  const g = b.done()
  g.userData.barrel = barrel
  return g
}

/** ジャマーポッド(妨害トークン) */
export function buildJammer(team: Team): THREE.Group {
  const b = new B()
  const dark = b.mat(0x39414e)
  const accent = glow(b, TEAM_COLOR[team], 1.0)
  const noise = glow(b, 0xff66ff, 0.9)
  b.cyl(0.3, 0.38, 0.2, dark, 0, 0.1, 0, 0, 0, 8)
  b.sph(0.24, accent, 0, 0.5, 0, 12)
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2
    b.cyl(0.012, 0.012, 0.5, dark, Math.cos(a) * 0.16, 0.85, Math.sin(a) * 0.16, 0, (i - 1) * 0.3)
    b.sph(0.04, noise, Math.cos(a) * 0.2, 1.1, Math.sin(a) * 0.2, 8)
  }
  return b.done()
}

/** スナイパードローン(浮遊狙撃トークン) */
export function buildSniperDrone(team: Team): THREE.Group {
  const b = new B()
  const body = b.mat(0xdde2ea, { roughness: 0.4 })
  const dark = b.mat(0x39414e)
  const accent = glow(b, TEAM_COLOR[team], 1.0)
  b.sph(0.22, body, 0, 0, 0, 12, 0.8, 1, 1.2)
  b.box(0.7, 0.04, 0.18, accent, 0, 0.06, -0.05)
  b.cyl(0.03, 0.03, 0.5, dark, 0, 0, 0.3, Math.PI / 2)
  b.sph(0.06, glow(b, 0xff4060, 1.2), 0, 0, 0.56, 8)
  const g = b.done()
  g.userData.muzzle = b.marker(0, 0, 0.6)
  return g
}

/** デコイ(将の分身。見た目はモンスター将と同じ) */
export function buildDecoy(char: CharacterDef, team: Team): THREE.Group {
  return buildMonsterCommander(char, team)
}

/** エナジーコア(フィールド回収アイテム) */
export function buildCore(small: boolean): THREE.Group {
  const b = new B()
  const color = small ? 0x7dffd0 : 0xffd23e
  const core = glow(b, color, 1.3)
  const crystal = b.oct(small ? 0.22 : 0.36, core, 0, small ? 0.5 : 0.7, 0)
  const ringMat = glow(b, color, 0.7)
  b.torus(small ? 0.3 : 0.48, 0.03, ringMat, 0, 0.12, 0, Math.PI / 2)
  const g = b.done()
  g.userData.crystal = crystal
  return g
}

/** 一人称武器ビューモデル(ポップブラスター。-Z が前方) */
export function buildViewmodel(char: CharacterDef): THREE.Group {
  const b = new B()
  const main = b.mat(char.color, { roughness: 0.45 })
  const sub = b.mat(char.subColor, { roughness: 0.5 })
  const dark = b.mat(0x2e2e3e, { roughness: 0.4, metalness: 0.3 })
  const energy = glow(b, char.weapon.boltColor, 1.2)
  let muzzle: THREE.Object3D

  switch (char.key) {
    case 'garo': // ドラム型キャノン
      b.cyl(0.085, 0.085, 0.3, main, 0, 0, -0.12, Math.PI / 2)
      b.cyl(0.05, 0.05, 0.26, dark, 0, 0, -0.4, Math.PI / 2)
      b.torus(0.07, 0.02, energy, 0, 0, -0.3, 0)
      b.box(0.05, 0.14, 0.1, dark, 0, -0.12, 0.05)
      muzzle = b.marker(0, 0, -0.56)
      break
    case 'jin': // ロングレイル
      b.box(0.05, 0.08, 0.42, main, 0, 0, -0.08)
      b.cyl(0.018, 0.022, 0.6, dark, 0, 0.01, -0.56, Math.PI / 2)
      b.box(0.02, 0.05, 0.5, energy, 0, -0.03, -0.5)
      b.cyl(0.035, 0.035, 0.18, sub, 0, 0.07, -0.18, Math.PI / 2)
      b.box(0.05, 0.1, 0.1, dark, 0, -0.1, 0.05)
      muzzle = b.marker(0, 0.01, -0.88)
      break
    case 'nanase': // ポンプランチャー
      b.cyl(0.07, 0.075, 0.42, main, 0, 0, -0.2, Math.PI / 2)
      b.cyl(0.085, 0.085, 0.12, sub, 0, 0, -0.42, Math.PI / 2)
      b.torus(0.085, 0.02, energy, 0, 0, -0.36, 0)
      b.box(0.05, 0.12, 0.1, dark, 0, -0.11, 0.04)
      muzzle = b.marker(0, 0, -0.52)
      break
    case 'mimi': { // ツインポッパー(2連)
      for (const sx of [-0.05, 0.05]) {
        b.box(0.045, 0.07, 0.22, main, sx, 0, -0.1)
        b.cyl(0.018, 0.018, 0.16, sub, sx, 0.005, -0.28, Math.PI / 2)
        b.sph(0.025, energy, sx, 0.005, -0.37, 8)
      }
      b.box(0.13, 0.05, 0.1, dark, 0, -0.06, 0)
      muzzle = b.marker(0, 0, -0.4)
      break
    }
    default: // 標準ブラスター(レンジ/ドク/リコ/ユメ)
      b.box(0.06, 0.09, 0.3, main, 0, 0, -0.1)
      b.cyl(0.022, 0.026, 0.26, dark, 0, 0.005, -0.36, Math.PI / 2)
      b.torus(0.045, 0.015, energy, 0, 0.005, -0.28, 0)
      b.box(0.05, 0.07, 0.12, sub, 0, 0.07, -0.05)
      b.box(0.045, 0.13, 0.07, dark, 0, -0.11, 0.04, 0, 0.2)
      muzzle = b.marker(0, 0.005, -0.5)
      break
  }
  const g = b.done()
  g.traverse((o) => {
    o.castShadow = false
    o.receiveShadow = false
  })
  g.userData.muzzle = muzzle
  return g
}

/** kind→プロシージャル組み立て関数(GLB不在/未ロード時のフォールバック)。 */
const PROC_TOKEN_BUILDERS: Record<string, (team: Team) => THREE.Group> = {
  gunner: buildGunner, sentry: buildSentry, healer: buildHealDrone, striker: buildStriker,
  mine: buildSpiderMine, booster: buildBooster, chaser: buildChaser, bomber: buildBomber,
  jammer: buildJammer, sniperdrone: buildSniperDrone,
}

/**
 * 表示専用のプロシージャル・モデルを組む(実GLBが無い/未ロードのときのフォールバック)。
 * ホストの resolveModel(getModel ?? buildX) の「buildX」側と同一の組み立てなので、クライアントの
 * puppet でもホストとまったく同じ見た目になる(箱で代替しない)。
 * token_sentry / token_wallpod / token_mine はGLBが存在せず常にこの経路を通るため特に重要。
 * @param wallAlongX wallpod の向き(x軸沿いに伸びるか)。snapshot の o から復元する。
 */
export function buildProceduralUnit(kind: string, team: Team, charKey?: string, wallAlongX = true): THREE.Group {
  if (kind === 'commander') return buildMonsterCommander(characterByKey(charKey ?? 'renji'), team)
  if (kind === 'decoy') return buildDecoy(characterByKey(charKey ?? 'renji'), team)
  if (kind === 'wallpod') return buildWall(team, wallAlongX)
  const builder = PROC_TOKEN_BUILDERS[kind]
  if (builder) return builder(team)
  // 未知kind(本来到達しない)の最終手段
  const g = new THREE.Group()
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.8, 0.6), new THREE.MeshStandardMaterial({ color: TEAM_COLOR[team] }))
  box.position.y = 0.4
  g.add(box)
  return g
}
