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

// 軽量モード(低スペックGPU向け): char_* を簡略化版 char_*_lod.glb で読む(頂点処理負荷↓)。
// 既定はoff=フル品質。preloadModels より前に setModelQuality() で設定する。論理キーは同一なので getModel は無改修。
let lowSpec = false
export function setModelQuality(low: boolean) { lowSpec = low }

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

/** 起動時に呼ぶ。存在しないファイルは静かに無視される。軽量モード時は char_* を _lod 優先で読み、無ければ通常版へフォールバック */
export function preloadModels(entries: { key: string; height: number }[]) {
  for (const { key, height } of entries) {
    if (cache.has(key)) continue
    const tryLoad = (url: string, onFail: () => void) =>
      loader.load(url, (gltf) => cache.set(key, normalize(gltf.scene, height)), undefined, onFail)
    if (lowSpec && key.startsWith('char_')) {
      // 簡略化版を試し、無ければ通常版へ(論理キーは同一=getModel無改修・後方互換)
      tryLoad(`models/${key}_lod.glb`, () => tryLoad(`models/${key}.glb`, () => cache.set(key, null)))
    } else {
      tryLoad(`models/${key}.glb`, () => cache.set(key, null))
    }
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
const SKEL_BONES = [
  'L_Thigh', 'R_Thigh', 'L_Calf', 'R_Calf', 'L_Upperarm', 'R_Upperarm',
  'L_Forearm', 'R_Forearm', 'Spine01', 'Spine02', 'Waist', 'Head', 'NeckTwist01',
]
/**
 * リグ済みGLBの関節アニメ。歩行/アイドルに加え、エイムレイヤー(上体ピッチ+微ヨー)を additive 合成する。
 * aimYaw/aimPitch を渡すと、頭・胴を「実際の狙い方向」へ向ける(FPSの視線可読性: 敵がどこを狙っているか読める)。
 * 全レイヤーを rest からの加算で合成するため、各ボーンを毎フレーム rest へ戻してから足し込む(set上書きではなく累積)。
 * aim引数省略時は従来どおり歩行/アイドルのみ(トークン/デコイ/ショーケースは後方互換)。
 */
export function animateSkeleton(
  group: THREE.Group, animT: number, animAmp: number, aimYaw = 0, aimPitch = 0,
) {
  const bones = group.userData.bones as Record<string, THREE.Bone> | undefined
  if (!bones) return
  // 1) 駆動ボーンを rest 姿勢へリセット(以降は加算でレイヤー合成)
  for (const n of SKEL_BONES) {
    const b = bones[n]
    const rest = b?.userData.rest as THREE.Euler | undefined
    if (b && rest) b.rotation.copy(rest)
  }
  const add = (name: string, axis: 'x' | 'y' | 'z', delta: number) => {
    const b = bones[name]
    if (b) b.rotation[axis] += delta
  }
  const amp = animAmp
  const sw = Math.sin(animT) // 歩行位相
  const sw2 = Math.sin(animT * 0.5) // ゆったり位相(アイドル)
  const breathe = Math.sin(animT * 0.9)
  // 歩行: 脚を前後に振る(左右逆相)＋後ろ脚で膝を曲げる
  add('L_Thigh', 'x', sw * 0.55 * amp)
  add('R_Thigh', 'x', -sw * 0.55 * amp)
  add('L_Calf', 'x', Math.max(0, -sw) * 0.7 * amp)
  add('R_Calf', 'x', Math.max(0, sw) * 0.7 * amp)
  // 腕は脚と逆相に振る(肘も軽く曲げる)
  add('L_Upperarm', 'x', -sw * 0.4 * amp)
  add('R_Upperarm', 'x', sw * 0.4 * amp)
  add('L_Forearm', 'x', (0.25 + Math.max(0, sw) * 0.25) * amp)
  add('R_Forearm', 'x', (0.25 + Math.max(0, -sw) * 0.25) * amp)
  // 体幹: 前傾少々(=−x)＋呼吸＋腰のひねり
  add('Spine01', 'x', -0.07 * amp + breathe * 0.018)
  add('Spine02', 'x', breathe * 0.02)
  add('Waist', 'y', sw * 0.07 * amp)
  // 首/頭の常時sway。エイム中は抑制して視線を狙いへ優先させる
  const aimMag = Math.min(1, (Math.abs(aimYaw) + Math.abs(aimPitch)) * 1.5)
  const swayK = 1 - aimMag
  add('Head', 'z', sw2 * 0.05 * swayK)
  add('NeckTwist01', 'x', breathe * 0.015 * swayK)
  // === エイムレイヤー: ヨーは胴体facingの残差を上体で吸収、ピッチは胸+頭で狙いの上下を見せる ===
  // 符号基準: 歩行の「前傾」は Spine01.x = −0.07(=−x が前傾/下向き)。よって +x が上向き。
  // aimPitch>0(標的が上)→ +x で頭/胸が上を向く。首折れ防止に各ボーンを分配+クランプ。
  const cy = THREE.MathUtils.clamp(aimYaw, -1.2, 1.2)
  const cp = THREE.MathUtils.clamp(aimPitch, -0.8, 0.8)
  add('Waist', 'y', cy * 0.25)
  add('Spine01', 'y', cy * 0.25)
  add('Spine02', 'y', cy * 0.2)
  add('NeckTwist01', 'y', cy * 0.15)
  add('Head', 'y', cy * 0.15)
  add('Spine02', 'x', cp * 0.3)
  add('Head', 'x', cp * 0.7)
  // === 過渡レイヤー: 発砲リコイル / 被弾フリンチ(group.userDataにbot/tokenがセット、各自で減衰) ===
  const recoil = (group.userData.recoil as number) || 0
  if (recoil) { add('R_Upperarm', 'x', recoil * 0.5); add('Spine02', 'x', -recoil * 0.08) } // 銃腕の反動キック＋上体わずかに後ろ
  const flinch = (group.userData.flinch as number) || 0
  if (flinch) { add('Spine01', 'x', flinch * 0.22); add('Head', 'x', flinch * 0.12) } // 被弾で上体を一瞬のけ反らせる(+x=後ろ)
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
  // 作り込み構造物(中央監視塔の柱/天蓋・グランドゲート。craftedSwapで再スケール)
  { key: 'struct_pillar', height: 3.4 }, { key: 'struct_canopy', height: 2.8 },
  { key: 'struct_gate', height: 6.0 },
  // 追加ランドマーク/装飾(欄干・浮遊島・かがり火・ルーンオベリスク・自作妖精塔)
  { key: 'struct_railing', height: 1.2 }, { key: 'struct_island', height: 7 },
  { key: 'struct_brazier', height: 2.4 }, { key: 'struct_obelisk', height: 7 },
  { key: 'struct_fairytower', height: 12 },
  // 遠景の自作の丘(フォグ背景)
  { key: 'struct_hill', height: 1 },
  // 地表の散布物(自作の草/花/キノコ/小石。配置時に個別スケール)
  { key: 'scatter_grass', height: 1 }, { key: 'scatter_flowers', height: 1 },
  { key: 'scatter_mushroom', height: 1 }, { key: 'scatter_rock', height: 1 },
  // 中央モチーフ/クリスタル泉(八面体・コーンの置換)
  { key: 'struct_emblem', height: 1.4 }, { key: 'struct_crystal', height: 5.8 },
  // 基地のスポーン壇(円柱パッドの置換)
  { key: 'struct_spawnpad', height: 2.0 },
  // フェアリィ3Dプロップ(手続きプロップの格上げ)
  { key: 'prop_fountain', height: 2.6 }, { key: 'prop_chest', height: 1.0 },
  { key: 'prop_mushroom', height: 2.2 }, { key: 'prop_lamp', height: 3.4 },
  { key: 'prop_flowercart', height: 1.8 }, { key: 'prop_altar', height: 2.8 },
  // フェアリィ大樹(遠景の手続き樹を格上げ)
  { key: 'prop_tree', height: 22 }, { key: 'prop_tree2', height: 20 },
  // 作り込み障害物(四角/円柱の手続き遮蔽を格上げ)。高さはcrate/wall側でスケール
  { key: 'cover_crystal', height: 2.0 }, { key: 'cover_cargo', height: 2.0 },
  { key: 'cover_boulder', height: 1.3 }, { key: 'cover_ruin', height: 2.4 },
  { key: 'cover_hedge', height: 1.6 },
  // FP武器ビューモデル(高さ正規化はビューモデル側で再調整)
  { key: 'weapon_blaster', height: 0.4 },
]
