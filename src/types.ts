import * as THREE from 'three'

export type Team = 'blue' | 'red'

export function enemyOf(t: Team): Team {
  return t === 'blue' ? 'red' : 'blue'
}

export const TEAM_COLOR: Record<Team, number> = { blue: 0x3da8ff, red: 0xff5040 }
export const TEAM_NAME: Record<Team, string> = { blue: '青軍', red: '赤軍' }

export interface Unit {
  id: number
  team: Team
  kind: string
  name: string
  hp: number
  maxHp: number
  alive: boolean
  isCommander: boolean
  stealthed: boolean
  group: THREE.Group
  hitMeshes: THREE.Mesh[]
  radius: number
  height: number
  /** 起動済みか(トークンのみ。起動ディレイ中はfalse=オーラ/効果が無効。将はundefined=常時有効扱い) */
  armed?: boolean
  update(dt: number): void
  takeDamage(amount: number, from: Unit | null): void
}

/** 距離威力カーブの1点 */
export interface FalloffPoint {
  d: number
  mul: number
}

/** 距離→威力倍率(区分線形補間) */
export function falloffMul(points: FalloffPoint[], dist: number): number {
  if (!points.length) return 1
  if (dist <= points[0].d) return points[0].mul
  for (let i = 1; i < points.length; i++) {
    if (dist <= points[i].d) {
      const a = points[i - 1]
      const b = points[i]
      const t = (dist - a.d) / Math.max(0.001, b.d - a.d)
      return a.mul + (b.mul - a.mul) * t
    }
  }
  return points[points.length - 1].mul
}

export interface WeaponDef {
  name: string
  desc: string
  damage: number
  pellets: number
  /** 連射速度(発/s。バースト武器はバースト/s) */
  rate: number
  /** 1射あたりのエネルギー消費(ペレット・バースト込み) */
  energyCost: number
  boltSpeed: number
  falloff: FalloffPoint[]
  spread: number
  zoomFov: number
  recoil: number
  auto: boolean
  /** バースト射撃(1トリガで連続発射する数) */
  burst?: number
  burstInterval?: number
  explosive?: { radius: number }
  /** 弾にかかる重力(山なり弾道) */
  gravity?: number
  boltColor: number
}

export interface SkillDef {
  key: string
  name: string
  desc: string
  cooldown: number
  duration: number
}

export interface CharacterDef {
  key: string
  name: string
  gender: 'm' | 'f'
  title: string
  role: string
  desc: string
  hp: number
  color: number
  subColor: number
  /** モンスターモデルのバリアント(角・耳など) */
  variant: number
  weapon: WeaponDef
  skill: SkillDef
  uniqueToken: string
}

