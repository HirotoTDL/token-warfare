import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
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
  scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true
      o.receiveShadow = true
    }
  })
  const root = new THREE.Group()
  root.add(scene)
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
  const clone = src.clone(true)
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
  return clone
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
