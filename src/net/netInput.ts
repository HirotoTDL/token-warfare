// 1フレーム分のプレイヤー操作(オンライン対戦でホストへ送る単位)。
// ホストはこれを RemoteCommander に渡してユニットを駆動する。設計は docs/NETCODE_DESIGN.md。
// 帯域目安: 連番+移動2軸+yaw/pitch+フラグで実用上 ~7バイト/フレーム(@50Hzで~350B/s)。
import type { Input } from '../input'

export interface NetInput {
  seq: number // 連番(順序保証・欠落検出)
  mx: number // 移動 右(+)/左(-) [-1..1]
  mz: number // 移動 前(+)/後(-) [-1..1]  ※W=+1,S=-1
  yaw: number // 視点ヨー(rad)
  pitch: number // 視点ピッチ(rad, 上+)
  fire: boolean // 発砲(押下中=オートマ武器のホールド判定用)
  firePressed?: boolean // 発砲の立ち上がりエッジ(このフレームでクリック)。セミオート武器(auto:false)の単発判定用
  charge: boolean // エネルギーチャージ(Rホールド)
  jump: boolean // ジャンプ(押下中)
  zoom: boolean // ズーム(右クリック)
  sprint?: boolean // スプリント(Shift+前進)。これが無いとhostが移動から走り/歩きを幾何推定し、前進時にclient予測と定常乖離→自機が周期スナップ
  /** 立ち上がり単発トリガ(このフレームだけ): 'skill' | 'dash' | `deploy:<token>` 等。Phase1で拡充 */
  triggers?: string[]
}

/** ローカル入力＋視点角から送信用 NetInput を作る(視点はマウス移動を送信側で積分済みのyaw/pitchを渡す) */
export function sampleNetInput(input: Input, yaw: number, pitch: number, seq: number): NetInput {
  let mx = 0
  let mz = 0
  if (input.down('forward')) mz += 1
  if (input.down('back')) mz -= 1
  if (input.down('right')) mx += 1
  if (input.down('left')) mx -= 1
  const triggers: string[] = []
  if (input.was('skill')) triggers.push('skill')
  return {
    seq,
    mx,
    mz,
    yaw,
    pitch,
    fire: input.mouseDown,
    firePressed: input.mousePressed || undefined, // クリックの立ち上がり(セミオート用)。falseは送らず帯域節約
    charge: input.down('charge'),
    jump: input.down('jump'),
    zoom: input.mouseRight,
    sprint: input.down('sprint') || undefined, // falseは送らず帯域節約。host側でplayer.tsと同一のsprint判定に使う
    triggers: triggers.length ? triggers : undefined,
  }
}

/** 無入力フレーム(接続直後/欠落時のフォールバック。最後のyaw/pitchは呼び出し側が保持) */
export function idleNetInput(seq: number, yaw = 0, pitch = 0): NetInput {
  return { seq, mx: 0, mz: 0, yaw, pitch, fire: false, charge: false, jump: false, zoom: false }
}
