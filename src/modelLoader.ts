import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { TEAM_COLOR, type Team } from './types'

/**
 * 外部3Dモデル(GLB)の読込パイプライン。
 * public/models/<key>.glb を置くと自動で使われ、無ければ null を返して
 * 呼び出し側がプロシージャルモデルにフォールバックする(BGMと同じ方式)。
 *
 * 規約: キャラ= char_<キャラkey>.glb / トークン= token_<トークンkey>.glb
 * 正規化: 高さを目標値に自動スケール、足元を原点、+Z前方を想定。
 */
const cache = new Map<string, THREE.Group | null>()
const loader = new GLTFLoader()
// 最適化済みGLB(meshopt圧縮)を読むためにデコーダを登録
loader.setMeshoptDecoder(MeshoptDecoder)

function normalize(scene: THREE.Object3D, targetHeight: number): THREE.Group {
  const box = new THREE.Box3().setFromObject(scene)
  const size = box.getSize(new THREE.Vector3())
  const scale = targetHeight / Math.max(0.001, size.y)
  scene.scale.setScalar(scale)
  const box2 = new THREE.Box3().setFromObject(scene)
  const center = box2.getCenter(new THREE.Vector3())
  scene.position.x -= center.x
  scene.position.z -= center.z
  scene.position.y -= box2.min.y
  let skinned = false
  scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true
      o.receiveShadow = true
    }
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) {
      skinned = true
      o.frustumCulled = false // スキン変形でAABBがずれて誤カリングされるのを防ぐ
    }
  })
  const root = new THREE.Group()
  root.add(scene)
  root.userData.skinned = skinned
  return root
}

/** 起動時に呼ぶ。存在しないファイルは静かに無視される */
export function preloadModels(entries: { key: string; height: number }[]) {
  for (const { key, height } of entries) {
    if (cache.has(key)) continue
    loader.load(
      `models/${key}.glb`,
      (gltf) => cache.set(key, normalize(gltf.scene, height)),
      undefined,
      () => cache.set(key, null),
    )
  }
}

/**
 * 読込済みモデルのクローンを返す(未配置/読込中なら null)。
 * マテリアルは複製してダメージフラッシュに対応し、
 * チーム識別用の発光リングを足元に追加する。
 */
export function getModel(key: string, team: Team): THREE.Group | null {
  const src = cache.get(key)
  if (!src) return null
  // スキン付き(リグ済み)は SkeletonUtils.clone でないと骨が壊れる
  const skinned = !!src.userData.skinned
  const clone = (skinned ? (cloneSkinned(src) as THREE.Group) : src.clone(true))
  const mats: THREE.MeshStandardMaterial[] = []
  clone.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map((m) => m.clone())
      for (const m of mesh.material) {
        if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial) mats.push(m as THREE.MeshStandardMaterial)
      }
    } else if (mesh.material) {
      mesh.material = mesh.material.clone()
      if ((mesh.material as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
        mats.push(mesh.material as THREE.MeshStandardMaterial)
      }
    }
  })
  // チームリング(足元の発光輪)
  const tc = TEAM_COLOR[team]
  const ringMat = new THREE.MeshStandardMaterial({ color: tc, emissive: tc, emissiveIntensity: 1.2 })
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.045, 8, 28), ringMat)
  ring.rotation.x = -Math.PI / 2
  ring.position.y = 0.06
  clone.add(ring)
  mats.push(ringMat)
  clone.userData.mats = mats
  // 射撃原点マーカー(外部モデルには銃口情報が無いため標準位置に置く)
  const muzzle = new THREE.Object3D()
  muzzle.position.set(0.3, 1.0, 0.5)
  clone.add(muzzle)
  clone.userData.muzzle = muzzle
  // プロシージャル・モーション用に内部ボディノードを登録(リグ無しGLB向け)。
  // children[0] が正規化済みモデル本体(リング/マズルは別の子)。
  const body = clone.children[0]
  if (body) {
    body.userData.baseY = body.position.y
    clone.userData.body = body
  }
  // リグ済み: ボーンを名前で収集し、レスト回転を保存(関節アニメ用)
  if (skinned) {
    const bones: Record<string, THREE.Bone> = {}
    clone.traverse((o) => {
      if ((o as THREE.Bone).isBone) {
        const bn = o as THREE.Bone
        bones[bn.name] = bn
        bn.userData.rest = bn.rotation.clone()
      }
    })
    clone.userData.bones = bones
  }
  return clone
}

/**
 * リグ無しGLBモデル(妖精キャラ)の体全体プロシージャル・モーション。
 * 妖精らしいふわふわホバー(常時)＋移動時の上下バウンス＋前傾・左右バンク。
 * group.userData.body(正規化済みモデル本体)に適用。脚/腕アニメは別系統。
 */