export const CHARACTERS: CharacterDef[] = [
  {
    key: 'renji', name: 'レンジ', gender: 'm', title: 'ビートを刻む先鋒', role: 'バランス/突撃',
    desc: '迷ったらコイツ。中距離の差し合いとストライカーの波状攻撃で前線を押し上げる。〈射程:中／連射:高／確定5発・KT約0.50s〉',
    hp: 115, color: 0xff7a2f, subColor: 0xffd23e, variant: 0,
    weapon: {
      name: 'ビートショット', desc: '中距離ピークの王道ブラスター',
      damage: 23, pellets: 1, rate: 8, energyCost: 3.2, boltSpeed: 130,
      falloff: [{ d: 0, mul: 0.85 }, { d: 10, mul: 1 }, { d: 24, mul: 1 }, { d: 55, mul: 0.6 }],
      spread: 0.02, zoomFov: 48, recoil: 0.01, auto: true, boltColor: 0xffb347,
    },
    skill: { key: 'dash', name: 'ブリッツダッシュ', desc: '前方に高速ダッシュ+2秒間被ダメ-50%', cooldown: 12, duration: 2 },
    uniqueToken: 'striker',
  },
  {
    key: 'garo', name: 'ガロ', gender: 'm', title: '鉄板焼きの壁男', role: 'タンク/制圧',
    desc: '近距離の鬼。ウォールポッドで地形ごと盤面を書き換える、歩く工事現場。〈射程:近／連射:低／確定2発・KT約0.63s／近接は高威力〉',
    hp: 140, color: 0x49c46a, subColor: 0xb6ff5c, variant: 1,
    weapon: {
      name: 'ドラムバースト', desc: '6粒拡散の近距離キャノン',
      damage: 13, pellets: 6, rate: 1.6, energyCost: 12, boltSpeed: 100,
      falloff: [{ d: 0, mul: 1.3 }, { d: 8, mul: 1 }, { d: 18, mul: 0.58 }, { d: 30, mul: 0.25 }],
      spread: 0.07, zoomFov: 55, recoil: 0.035, auto: true, boltColor: 0x8aff7a,
    },
    skill: { key: 'dome', name: 'バリアドーム', desc: '2.5秒間 被ダメージ-60%', cooldown: 16, duration: 2.5 },
    uniqueToken: 'wallpod',
  },
  {
    key: 'jin', name: 'ジン', gender: 'm', title: '蜃気楼のスナイパー', role: '狙撃/隠密',
    desc: '長い射線を一人で支配する。マインと迷彩で「いない場所」から削る。〈射程:遠／連射:最低／確定1〜2発・KT0〜1.2s／遠距離は急所即死級〉',
    hp: 95, color: 0x35c8d8, subColor: 0xc8f4ff, variant: 2,
    weapon: {
      name: 'ロングレイル', desc: '遠距離特化の貫通レール',
      damage: 90, pellets: 1, rate: 0.82, energyCost: 17, boltSpeed: 260,
      falloff: [{ d: 0, mul: 0.45 }, { d: 18, mul: 0.75 }, { d: 40, mul: 1.2 }, { d: 90, mul: 1.2 }],
      spread: 0.002, zoomFov: 20, recoil: 0.035, auto: false, boltColor: 0x7af0ff,
    },
    skill: { key: 'cloak', name: '光学迷彩', desc: '4秒間 索敵から消える(発砲で解除)', cooldown: 18, duration: 4 },
    uniqueToken: 'mine',
  },
  {
    key: 'doku', name: 'ドク', gender: 'm', title: 'ガレージの整備班長', role: 'サポート/工兵',
    desc: '盤面の維持力No.1。パイロンで分裂体を強化し、長期戦に持ち込めば負けない。〈射程:中／連射:最高／確定9発・KT約0.73s〉',
    hp: 110, color: 0xf2c531, subColor: 0x7adfff, variant: 3,
    weapon: {
      name: 'パルスキャリバー', desc: '低燃費の近中距離SMG',
      damage: 13, pellets: 1, rate: 11, energyCost: 2.4, boltSpeed: 110,
      falloff: [{ d: 0, mul: 1.1 }, { d: 8, mul: 1 }, { d: 20, mul: 0.8 }, { d: 45, mul: 0.5 }],
      spread: 0.03, zoomFov: 50, recoil: 0.007, auto: true, boltColor: 0xffe96b,
    },
    skill: { key: 'repair', name: 'リペアパルス', desc: '自分と半径12mの味方トークンをHP30回復', cooldown: 14, duration: 0 },
    uniqueToken: 'booster',
  },
  {
    key: 'mimi', name: 'ミミ', gender: 'f', title: 'ハイテンション・ラッシャー', role: 'スピード/ラッシュ',
    desc: '最速で踏み込み最速で逃げる。チェイサーで敵将の居場所を暴くお祭り娘。〈射程:近中／連射:高／確定6発・KT約0.56s〉',
    hp: 108, color: 0xff4fa3, subColor: 0xffe2f1, variant: 4,
    weapon: {
      name: 'ツインポッパー', desc: '2丁同時発射の近距離ポッパー',
      damage: 10, pellets: 2, rate: 9, energyCost: 2.5, boltSpeed: 110,
      // バランス調整: 突出していた近距離ピークを抑制(密着でも最大火力だったのを是正)
      falloff: [{ d: 0, mul: 1.1 }, { d: 6, mul: 1.1 }, { d: 16, mul: 0.78 }, { d: 35, mul: 0.48 }],
      spread: 0.045, zoomFov: 55, recoil: 0.008, auto: true, boltColor: 0xff8fd0,
    },
    skill: { key: 'overdrive', name: 'オーバードライブ', desc: '2.5秒間 連射+60%・燃費半減', cooldown: 15, duration: 2.5 },
    uniqueToken: 'chaser',
  },
  {
    key: 'nanase', name: 'ナナセ', gender: 'f', title: '重低音の砲撃手', role: '爆発/砲撃',
    desc: '山なりの爆発弾で遮蔽ごと盤面を耕す。近づかれてもビートドロップで吹き飛ばす。〈射程:遠(曲射)／連射:低／確定2発・KT約0.9s＋範囲〉',
    hp: 120, color: 0x9b5cff, subColor: 0xffd23e, variant: 5,
    weapon: {
      name: 'ポンプランチャー', desc: '山なり弾道の爆発ランチャー',
      // 火力強化(2026-06-15): 直撃2発確定。低連射ゆえ単体TTKは長め(0.9s)だが範囲制圧が本領
      damage: 60, pellets: 1, rate: 1.1, energyCost: 15, boltSpeed: 80,
      falloff: [{ d: 0, mul: 0.8 }, { d: 10, mul: 1 }, { d: 30, mul: 1 }, { d: 60, mul: 0.7 }],
      spread: 0.012, zoomFov: 50, recoil: 0.03, auto: false,
      explosive: { radius: 2.6 }, gravity: 9, boltColor: 0xc89bff,
    },
    skill: { key: 'beatdrop', name: 'ビートドロップ', desc: '自分中心の範囲爆発(35dmg/半径6m)+0.5秒スーパーアーマー', cooldown: 16, duration: 0.5 },
    uniqueToken: 'bomber',
  },
  {
    key: 'riko', name: 'リコ', gender: 'f', title: '路地裏のトリックスター', role: 'トリック/攪乱',
    desc: 'デコイとジャマーで敵のAIと人間、両方を騙す。読み合いを制する玄人向け。〈射程:中遠／3点バースト／確定6発(2バースト)・KT約0.50s〉',
    hp: 105, color: 0xff4040, subColor: 0x2e2e3e, variant: 6,
    weapon: {
      name: 'スピットファイア', desc: '3点バーストの精密ブラスター',
      damage: 19, pellets: 1, rate: 2.8, energyCost: 7.5, boltSpeed: 120,
      falloff: [{ d: 0, mul: 0.9 }, { d: 12, mul: 1 }, { d: 28, mul: 0.9 }, { d: 60, mul: 0.55 }],
      spread: 0.012, zoomFov: 45, recoil: 0.012, auto: true,
      burst: 3, burstInterval: 0.07, boltColor: 0xff6a5a,
    },
    skill: { key: 'decoy', name: 'フェイクアウト', desc: 'その場にデコイを置き、自分は1.5秒ステルス', cooldown: 15, duration: 1.5 },
    uniqueToken: 'jammer',
  },
  {
    key: 'yume', name: 'ユメ', gender: 'f', title: '星を読むハンター', role: 'ハンター/情報',
    desc: 'ソナーで敵将を暴き、スナイパードローンと挟む。情報こそ最強の弾丸。〈射程:遠／連射:中高／確定5発・KT約0.67s〉',
    hp: 100, color: 0x5c7cff, subColor: 0xd8c8ff, variant: 7,
    weapon: {
      name: 'シーカーカービン', desc: '中遠距離で減衰しないカービン',
      // 火力強化(2026-06-15): 確定5発・KT0.67s。長射程ゆえ扱いやすい=やや長めのTTK
      damage: 23, pellets: 1, rate: 6, energyCost: 3.1, boltSpeed: 140,
      falloff: [{ d: 0, mul: 0.7 }, { d: 15, mul: 1 }, { d: 45, mul: 1 }, { d: 80, mul: 0.7 }],
      spread: 0.014, zoomFov: 38, recoil: 0.012, auto: true, boltColor: 0x9bb4ff,
    },
    skill: { key: 'sonar', name: 'ソナーパルス', desc: '4秒間 敵将をミニマップに表示(相手に警告が出る)', cooldown: 20, duration: 4 },
    uniqueToken: 'sniperdrone',
  },
]

export function characterByKey(key: string): CharacterDef {
  return CHARACTERS.find((c) => c.key === key) ?? CHARACTERS[0]
}

/** エネルギー仕様 */
export const ENERGY_MAX = 100
export const ENERGY_CHARGE_RATE = 55   // Rホールド回復/s
export const ENERGY_PASSIVE_RATE = 7   // パッシブ回復/s
export const ENERGY_PASSIVE_DELAY = 1.5
export const CHARGE_SPEED_MUL = 0.35   // チャージ中の移動速度倍率

/** マッチ仕様 */
export const MATCH_TIME = 180
export const OVERTIME_AT = 30
export const RESPAWN_TIME = 4
export const RESPAWN_TIME_OT = 2
export const RESPAWN_INVULN = 2.5

/** TP経済 */
export const TP_REGEN_BASE = 1.2
export const TP_MOMENTUM_MUL = 1.6   // ビハインド側のTP回復倍率
export const CORE_TP = 20
export const CORE_TP_MOMENTUM_BONUS = 5
export const SMALL_CORE_TP = 10