export function animateGlbBody(group: THREE.Group, animT: number, animAmp: number) {
  const body = group.userData.body as THREE.Object3D | undefined
  if (!body) return
  const baseY = (body.userData.baseY as number) ?? 0
  const hover = Math.sin(animT * 0.5) * 0.05
  const bounce = Math.abs(Math.sin(animT)) * 0.12 * animAmp
  body.position.y = baseY + hover + bounce
  body.rotation.x = 0.16 * animAmp
  body.rotation.z = Math.sin(animT * 0.5) * 0.06 * animAmp
}

/**
 * リグ済み(スケルトン付き)GLBの関節アニメ。Tripo自動リグの標準ボーン名を駆動。
 * animAmp(0..1)=移動強度。歩行サイクル(脚前後振り・膝曲げ・腕逆相)＋常時アイドル(呼吸・首ゆれ)。
 * クリップ無しでもコードで生き生きと動かす方式。
 */
export function animateSkeleton(group: THREE.Group, animT: number, animAmp: number) {
  const bones = group.userData.bones as Record<string, THREE.Bone> | undefined
  if (!bones) return
  const amp = animAmp
  const sw = Math.sin(animT) // 歩行位相
  const sw2 = Math.sin(animT * 0.5) // ゆったり位相(アイドル)
  const breathe = Math.sin(animT * 0.9)
  const set = (name: string, axis: 'x' | 'y' | 'z', delta: number) => {
    const b = bones[name]
    if (!b) return
    const rest = b.userData.rest as THREE.Euler
    b.rotation[axis] = rest[axis] + delta
  }
  // 歩行: 脚を前後に振る(左右逆相)＋後ろ脚で膝を曲げる
  set('L_Thigh', 'x', sw * 0.55 * amp)
  set('R_Thigh', 'x', -sw * 0.55 * amp)
  set('L_Calf', 'x', Math.max(0, -sw) * 0.7 * amp)
  set('R_Calf', 'x', Math.max(0, sw) * 0.7 * amp)
  // 腕は脚と逆相に振る(肘も軽く曲げる)
  set('L_Upperarm', 'x', -sw * 0.4 * amp)
  set('R_Upperarm', 'x', sw * 0.4 * amp)
  set('L_Forearm', 'x', (0.25 + Math.max(0, sw) * 0.25) * amp)
  set('R_Forearm', 'x', (0.25 + Math.max(0, -sw) * 0.25) * amp)
  // 体幹: 前傾少々＋呼吸＋腰のひねり
  set('Spine01', 'x', -0.07 * amp + breathe * 0.018)
  set('Spine02', 'x', breathe * 0.02)
  set('Waist', 'y', sw * 0.07 * amp)
  // 首/頭のゆれ(常時の生命感)
  set('Head', 'z', sw2 * 0.05)
  set('NeckTwist01', 'x', breathe * 0.015)
}

/**
 * 装飾用シーナリーのクローンを返す(未配置/読込中なら null)。
 * チームリングや銃口マーカーは付けない。ステージの背景構造物用。
 */
export function getScenery(key: string): THREE.Group | null {
  const src = cache.get(key)
  if (!src) return null
  return src.clone(true)
}

/** ゲームで使う全モデルキー(プリロード用) */
export const MODEL_MANIFEST: { key: string; height: number }[] = [
  // キャラ8人(将)
  { key: 'char_renji', height: 1.8 }, { key: 'char_garo', height: 1.9 },
  { key: 'char_jin', height: 1.8 }, { key: 'char_doku', height: 1.75 },
  { key: 'char_mimi', height: 1.7 }, { key: 'char_nanase', height: 1.8 },
  { key: 'char_riko', height: 1.7 }, { key: 'char_yume', height: 1.7 },
  // トークン
  { key: 'token_gunner', height: 1.3 }, { key: 'token_sentry', height: 1.25 },
  { key: 'token_healer', height: 0.7 }, { key: 'token_striker', height: 0.6 },
  { key: 'token_mine', height: 0.5 }, { key: 'token_wallpod', height: 2.3 },
  { key: 'token_booster', height: 1.2 }, { key: 'token_chaser', height: 0.7 },
  { key: 'token_bomber', height: 1.0 }, { key: 'token_jammer', height: 1.1 },
  { key: 'token_sniperdrone', height: 0.6 },
  // ステージ装飾構造物(フェアリィ世界観)
  { key: 'struct_tower', height: 14 }, { key: 'struct_house', height: 6 },
  { key: 'struct_arch', height: 8 },
  // FP武器ビューモデル(高さ正規化はビューモデル側で再調整)
  { key: 'weapon_blaster', height: 0.4 },
]
