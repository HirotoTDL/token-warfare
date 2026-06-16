import * as THREE from 'three'
import { World, type Core } from './world'
import { buildArena, MAPS } from './arena'
import { createSky, SKY_DAY, SKY_DUSK } from './sky'
import { Effects, Combat } from './combat'
import { Sfx } from './sfx'
import { Bgm } from './bgm'
import { Input } from './input'
import {
  CHARACTERS, TEAM_NAME, characterByKey,
  MATCH_TIME, OVERTIME_AT, RESPAWN_TIME, RESPAWN_TIME_OT, RESPAWN_INVULN,
  TP_MOMENTUM_MUL, CORE_TP, CORE_TP_MOMENTUM_BONUS, SMALL_CORE_TP,
  type Team, type CharacterDef,
} from './types'
import { PlayerCommander } from './player'
import { BotCommander, botParams } from './bot'
import { HUD } from './hud'
import { TOKENS } from './tokens'
import { buildCore, buildMonsterCommander } from './models'
import { preloadModels, MODEL_MANIFEST, getModel, animateSkeleton, animateGlbBody, setModelQuality } from './modelLoader'
import { buildSettingsPanel, settings, onSettingsChange } from './settings'
import { simulateMatch, simulateMatrix, summarize } from './sim'
import { Objectives, CAPTURE_TO_WIN } from './objectives'
import { DamagePopups } from './dmgpop'
import { PostFX } from './postfx'
import { LoopbackTransport, type NetTransport, type NetRole } from './net/transport'
import { RemoteCommander } from './net/remoteCommander'
import { sampleNetInput, type NetInput } from './net/netInput'
import { WebRtcTransport } from './net/webrtcTransport'
import { encodeSnapshot, PuppetManager, type Snapshot } from './net/snapshot'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

// --- 基盤 ---
const app = document.getElementById('app')!
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
// 描画解像度の上限。高DPI機(4K/Retina)でのオーバードローを抑える(2.0→1.5。見た目はほぼ不変、断片シェーダ負荷は約44%減)。
// 想定端末は10年前のゲーミングPC〜やや上の事務PC。高DPIでもこの上限で十分シャープ。
const BASE_PR = Math.min(window.devicePixelRatio, 1.5)
let qScale = 1 // 動的解像度スケール[0.6..1]: 処理落ち時のみ自動で解像度を下げ、余裕が戻れば上げる
function applyPixelRatio() {
  const pr = BASE_PR * qScale
  renderer.setPixelRatio(pr)
  postfx.setPixelRatio(pr)
}
renderer.setPixelRatio(BASE_PR)
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
// 計測用: autoResetを切りフレーム先頭で手動resetする。これでScene本描画＋PostFX全パスのdraw call合計を
// __tw.perf で読める(既定はrender()毎にresetされ最終合成パスの1だけが残ってしまう)。
renderer.info.autoReset = false
// ACESFilmicは広ガモット圧縮で鮮やかな色が灰がかる(washed-out)=スタイライズドが安っぽく見える主因。
// Khronos PBR Neutralはガモット内で色相を保ったままハイライトを処理し、妖精/クリスタルの原色が映える。
renderer.toneMapping = THREE.NeutralToneMapping
renderer.toneMappingExposure = 1.0 // Neutralは暗部が締まるので0.98→1.0
app.appendChild(renderer.domElement)

const postfx = new PostFX(renderer)
// IBL環境マップ(PBRマテリアルに艶と環境光を与える)
const pmrem = new THREE.PMREMGenerator(renderer)
const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture

const input = new Input(renderer.domElement)
const sfx = new Sfx()
const bgm = new Bgm()
bgm.play('title') // 最初のクリックで解禁されるまで保留される
setModelQuality(settings.lowSpec) // 軽量モードならキャラを簡略化LODで読む(preloadより前に設定)
preloadModels(MODEL_MANIFEST) // public/models/*.glb があれば自動採用

// 設定(感度・音量)
sfx.setVolume(settings.se)
bgm.setVolume(settings.bgm)
onSettingsChange((s) => {
  sfx.setVolume(s.se)
  bgm.setVolume(s.bgm)
})
document.getElementById('settings-title')!.appendChild(buildSettingsPanel())
document.getElementById('settings-pause')!.appendChild(buildSettingsPanel())

const hudRoot = document.getElementById('hud')!
const screens = {
  title: document.getElementById('screen-title')!,
  mode: document.getElementById('screen-mode')!,
  lobby: document.getElementById('screen-lobby')!,
  select: document.getElementById('screen-select')!,
  result: document.getElementById('screen-result')!,
}
const resumeOverlay = document.getElementById('resume-overlay')!

function showScreen(name: keyof typeof screens | null) {
  for (const [k, el] of Object.entries(screens)) {
    el.classList.toggle('hidden', k !== name)
  }
  // キャラ選択中はメニュー背景をショーケースカメラに
  if (view instanceof MenuView) {
    view.setShowcase(name === 'select')
    // 選択画面に入ったら現在の選択キャラを中央ステージへフォーカス(連動が切れて中央に出ない不具合の修正)
    if (name === 'select') view.focusChar(selectedIdx)
  }
}

function disposeScene(scene: THREE.Scene) {
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (mesh.geometry) mesh.geometry.dispose()
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
    const mats = Array.isArray(mat) ? mat : mat ? [mat] : []
    for (const m of mats) {
      const sm = m as THREE.MeshStandardMaterial
      sm.map?.dispose()
      m.dispose()
    }
  })
}

interface View {
  update(dt: number): void
  render(): void
  resize(): void
  dispose(): void
}

// --- メニュー背景(キャラ選択時は8人のショーケース) ---
class MenuView implements View {
  private world = new World()
  private camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1200)
  private sky: { update(t: number): void }
  private arena: { update(dt: number, t: number): void; sunDir: THREE.Vector3 }
  private t = 0
  private showcase = false
  private monsters: THREE.Group[] = []
  private monsterIsGlb: boolean[] = []
  private focusIdx: number | null = null
  private hopV: number[] = []
  private pedestals: THREE.Mesh[] = []
  private fieldFog: THREE.Fog | null = null // 通常時のフォグを退避(ショーケースで濃霧に差し替え)
  private fieldBg: THREE.Color | THREE.Texture | null = null
  // --- キャラ選択ショーケース: フィールドから完全分離した「スタジオ」背景 ---
  private studio: THREE.Group | null = null // グラデ天球＋床グロー(showcaseの専用背景)
  private hiddenForShowcase: THREE.Object3D[] = [] // showcase中に隠したアリーナ要素(復帰用)

  constructor() {
    this.arena = buildArena(this.world)
    this.sky = createSky(this.world.scene, this.arena.sunDir)
    this.world.scene.environment = envTex
    ;(this.world.scene as any).environmentIntensity = 0.28 // IBL強化(0.18→0.28): 艶/金属部の映り込みでチープさ低減
    // ショーケース: 8人が一列に並ぶ(キャラ選択画面の背景)。GLBがあれば使い、無ければプロシージャル
    CHARACTERS.forEach((c, i) => {
      const glb = getModel(`char_${c.key}`, 'blue')
      const m = glb ?? buildMonsterCommander(c, 'blue')
      this.monsterIsGlb.push(!!glb)
      m.position.set((i - 3.5) * 2.4, 0, 8)
      m.rotation.y = 0 // +z(カメラ側)を向く
      this.world.scene.add(m)
      this.monsters.push(m)
      this.hopV.push(0)
      const ped = new THREE.Mesh(
        new THREE.CylinderGeometry(0.85, 0.95, 0.14, 20),
        new THREE.MeshStandardMaterial({ color: 0x39414e, roughness: 0.5, metalness: 0.4 }),
      )
      ped.position.set((i - 3.5) * 2.4, 0.07, 8)
      ped.receiveShadow = true
      this.world.scene.add(ped)
      this.pedestals.push(ped)
    })
  }

  /** ショーケース専用の「スタジオ」背景(グラデ天球＋床グロー)。フィールドと完全に切り離す */
  private buildStudio() {
    const g = new THREE.Group()
    // グラデ天球(妖精パレット: 下=深い藍 → 上=柔らかな菫)。fog:falseで遠方でも沈まない
    const domeMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { cT: { value: new THREE.Color(0x4a3c84) }, cB: { value: new THREE.Color(0x0c0a1a) } },
      vertexShader: 'varying float vy; void main(){ vy = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'varying float vy; uniform vec3 cT; uniform vec3 cB; void main(){ float h = clamp(vy*0.5+0.5,0.0,1.0); gl_FragColor = vec4(mix(cB,cT,pow(h,0.7)),1.0); }',
    })
    const dome = new THREE.Mesh(new THREE.SphereGeometry(90, 24, 16), domeMat)
    g.add(dome)
    // 浮遊キャラ真下のソフトグロー(接地感のある光円)
    const floorMat = new THREE.MeshBasicMaterial({ color: 0x7a6cff, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false })
    const floor = new THREE.Mesh(new THREE.CircleGeometry(3.6, 48), floorMat)
    floor.rotation.x = -Math.PI / 2
    floor.position.set(0, 0.02, 11)
    g.add(floor)
    g.visible = false
    this.world.scene.add(g)
    this.studio = g
  }

  setShowcase(on: boolean) {
    this.showcase = on
    const sc = this.world.scene
    if (on) {
      this.refreshGlbModels()
      if (!this.studio) this.buildStudio()
      if (!this.fieldFog) this.fieldFog = sc.fog as THREE.Fog
      if (this.fieldBg === null) this.fieldBg = sc.background as THREE.Color | THREE.Texture
      // フィールドを完全に切り離す: アリーナ要素(モンスター/ライト/スタジオ背景以外)を全て非表示にし、
      // 専用のスタジオ背景だけを見せる。霧で隠す旧方式と違い、床や構造物が一切映り込まない。
      this.hiddenForShowcase = []
      for (const o of sc.children) {
        if (o === this.studio) continue
        if (this.monsters.includes(o as THREE.Group)) continue
        if ((o as THREE.Light).isLight) continue
        if (o.visible) { this.hiddenForShowcase.push(o); o.visible = false }
      }
      this.studio!.visible = true
      sc.fog = null
      sc.background = new THREE.Color(0x110d20)
    } else {
      this.focusIdx = null
      for (const o of this.hiddenForShowcase) o.visible = true
      this.hiddenForShowcase = []
      if (this.studio) this.studio.visible = false
      if (this.fieldFog) sc.fog = this.fieldFog
      if (this.fieldBg !== null) sc.background = this.fieldBg
      for (const p of this.pedestals) p.visible = true
      for (const m of this.monsters) m.visible = true
    }
  }

  /** 起動時に未ロードだったGLBが揃ったら、プロシージャル表示を差し替える */
  private refreshGlbModels() {
    CHARACTERS.forEach((c, i) => {
      if (this.monsterIsGlb[i]) return
      const glb = getModel(`char_${c.key}`, 'blue')
      if (!glb) return
      const old = this.monsters[i]
      glb.position.copy(old.position)
      glb.position.y = 0
      this.world.scene.remove(old)
      this.world.scene.add(glb)
      this.monsters[i] = glb
      this.monsterIsGlb[i] = true
    })
  }

  focusChar(i: number | null) {
    if (i !== null && this.focusIdx !== i && this.monsters[i]) {
      this.hopV[i] = 3.2 // 注目されたらぴょこんと跳ねる
      sfx.hitmarker()
    }
    this.focusIdx = i
  }

  update(dt: number) {
    this.t += dt
    this.world.time = this.t
    this.sky.update(this.t)
    // ショーケース中はアリーナを更新しない: 遅延配置されるGLB(浮遊島/塔等)が分離済みのスタジオ背景へ
    // ポップインして映り込むのを防ぐ(背景はstudioのみ)。ショーケースを抜ければ配置は再開する。
    if (!this.showcase) this.arena.update(dt, this.t)

    // 起動時に未ロードだったGLBが揃い次第、プロシージャル表示をフェアリィGLBへ差し替える
    // (タイトル/ホーム画面でも反映されるよう、全員GLBになるまで毎フレーム試行)
    if (this.monsterIsGlb.some((b) => !b)) this.refreshGlbModels()

    // キャラのステージ挙動: 選択中は中央ステージへせり出して大きく見せる(盛り上げ演出)
    const stageZ = 11
    this.monsters.forEach((m, i) => {
      const focused = this.showcase && this.focusIdx === i
      // ショーケース(キャラセレクト)は選択キャラのみ表示。タイトル背景では全員表示。
      m.visible = !this.showcase || focused
      const homeX = (i - 3.5) * 2.4
      // 目標位置: 注目中は中央ステージ(カメラ側へ前進)、それ以外は後列
      const tx = focused ? 0 : homeX
      const tz = focused ? stageZ : 8
      const k = Math.min(1, dt * 6)
      m.position.x += (tx - m.position.x) * k
      m.position.z += (tz - m.position.z) * k
      if (focused) {
        // フィールドから切り離してフローティング表示(緩やかに上下＋傾き)
        m.position.y += (2.3 - m.position.y) * Math.min(1, dt * 4) + Math.sin(this.t * 1.1) * 0.012
        this.hopV[i] = 0
      } else {
        // 上下(選択時のホップ＋接地)
        let baseY = Math.max(0, m.position.y + this.hopV[i] * dt)
        if (this.hopV[i] !== 0 || baseY > 0) {
          this.hopV[i] -= 14 * dt
          if (baseY <= 0) { baseY = 0; this.hopV[i] = 0 }
          m.position.y = baseY
        }
      }
      // スケール: 注目中は大きく、ショーケースの非選択は控えめに後退
      const ts = focused ? 1.2 : this.showcase ? 0.8 : 1.0
      const s = m.scale.x + (ts - m.scale.x) * k
      m.scale.setScalar(s)
      // 向き: 選択画面ではカメラ側(正面)を向かせる(モデル正面が-Zのため+π)。
      // 注目中は穏やかに体を見せる程度のスウェイ、それ以外は控えめ。
      const faceBase = this.showcase ? Math.PI : 0
      m.rotation.y = faceBase + (focused ? Math.sin(this.t * 0.6) * 0.18 : Math.sin(this.t * 1.6 + i * 1.3) * 0.06)
      m.rotation.z = focused ? Math.sin(this.t * 0.9) * 0.02 : Math.sin(this.t * 2 + i) * 0.015
      // モーション: リグ済みは関節アニメ、無リグは体アニメ。
      // 注目中は「浮遊して静止」なので歩行サイクルを回さず、呼吸/首ゆれ中心の静かなアイドルにする
      // (amp高だと空中で足踏みして見える=旧0.55の破綻を是正)。amp依存しないidle成分が生命感を担う。
      const amp = focused ? 0.07 : this.showcase ? 0.1 : 0.14
      const rate = focused ? 1.1 : this.showcase ? 2.0 : 2.0
      if (m.userData.bones) animateSkeleton(m, this.t * rate + i, amp)
      else animateGlbBody(m, this.t * rate + i, amp)
    })

    if (this.showcase) {
      // ショーケースカメラ: 中央ステージのキャラを正面・大きめに捉える
      const target = new THREE.Vector3()
      const look = new THREE.Vector3()
      if (this.focusIdx !== null && this.monsters[this.focusIdx]) {
        // 浮遊する選択キャラを正面・やや見上げで捉える
        target.set(0, 2.7, stageZ + 4.0)
        look.set(0, 2.2, stageZ)
      } else {
        target.set(Math.sin(this.t * 0.12) * 2.5, 3.0, 16.5)
        look.set(0, 1.2, 9)
      }
      this.camera.position.lerp(target, Math.min(1, dt * 3.5))
      this.camera.lookAt(look)
    } else {
      const a = this.t * 0.08
      this.camera.position.set(Math.cos(a) * 40, 14 + Math.sin(this.t * 0.3) * 2, Math.sin(a) * 40)
      this.camera.lookAt(0, 2.5, 0)
    }
  }

  render() {
    postfx.render(this.world.scene, this.camera)
  }

  resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight
    this.camera.updateProjectionMatrix()
  }

  dispose() {
    disposeScene(this.world.scene)
  }
}

export interface MatchConfig {
  charKey: string
  botLevel: number
  practice: boolean
  mapKey: string
}

// --- 戦闘(3分スコアアタック) ---
class BattleView implements View {
  world = new World()
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.08, 1200)
  player: PlayerCommander
  bot!: BotCommander | RemoteCommander // オフライン=AI将, オンラインhost=リモート将。client=未生成(相手はpuppet)
  hud: HUD
  // --- オンライン対戦(P2Pホスト権威) ---
  private net: { transport: NetTransport; role: NetRole; oppCharKey: string } | null = null
  private isHost = false
  private isClient = false
  private puppets: PuppetManager | null = null // client: 相手/トークンを見た目だけ再現
  private snapAcc = 0 // host: スナップショット送信間隔の累積
  private inSeq = 0 // client: 入力連番
  private lastSnap: Snapshot | null = null // client: 直近受信スナップ(未適用)
  private lastOppHp = 99999 // client: 相手将の前回HP(被弾→ヒットマーカー判定用)
  private clientSphereOwner: Record<string, Team | null> = {} // client: 各スフィアの前回所有者(確保/被奪取の遷移検出用)
  private clientSpheresSeen = false // client: スフィア所有者を1度記録したか(初回はバナーを鳴らさない)
  private clientDeadCountdown: number | null = null // client: 死亡中のリスポーン残り秒(ローカル推定。実復帰はsnapshotのme.alive)
  private clientLastScoreBlue = 0 // client: 前回スコア(占領カウント加算トーストの検出用)
  private clientLastScoreRed = 0
  over = false
  everLocked = false
  timer = MATCH_TIME
  objectives!: Objectives
  scores: Record<Team, number> = { blue: 0, red: 0 } // スフィア占領カウント(整数表示)
  private respawnT: Partial<Record<Team, number>> = {}
  private fx: Effects
  private combat: Combat
  private popups: DamagePopups
  private sky: { update(t: number): void }
  private arena: { update(dt: number, t: number): void; sunDir: THREE.Vector3 }
  private t = 0
  private coreSpawnT = 4
  private overtimeAnnounced = false
  private suddenDeath = false
  private contestOT = false // 時間切れ後、係争継続で延長中
  private endTimer = -1
  private hitstopT = 0
  /** プレイヤー戦績 */
  stats = { dmgDealt: 0, dmgTaken: 0, tokenKills: 0, cores: 0, tpEarned: 0 }
  /** チュートリアルTIP(最初の3試合のみ、各1回) */
  private tipsEnabled = false
  private tipsShown = new Set<string>()

  /** 計測用(__tw.perf): 弾/エフェクト/ユニット数。プールが伸び続けないことの確認に使う */
  debugPerf() {
    return {
      bolts: this.combat.boltCount,
      boltPool: this.combat.boltPoolSize,
      fx: this.fx.fxCount,
      units: this.world.units.length,
    }
  }

  constructor(
    public config: MatchConfig,
    private onEnd: (scores: Record<Team, number>) => void,
    net: { transport: NetTransport; role: NetRole; oppCharKey: string } | null = null,
  ) {
    this.net = net
    this.isHost = net?.role === 'host'
    this.isClient = net?.role === 'client'
    this.arena = buildArena(this.world, config.mapKey)
    this.sky = createSky(this.world.scene, this.arena.sunDir, (this.arena as any).dusk ? SKY_DUSK : SKY_DAY)
    this.world.scene.environment = envTex
    ;(this.world.scene as any).environmentIntensity = (this.arena as any).dusk ? 0.34 : 0.28
    this.fx = new Effects(this.world.scene)
    this.combat = new Combat(this.world, this.fx, sfx)
    this.popups = new DamagePopups(this.world.scene)
    this.world.scene.add(this.camera)
    // スフィア占領目標: 中央＋両陣に配置(charge式で奪い合う)
    this.objectives = new Objectives(this.world.scene, new THREE.Vector3(0, 3, 0), this.world.basePos)
    this.world.objectives = this.objectives

    const char = characterByKey(config.charKey)
    const others = CHARACTERS.filter((c) => c.key !== config.charKey)
    const botChar = others[Math.floor(Math.random() * others.length)]

    this.player = new PlayerCommander(this.world, this.combat, sfx, input, char, this.world.basePos.blue, this.camera)
    this.world.addUnit(this.player)
    if (this.isHost && net) {
      // ホスト権威: 相手将は受信入力で駆動するRemoteCommander(AIの代わり)。これがオンライン対戦の敵。
      const opp = characterByKey(net.oppCharKey)
      const rc = new RemoteCommander(this.world, this.combat, sfx, opp, 'red', this.world.basePos.red)
      rc.attach(net.transport) // 'input'チャンネルで相手の操作を受信
      this.bot = rc
      this.world.addUnit(this.bot)
      // 発射を全てクライアントへ中継→相手画面に弾が見える。
      // 唯一の例外=クライアント自機将(=このRemoteCommander rc)の弾。これはクライアント側でローカル予測描画するため、
      // 中継すると二重描画になる。それ以外(ホスト青将/青トークン/クライアントが配備した赤トークン)は全てpuppet扱いなので中継して見せる。
      this.combat.onFire = (o, d, opts) => {
        if (opts.from === rc) return
        net.transport.send('event', { type: 'fire', ox: +o.x.toFixed(2), oy: +o.y.toFixed(2), oz: +o.z.toFixed(2), dx: +d.x.toFixed(3), dy: +d.y.toFixed(3), dz: +d.z.toFixed(3), col: opts.color, sp: opts.speed, sz: opts.size, ex: opts.explosive?.radius, gr: opts.gravity, tm: opts.team })
      }
    } else if (this.isClient) {
      // クライアント: 権威simを持たない。自機は赤陣営(host=青)。相手将/トークンはスナップショットでpuppet描画。
      this.player.team = 'red'
      this.player.respawn(this.world.basePos.red, 0) // 赤陣スポーンへ
      // 配備はローカル生成せずホストへ要求(ホスト権威spawn→snapshotでpuppet描画)。戻り値trueでローカル抑止。
      this.player.onDeploy = (key, x, z) => { net!.transport.send('event', { type: 'deploy', key, x, z }); return true }
      // スキルもホスト権威。効果はsnapshotで反映(ステルス等)。ローカルはcd/演出のみ(HUD維持)。
      this.player.onSkill = () => { net!.transport.send('event', { type: 'skill' }); return true }
      this.puppets = new PuppetManager(this.world.scene)
      this.puppets.setLocalCommanderTeam('red')
      net!.transport.onMessage((ch, data: any) => {
        if (ch === 'state') this.lastSnap = data as Snapshot
        else if (ch === 'event' && data && data.type === 'fire') {
          // ホストから来た発射(相手将/双方トークン)を視覚弾として再生(ダメージはホスト権威=snapshotのHPで反映)
          this.combat.fireBolt(
            new THREE.Vector3(data.ox, data.oy, data.oz),
            new THREE.Vector3(data.dx, data.dy, data.dz),
            { damage: 0, team: data.tm ?? 'blue', from: null, speed: data.sp ?? 130, color: data.col, size: data.sz, explosive: data.ex ? { radius: data.ex } : undefined, gravity: data.gr, visual: true },
          )
          sfx.shotFar(0.1)
        } else if (ch === 'event' && data && data.type === 'matchEnd') {
          // ホストがマッチ終了(占領達成/時間切れ/サドンデス)→クライアントも確定スコアで終了
          if (!this.over) { this.scores.blue = data.score[0]; this.scores.red = data.score[1]; this.finish() }
        }
      })
    } else {
      // オフライン(従来どおり): CPU将
      this.bot = new BotCommander(this.world, this.combat, sfx, botChar, this.world.basePos.red, botParams(config.botLevel))
      this.world.addUnit(this.bot)
    }

    this.hud = new HUD(hudRoot, char, this.player.loadout.map((k) => TOKENS[k]))
    this.hud.minimap.buildStatic(this.world)
    hudRoot.classList.remove('hidden')
    this.player.onHit = () => this.hud.hitmarker()
    this.player.onDamaged = () => this.hud.damage()
    this.player.onMessage = (m) => this.hud.message(m)

    // オンライン: 相手の切断/接続喪失でマッチがフリーズしないよう、検知して終了する(商業品質のロバスト性)
    if (this.net) {
      this.net.transport.onStateChange((s) => {
        if ((s === 'closed' || s === 'failed') && !this.over) {
          this.hud.killBanner('相手が切断しました', true)
          this.hud.warn('⚠ 通信が切断されました — マッチ終了', 5)
          this.finish()
        }
      })
    }

    this.world.onDamage = (victim, attacker, amount) => {
      if (attacker === this.player) {
        this.stats.dmgDealt += amount
        if (victim !== this.player) this.popups.show(victim, amount)
      }
      if (victim === this.player) this.stats.dmgTaken += amount
    }

    this.world.onReveal = (team) => {
      if (team === 'blue') {
        this.hud.warn('⚠ 敵に位置を捕捉された!(5秒)')
        sfx.warn()
      }
    }

    this.world.onKill = (victim, killer) => {
      if (victim.isCommander) {
        // 占領モード: 撃破はスコアではなく「盤面の主導権」を取る手段。倒して占領を妨げる/通す。
        sfx.kill()
        this.hitstopT = 0.4 // ヒットストップ(一瞬のスロー演出)
        this.hud.killBanner(victim.team === 'red' ? '敵将を撃破!' : 'やられた…', victim.team === 'red')
        this.hud.feed(victim.team === 'red' ? `敵将${victim.name}を撃破! 占領のチャンス` : `${victim.name}、討たれる…`)
        const rt = this.timer <= OVERTIME_AT ? RESPAWN_TIME_OT : RESPAWN_TIME
        this.respawnT[victim.team] = rt
        return
      }
      if (victim.kind === 'decoy') {
        this.hud.feed(`${TEAM_NAME[victim.team]}のデコイが消滅`)
        return
      }
      this.hud.feed(`${victim.name}(${TEAM_NAME[victim.team]})撃破`)
      // 撃破地点に小コアをドロップ(回収しに行く動機)
      this.dropCore(victim.group.position.clone(), true)
      if (killer === this.player) {
        this.stats.tokenKills++
        sfx.hitmarker()
      }
    }

    this.hud.message(`中央＋敵スフィアを確保してカウントを稼げ! 先に${CAPTURE_TO_WIN}で勝利`, 3)

    // 最初の3試合だけチュートリアルTIPを出す
    try {
      const played = parseInt(localStorage.getItem('tw-matches') ?? '0', 10)
      this.tipsEnabled = played < 3
      localStorage.setItem('tw-matches', String(played + 1))
    } catch {
      this.tipsEnabled = false
    }
  }

  /** 条件を満たしたTIPを1度だけ表示 */
  private tip(key: string, text: string) {
    if (!this.tipsEnabled || this.tipsShown.has(key)) return
    this.tipsShown.add(key)
    this.hud.tip(text)
  }

  // --- エナジーコア ---
  private spawnCore() {
    const bigCores = this.world.cores.filter((c) => !c.small)
    if (bigCores.length >= 4) return
    const used = new Set(bigCores.map((c) => `${Math.round(c.pos.x)},${Math.round(c.pos.z)}`))
    const free = this.world.coreSpots.filter((s) => !used.has(`${Math.round(s.x)},${Math.round(s.z)}`))
    if (!free.length) return
    const spot = free[Math.floor(Math.random() * free.length)]
    this.dropCore(spot.clone(), false)
  }

  private dropCore(pos: THREE.Vector3, small: boolean) {
    pos.y = 0
    const mesh = buildCore(small)
    mesh.position.copy(pos)
    this.world.scene.add(mesh)
    this.world.cores.push({ pos, mesh, tp: small ? SMALL_CORE_TP : CORE_TP, small, life: small ? 20 : Infinity })
  }

  private collectCore(core: Core, collector: PlayerCommander | BotCommander | RemoteCommander, behind: boolean) {
    let tp = core.tp
    if (behind && !core.small) tp += CORE_TP_MOMENTUM_BONUS
    collector.tp = Math.min(100, collector.tp + tp)
    this.world.scene.remove(core.mesh)
    const i = this.world.cores.indexOf(core)
    if (i >= 0) this.world.cores.splice(i, 1)
    this.fx.ring(core.pos.clone(), core.small ? 0x7dffd0 : 0xffd23e)
    if (collector === this.player) {
      this.stats.cores++
      this.stats.tpEarned += tp
      sfx.core()
      this.hud.message(`コア回収 +${tp}TP`)
    }
  }

  private updateCores(dt: number) {
    const overtime = this.timer <= OVERTIME_AT
    this.coreSpawnT -= dt
    if (this.coreSpawnT <= 0) {
      this.coreSpawnT = (overtime ? 6 : 12) * (0.8 + Math.random() * 0.4)
      this.spawnCore()
    }
    const behindTeam: Team | null =
      this.scores.blue < this.scores.red ? 'blue' : this.scores.red < this.scores.blue ? 'red' : null
    for (const core of [...this.world.cores]) {
      core.mesh.rotation.y += dt * 2
      const crystal = core.mesh.userData.crystal as THREE.Object3D | undefined
      if (crystal) crystal.position.y = (core.small ? 0.5 : 0.7) + Math.sin(this.t * 2.5) * 0.1
      if (core.life !== Infinity) {
        core.life -= dt
        if (core.life <= 0) {
          this.world.scene.remove(core.mesh)
          const i = this.world.cores.indexOf(core)
          if (i >= 0) this.world.cores.splice(i, 1)
          continue
        }
      }
      // 回収判定(両将)
      for (const cmd of [this.player, this.bot] as const) {
        if (!cmd.alive) continue
        const cp = cmd === this.player ? this.player.pos : this.bot.group.position
        const dx = cp.x - core.pos.x
        const dz = cp.z - core.pos.z
        if (dx * dx + dz * dz < 1.4 * 1.4) {
          this.collectCore(core, cmd, behindTeam === cmd.team)
          break
        }
      }
    }
  }

  private finish() {
    if (this.over) return
    this.over = true
    this.endTimer = 1.2
    // 勝敗のSE/ジングルは「自分の陣営」視点で鳴らす(オンラインclient=赤では blue>=red 固定だと勝敗が逆転していた)。
    // host/オフラインは player.team='blue' なので従来どおり。
    const myScore = this.player.team === 'blue' ? this.scores.blue : this.scores.red
    const theirScore = this.player.team === 'blue' ? this.scores.red : this.scores.blue
    sfx.sting(myScore >= theirScore)
    bgm.jingle(myScore === theirScore ? 'draw' : myScore > theirScore ? 'win' : 'lose')
    input.exitLock()
    // ホスト権威: あらゆる終了条件(占領達成/時間切れ/サドンデス)をクライアントへ伝える(クライアントの取りこぼし防止)
    if (this.isHost && this.net) this.net.transport.send('event', { type: 'matchEnd', score: [this.scores.blue, this.scores.red] })
  }

  /** ホスト: 20Hzで権威スナップショットを配信 */
  private hostNetUpdate(dt: number) {
    if (!this.net) return
    this.snapAcc += dt
    if (this.snapAcc < 0.05) return
    this.snapAcc = 0
    const o = this.objectives
    const snap = encodeSnapshot(
      this.world.units,
      [o.center.charge, o.base.blue.charge, o.base.red.charge],
      [this.scores.blue, this.scores.red],
      this.timer,
      this.t,
      this.suddenDeath,
    )
    this.net.transport.send('state', snap)
  }

  /** クライアント: 自機入力を送信し、受信スナップショットを反映(権威simは持たない) */
  private clientNetUpdate(_dt: number) {
    if (!this.net || this.over) return // 終了後は入力送信もsnapshot適用も止める(確定スコアが巻き戻らないように)
    // 1) 自機入力をホストへ(ホストのRemoteCommanderが駆動)
    this.net.transport.send('input', sampleNetInput(input, this.player.yaw, this.player.pitch, this.inSeq++))
    // 2) 受信スナップショットを権威として適用
    const snap = this.lastSnap
    if (!snap) return
    this.lastSnap = null
    this.puppets?.ingest(snap)
    this.scores.blue = snap.score[0]
    this.scores.red = snap.score[1]
    this.timer = snap.timer
    // 試合フェーズ(OT/サドンデス)の告知はホスト権威simの中だけで鳴っていてクライアントに来ていなかった。
    // snapshotのtimer/sdから遷移を検出し、クライアントでも告知バナー+BGM+SEを鳴らす(HUDのOT/SD表示もthis.suddenDeathに依存)。
    const wasSudden = this.suddenDeath
    this.suddenDeath = !!snap.sd
    if (this.suddenDeath && !wasSudden) {
      this.hud.warn('🔥 サドンデス — 先にカウントを進めた方が勝ち!', 4)
      sfx.overtime(); bgm.play('overtime')
    } else if (!this.overtimeAnnounced && !this.suddenDeath && this.timer <= OVERTIME_AT) {
      this.overtimeAnnounced = true
      this.hud.warn('⚡ OVERTIME — TP回復2倍・コア増加!', 3)
      sfx.overtime(); bgm.play('overtime')
    }
    // momentum(逆転ブースト)指標と占領カウント加算トーストもホスト限定だった→クライアントでも反映。
    // momentumはHUD表示専用(実TPはsnapshot権威)。client=赤が劣勢+OTで tpRegenMul を上げ指標を点灯させる。
    const otMul = this.timer <= OVERTIME_AT ? 2 : 1
    this.player.tpRegenMul = (this.scores.red < this.scores.blue ? TP_MOMENTUM_MUL : 1) * otMul
    // 占領カウントが増えた瞬間に一瞬トースト(scoreプレートと同じblue-red順で一貫)
    if (snap.score[0] > this.clientLastScoreBlue || snap.score[1] > this.clientLastScoreRed) {
      this.hud.warn(`占領カウント ${snap.score[0]} - ${snap.score[1]}`, 1)
    }
    this.clientLastScoreBlue = snap.score[0]; this.clientLastScoreRed = snap.score[1]
    // スフィアの見た目をchargeで反映(視覚のみ)
    const o = this.objectives
    o.center.charge = snap.spheres[0]; o.base.blue.charge = snap.spheres[1]; o.base.red.charge = snap.spheres[2]
    for (const s of o.spheres) s.update(_dt)
    // スフィア確保/被奪取のフィードバックもホストの!isClientブロック限定だった。chargeから所有権遷移を自前検出し、
    // 赤(自分)視点でバナー/SEを鳴らす(redBase=自陣, blueBase=敵陣 と反転。host視点の流用は禁物)。
    for (const s of o.spheres) {
      const own = s.owner()
      if (this.clientSpheresSeen && own !== this.clientSphereOwner[s.id] && own !== null) {
        const name = s.id === 'center' ? '中央' : s.id === 'redBase' ? '自陣' : '敵陣'
        if (own === 'red') { // 自分(赤)が確保
          this.hud.killBanner(`${name}スフィア 確保!`, true); this.hud.feed(`${name}スフィアを確保した`); sfx.core(); this.hitstopT = Math.max(this.hitstopT, 0.18)
        } else { // 相手(青)が確保=自分が奪われた
          this.hud.warn(`⚠ ${name}スフィアを奪われた!`, 2); sfx.damaged(); this.hud.damage()
        }
      }
      this.clientSphereOwner[s.id] = own
    }
    this.clientSpheresSeen = true
    // 自機(赤将)の権威状態を反映(HP/生存)＋大きくドリフトしたら位置を引き戻す
    // 相手将(青)のHPが下がった=自分が当てた → ヒットマーカー(1v1なのでほぼ自分の戦果。dmgDealt集計も)
    const opp = snap.units.find((u) => u.kind === 'commander' && u.team === 'blue')
    if (opp) {
      if (opp.hp < this.lastOppHp && this.lastOppHp < 99999) { this.hud.hitmarker(); sfx.hitmarker(); this.stats.dmgDealt += this.lastOppHp - opp.hp }
      this.lastOppHp = opp.hp
    }
    const me = snap.units.find((u) => u.kind === 'commander' && u.team === 'red')
    if (me) {
      // 被弾フィードバック: HPが下がっていたら被ダメ演出(画面フラッシュ/シェイク)を起動(snapshot直書きだと無音だった)
      if (me.hp < this.player.hp) { const d = this.player.hp - me.hp; this.player.onDamaged?.(d); this.stats.dmgTaken += d }
      this.player.hp = me.hp
      this.player.maxHp = me.mhp
      if (me.tp !== undefined) this.player.tp = me.tp // TPはホスト権威(配備可否・HUD表示を一致させる)
      if (!me.alive && this.player.alive) {
        this.player.alive = false
        // 死亡→ローカルでリスポーンカウントダウン開始(HUD表示用。実復帰はsnapshotのme.aliveで反映)
        this.clientDeadCountdown = this.timer <= OVERTIME_AT ? RESPAWN_TIME_OT : RESPAWN_TIME
      } else if (me.alive && !this.player.alive) {
        this.player.respawn(this.world.basePos.red, RESPAWN_INVULN)
        this.clientDeadCountdown = null
        this.hud.message(`リスポーン — ${RESPAWN_INVULN}秒無敵`, 2)
      }
      const drift = Math.hypot(this.player.pos.x - me.x, this.player.pos.z - me.z)
      if (drift > 3) this.player.pos.set(me.x, this.player.pos.y, me.z)
    }
    // 勝敗(ホスト権威): カウント到達で終了
    if (!this.over && (snap.score[0] >= CAPTURE_TO_WIN || snap.score[1] >= CAPTURE_TO_WIN)) {
      this.hud.killBanner(snap.score[1] > snap.score[0] ? '勝利!' : '敗北…', snap.score[1] > snap.score[0])
      this.finish()
    }
  }

  update(dt: number) {
    const paused = this.everLocked && !input.locked && !this.over && this.player.alive
    resumeOverlay.classList.toggle('hidden', !paused)
    if (paused) {
      // オンライン対戦は一時停止できない(ホストが止まると対戦全体が凍結/クライアントは無操作の的になり復帰時に飛ぶ)。
      // overlayは出して操作復帰を促すが、ゲーム自体は進め続ける。文言も状況に合わせる。
      const span = resumeOverlay.querySelector('span')
      if (span) span.textContent = this.net ? 'クリックで操作再開（対戦は進行中！）' : 'クリックで戦闘に戻る'
    }
    this.t += dt
    this.world.time = this.t
    this.sky.update(this.t)
    this.arena.update(dt, this.t)
    if (paused && !this.net) return // 一時停止で凍結するのはオフラインのみ。オンラインはsim/ネットコードを進め続ける。

    // クライアントは権威simを持たない: 入力送信＋受信スナップショット適用(スコア/タイマー/相手puppet/自機補正)
    if (this.isClient) this.clientNetUpdate(dt)
    // 死亡中のリスポーンカウントダウンを毎フレーム減算(HUD表示用。clientNetUpdateはsnapshot無いフレームは早期returnするため別途)
    if (this.isClient && this.clientDeadCountdown !== null) this.clientDeadCountdown = Math.max(0, this.clientDeadCountdown - dt)

    if (!this.over && !this.isClient) {
      // スフィア占領カウント更新(中央＋敵陣を確保している側が加算)
      const obj = this.objectives.update(dt)
      this.scores.blue = Math.floor(this.objectives.count.blue)
      this.scores.red = Math.floor(this.objectives.count.red)
      if (obj.ticked) {
        this.hud.warn(`占領カウント ${this.scores.blue} - ${this.scores.red}`, 1)
      }
      // スフィア確保/被奪取のジュース(低頻度イベントに大演出。研究の3段ジュース予算)
      for (const fl of obj.flips) {
        const sphName = fl.id === 'center' ? '中央' : fl.id === 'redBase' ? '敵陣' : '自陣'
        if (fl.owner === 'blue') {
          this.hud.killBanner(`${sphName}スフィア 確保!`, true)
          this.hud.feed(`${sphName}スフィアを確保した`)
          sfx.core()
          this.hitstopT = Math.max(this.hitstopT, 0.18)
        } else {
          this.hud.warn(`⚠ ${sphName}スフィアを奪われた!`, 2)
          sfx.damaged()
          this.hud.damage()
        }
      }
      if (this.objectives.winner) {
        this.hud.killBanner(this.objectives.winner === 'blue' ? '占領完了 勝利!' : '占領され敗北…', this.objectives.winner === 'blue')
        this.finish()
      }

      this.timer -= dt
      if (this.timer <= 0) {
        this.timer = 0
        // 係争中は決着させない(時間切れ直前の逆転ラッシュを成立させる。Overwatch/Splat Zones式)
        const contested = this.objectives.spheres.some((s) => s.contested())
        if (contested) {
          if (!this.contestOT) {
            this.contestOT = true
            this.hud.warn('⏱ 延長戦 — 係争が続く限り決着しない!', 3)
            sfx.overtime()
            bgm.play('overtime')
          }
        } else if (!this.suddenDeath && this.scores.blue === this.scores.red) {
          // 同点ならサドンデス(45秒・先にリードした側が勝ち)
          this.suddenDeath = true
          this.timer = 45
          this.contestOT = false
          this.hud.warn('🔥 サドンデス — 先にカウントを進めた方が勝ち!', 4)
          sfx.overtime()
          bgm.play('overtime')
        } else {
          this.finish()
        }
      }
      // サドンデス中: どちらかが少しでもリードしたら即決着
      if (this.suddenDeath && this.scores.blue !== this.scores.red) this.finish()
      // オーバータイム告知
      if (!this.overtimeAnnounced && this.timer <= OVERTIME_AT) {
        this.overtimeAnnounced = true
        this.hud.warn('⚡ OVERTIME — TP回復2倍・コア増加!', 3)
        sfx.overtime()
        bgm.play('overtime')
      }
      // モメンタム(ビハインド側のTP回復ブースト)+ OT全体ブースト
      const otMul = this.timer <= OVERTIME_AT ? 2 : 1
      const blueBehind = this.scores.blue < this.scores.red
      const redBehind = this.scores.red < this.scores.blue
      this.player.tpRegenMul = (blueBehind ? TP_MOMENTUM_MUL : 1) * otMul
      this.bot.tpRegenMul = (redBehind ? TP_MOMENTUM_MUL : 1) * otMul

      // リスポーン処理
      for (const team of ['blue', 'red'] as Team[]) {
        const t = this.respawnT[team]
        if (t === undefined) continue
        const next = t - dt
        if (next <= 0) {
          delete this.respawnT[team]
          const base = this.world.basePos[team]
          if (team === 'blue') {
            this.player.respawn(base, RESPAWN_INVULN)
            this.hud.message(`リスポーン — ${RESPAWN_INVULN}秒無敵`, 2)
          } else {
            this.bot.respawn(base, RESPAWN_INVULN)
          }
          // ワープイン演出
          this.fx.column(base.clone(), team === 'blue' ? 0x4db8ff : 0xff6a5a)
          this.fx.ring(base.clone(), team === 'blue' ? 0x4db8ff : 0xff6a5a)
          sfx.deploy()
        } else {
          this.respawnT[team] = next
        }
      }

      this.updateCores(dt)
      // リビールタイマー減衰
      for (const team of ['blue', 'red'] as Team[]) {
        this.world.revealT[team] = Math.max(0, this.world.revealT[team] - dt)
      }

      // チュートリアルTIP(文脈に応じて1回ずつ)
      if (this.tipsEnabled) {
        const elapsed = MATCH_TIME - this.timer
        if (elapsed > 2.5) this.tip('deploy', 'キー1〜4で照準先にトークンを配備して盤面を作ろう')
        if (elapsed > 12) this.tip('skill', `Eでスキル「${this.player.char.skill.name}」を使える`)
        if (this.player.energy < 30 && this.player.alive) this.tip('energy', 'エネルギー残量に注意 — R長押しでチャージ(無防備になる)')
        if (this.world.cores.some((c) => !c.small)) this.tip('core', 'フィールドのコア(ミニマップの黄色◆)を回収するとTP+20')
        if (this.player.hp < this.player.maxHp * 0.45 && this.player.alive) this.tip('retreat', 'ピンチの時は遮蔽に隠れて6秒で自動回復が始まる')
      }
    }

    // ヒットストップ中はゲーム世界だけスローになる
    const udt = this.hitstopT > 0 ? dt * 0.25 : dt
    this.hitstopT = Math.max(0, this.hitstopT - dt)
    for (const u of [...this.world.units]) u.update(udt)
    this.fx.update(udt)
    this.combat.update(udt)
    this.popups.update(udt)
    // クライアント: 相手/トークンpuppetをrender-behind補間で描画。ホスト: 20Hzでスナップショット配信。
    if (this.isClient && this.puppets) this.puppets.update(dt)
    if (this.isHost) this.hostNetUpdate(dt)

    if (!this.over) {
      this.hud.update(
        {
          hp: this.player.hp,
          maxHp: this.player.maxHp,
          energy: this.player.energy,
          charging: this.player.charging,
          tp: this.player.tp,
          tpMax: this.player.tpMax,
          skillCdLeft: this.player.skillCd,
          skillActive: this.player.skillActiveT > 0,
          stealthed: this.player.stealthed,
          timer: this.timer,
          scoreBlue: this.scores.blue,
          scoreRed: this.scores.red,
          momentum: this.player.tpRegenMul > (this.timer <= OVERTIME_AT ? 2 : 1),
          overtime: this.timer <= OVERTIME_AT && !this.suddenDeath,
          suddenDeath: this.suddenDeath,
          deadCountdown: this.isClient ? this.clientDeadCountdown : (this.respawnT.blue ?? null),
          slots: this.player.loadout.map((k) => ({
            def: TOKENS[k],
            count: this.world.countActive('blue', k),
            affordable: this.player.tp >= TOKENS[k].cost,
          })),
          spheres: this.objectives.spheres.map((sp) => ({
            id: sp.id, owner: sp.owner(), contested: sp.contested(),
          })),
          countGoal: CAPTURE_TO_WIN,
        },
        dt,
      )
      this.hud.minimap.draw(this.world, this.player.pos, this.player.yaw, this.t)
    }
    if (this.endTimer > 0) {
      this.endTimer -= dt
      if (this.endTimer <= 0) this.onEnd(this.scores)
    }
  }

  render() {
    postfx.render(this.world.scene, this.camera)
  }

  resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight
    this.camera.updateProjectionMatrix()
  }

  dispose() {
    this.hud.destroy()
    hudRoot.classList.add('hidden')
    this.fx.dispose()
    this.combat.dispose()
    this.popups.dispose()
    disposeScene(this.world.scene)
  }
}

// --- 状態遷移 ---
let view: View = new MenuView()
let battle: BattleView | null = null
let lastChar = 'renji'
let lastWasOnline = false // 直前の対戦がオンラインだったか(リザルトの再戦ボタンの分岐用。P2P接続は試合後切れるので再戦はロビーへ)
let pendingMode: { botLevel: number; practice: boolean } = { botLevel: 6, practice: false }
let pendingMap = 'skyhaven'

input.onLockChange = (locked) => {
  if (locked && battle) battle.everLocked = true
  if (locked) resumeOverlay.classList.add('hidden')
}

function startBattle(charKey: string, net: { transport: NetTransport; role: NetRole; oppCharKey: string } | null = null) {
  lastChar = charKey
  lastWasOnline = net != null
  view.dispose()
  const myTeam: Team = net?.role === 'client' ? 'red' : 'blue' // オンラインclientは赤陣営
  battle = new BattleView(
    { charKey, botLevel: pendingMode.botLevel, practice: pendingMode.practice, mapKey: pendingMap },
    (scores) => {
      const mine = myTeam === 'blue' ? scores.blue : scores.red
      const theirs = myTeam === 'blue' ? scores.red : scores.blue
      const win = mine > theirs
      const draw = mine === theirs
      const label = document.getElementById('result-label')!
      label.textContent = draw ? 'DRAW' : win ? 'WIN' : 'LOSE'
      label.className = draw ? 'draw' : win ? 'win' : 'lose'
      document.getElementById('result-score')!.textContent = `${mine} - ${theirs}`
      // 戦績詳細
      const b = battle!
      const acc = b.player.shotsFired > 0 ? Math.round((b.player.shotsHit / b.player.shotsFired) * 100) : 0
      document.getElementById('result-stats')!.innerHTML = [
        ['与ダメージ', Math.round(b.stats.dmgDealt)],
        ['被ダメージ', Math.round(b.stats.dmgTaken)],
        ['命中率', `${acc}%`],
        ['トークン撃破', b.stats.tokenKills],
        ['配備', b.player.deploysCount],
        ['コア回収', `${b.stats.cores}(+${b.stats.tpEarned}TP)`],
      ]
        .map(([k, v]) => `<div class="rs-item"><span>${k}</span><b>${v}</b></div>`)
        .join('')
      document.getElementById('result-sub')!.textContent = draw
        ? '互角。次は盤面で上回れ。'
        : win
          ? '盤面とエイム、両方の勝利だ。'
          : '盤面を立て直し、コアを制せ。'
      // オンライン対戦はP2P接続が試合後に切れるため、即時再戦はできない→再戦ボタンを「ロビーへ」に変える(オフラインは「再戦」のまま)
      document.getElementById('btn-rematch')!.textContent = lastWasOnline ? 'ロビーへ' : '再戦'
      showScreen('result')
    },
    net,
  )
  view = battle
  showScreen(null)
  resumeOverlay.classList.add('hidden')
  bgm.play(Math.random() < 0.5 ? 'battle_a' : 'battle_b')
  input.requestLock()
}

function backToMenu(target: 'title' | 'mode' | 'select') {
  // オンライン対戦の後始末(トランスポートを閉じ、オフライン状態へ戻す)
  if (pendingNet) { try { pendingNet.transport.close() } catch { /* noop */ } }
  pendingNet = null
  pendingNetSortie = null
  view.dispose()
  battle = null
  view = new MenuView()
  showScreen(target)
  bgm.play(target === 'title' ? 'title' : 'select')
}

// マップ選択チップ
const mapRow = document.getElementById('map-row')!
for (const m of MAPS) {
  const chip = document.createElement('button')
  chip.className = 'map-chip' + (m.key === pendingMap ? ' sel' : '')
  chip.innerHTML = `<b>${m.name}</b><span>${m.desc}</span>`
  chip.addEventListener('click', () => {
    pendingMap = m.key
    mapRow.querySelectorAll('.map-chip').forEach((c) => c.classList.remove('sel'))
    chip.classList.add('sel')
    sfx.unlock()
  })
  mapRow.appendChild(chip)
}

// モード選択
document.getElementById('btn-versus')!.addEventListener('click', () => {
  sfx.unlock()
  if (pendingNet) { try { pendingNet.transport.close() } catch {} pendingNet = null; pendingNetSortie = null } // オフライン入口: 残ったオンライン接続を破棄
  pendingMode = { botLevel: 6, practice: false }
  showScreen('select')
})
const levelGrid = document.getElementById('level-grid')!
for (let lv = 1; lv <= 10; lv++) {
  const b = document.createElement('button')
  b.className = 'level-btn'
  b.textContent = `${lv}`
  b.addEventListener('click', (e) => {
    e.stopPropagation()
    sfx.unlock()
    if (pendingNet) { try { pendingNet.transport.close() } catch {} pendingNet = null; pendingNetSortie = null }
    pendingMode = { botLevel: lv, practice: true }
    showScreen('select')
  })
  levelGrid.appendChild(b)
}

// --- オンライン対戦ロビー(WebRTC P2P) ---
// 部屋を作る=ホスト(権威)/合言葉で参加=クライアント。接続が確立したら pendingNet を立て、
// キャラ選択→出撃でオンライン対戦を開始する(対戦本体の同期は PvP Phase2)。
let pendingNet: { transport: NetTransport; role: NetRole } | null = null
let pendingNetSortie: (() => void) | null = null // オンライン時の出撃(ready交換)。btn-sortieから呼ぶ
const lobbyEl = {
  choice: document.getElementById('lobby-choice')!,
  status: document.getElementById('lobby-status')!,
  msg: document.getElementById('lobby-msg')!,
  codeBox: document.getElementById('lobby-code-box')!,
  code: document.getElementById('lobby-code')!,
  codeInput: document.getElementById('lobby-code-input') as HTMLInputElement,
}
let lobbyTransport: WebRtcTransport | null = null

function lobbyReset() {
  lobbyEl.choice.classList.remove('hidden')
  lobbyEl.status.classList.add('hidden')
  lobbyEl.codeBox.classList.add('hidden')
  lobbyEl.msg.textContent = '接続中…'
}
function lobbyShowStatus(msg: string) {
  lobbyEl.choice.classList.add('hidden')
  lobbyEl.status.classList.remove('hidden')
  lobbyEl.msg.textContent = msg
}
function lobbyCleanup() {
  if (lobbyTransport && lobbyTransport.state !== 'open') lobbyTransport.close()
  lobbyTransport = null
}
/** 接続エラーを原因別の日本語メッセージに(peerjsの error.type / timeout を見分ける) */
function lobbyErrMsg(e: any, joining: boolean): string {
  const type = e && (e.type || e.message)
  if (type === 'timeout') return joining
    ? '接続がタイムアウトしました。合言葉と回線を確認して、もう一度お試しください。'
    : '部屋の作成がタイムアウトしました。回線を確認して、もう一度お試しください。'
  if (type === 'peer-unavailable') return 'その合言葉の部屋が見つかりません。ホストが待機中か、合言葉が正しいか確認してください。'
  if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed')
    return 'シグナリングサーバに接続できません。回線を確認して、もう一度お試しください。'
  if (type === 'browser-incompatible') return 'このブラウザはWebRTC P2Pに対応していません。'
  return joining ? '接続に失敗しました(合言葉/回線を確認)。戻ってやり直してください。'
                 : '部屋の作成に失敗しました(回線/ブローカー)。戻ってやり直してください。'
}
/** 接続確立 → キャラ選択へ。出撃時に ready{char,map} を交換し、双方揃ったらオンライン対戦を開始する。 */
function onNetConnected(transport: NetTransport, role: NetRole) {
  pendingNet = { transport, role }
  let sentReady = false
  let oppChar: string | null = null
  let oppMap: string | null = null
  let started = false
  const tryStart = () => {
    if (started || !sentReady || !oppChar) return
    started = true
    pendingNetSortie = null
    if (role !== 'host' && oppMap) pendingMap = oppMap // ホストのマップに合わせる
    startBattle(selectedChar.key, { transport, role, oppCharKey: oppChar })
  }
  // ready受信(相手の出撃)。出撃前に来ても保持してtryStartで合流する。
  transport.onMessage((ch, data: any) => {
    if (ch === 'event' && data && data.type === 'ready') {
      oppChar = data.char
      oppMap = data.map
      tryStart()
    }
  })
  // 出撃ボタン(btn-sortie)から呼ばれる: 自分のreadyを送って相手を待つ
  pendingNetSortie = () => {
    if (sentReady) return
    sentReady = true
    transport.send('event', { type: 'ready', char: selectedChar.key, map: pendingMap })
    tryStart()
  }
  // ロビー中(キャラ選択〜出撃前)に相手が切断したら、無限待ちにせずロビーへ戻して通知する。
  // 対戦開始後は BattleView 側が onStateChange を上書きして自前で終了処理する(役割交代)。
  transport.onStateChange((s) => {
    if ((s === 'closed' || s === 'failed') && !started) {
      pendingNet = null
      pendingNetSortie = null
      lobbyTransport = null
      showScreen('lobby')
      lobbyShowStatus('相手との接続が切れました。もう一度ホスト/参加からやり直してください。')
    }
  })
  lobbyShowStatus('P2P接続が確立しました！コマンダーを選んで出撃。')
  setTimeout(() => showScreen('select'), 600)
}

document.getElementById('btn-online')!.addEventListener('click', () => {
  sfx.unlock()
  lobbyReset()
  showScreen('lobby')
})
document.getElementById('lobby-host')!.addEventListener('click', () => {
  sfx.unlock()
  lobbyShowStatus('部屋を準備中…')
  const { transport, ready } = WebRtcTransport.host()
  lobbyTransport = transport
  ready.then((code) => {
    lobbyEl.codeBox.classList.remove('hidden')
    lobbyEl.code.textContent = code
    lobbyEl.msg.textContent = '合言葉を相手に伝えて待機中…'
  }).catch((e) => { lobbyEl.msg.textContent = lobbyErrMsg(e, false) })
  transport.onStateChange((s) => { if (s === 'open') onNetConnected(transport, 'host') })
})
document.getElementById('lobby-join')!.addEventListener('click', () => {
  sfx.unlock()
  const code = lobbyEl.codeInput.value.trim()
  if (!code) { lobbyEl.codeInput.focus(); return }
  lobbyShowStatus('ホストに接続中…')
  const { transport, connected } = WebRtcTransport.join(code)
  lobbyTransport = transport
  connected.then(() => onNetConnected(transport, 'client'))
    .catch((e) => { lobbyEl.msg.textContent = lobbyErrMsg(e, true) })
})
document.getElementById('lobby-copy')!.addEventListener('click', () => {
  const code = lobbyEl.code.textContent ?? ''
  if (code) navigator.clipboard?.writeText(code).then(() => { lobbyEl.msg.textContent = 'コピーしました！相手に伝えてください。' }).catch(() => {})
})
document.getElementById('btn-lobby-back')!.addEventListener('click', () => {
  sfx.unlock()
  lobbyCleanup()
  pendingNet = null
  showScreen('mode')
})

// キャラ選択(ロスター＋大プレビュー＋詳細パネル＋出撃)
const rosterRoot = document.getElementById('char-roster')!
const previewWrap = document.getElementById('char-preview')!
const previewName = document.getElementById('preview-name')!
const previewRole = document.getElementById('preview-role')!
const previewTitle = document.getElementById('preview-title')!
const detailsRoot = document.getElementById('char-details')!
const rosterThumbs: HTMLElement[] = []
let selectedChar = CHARACTERS[0]
let selectedIdx = 0

function selectCharacter(c: CharacterDef, idx: number) {
  selectedChar = c
  selectedIdx = idx
  const colorHex = `#${c.color.toString(16).padStart(6, '0')}`
  // 名前タグ(3Dモデルは中央ステージで見せる)
  previewWrap.style.setProperty('--cc', colorHex)
  previewWrap.classList.remove('swap')
  void previewWrap.offsetWidth
  previewWrap.classList.add('swap')
  previewName.textContent = c.name
  previewRole.textContent = c.role
  previewTitle.textContent = c.title
  // 詳細パネル
  detailsRoot.style.setProperty('--cc', colorHex)
  detailsRoot.innerHTML = `
    <div class="detail-hp"><span>HP</span><b>${c.hp}</b></div>
    <div class="detail-block"><span class="dl">武器</span><b>${c.weapon.name}</b><p>${c.weapon.desc}</p></div>
    <div class="detail-block"><span class="dl">スキル</span><b>${c.skill.name}</b><p>${c.skill.desc}</p></div>
    <div class="detail-block"><span class="dl">固有トークン</span><b>${TOKENS[c.uniqueToken].name}</b><p>${TOKENS[c.uniqueToken].desc}</p></div>
  `
  // ロスターのハイライト＋3Dショーケースのフォーカス
  rosterThumbs.forEach((t, i) => t.classList.toggle('sel', i === idx))
  if (view instanceof MenuView) view.focusChar(idx)
}

CHARACTERS.forEach((c, idx) => {
  const colorHex = `#${c.color.toString(16).padStart(6, '0')}`
  const thumb = document.createElement('button')
  thumb.className = `roster-thumb ${c.key} ${c.gender}`
  thumb.style.setProperty('--cc', colorHex)
  thumb.innerHTML = `<span class="rt-frame"><img src="art/portrait_${c.key}.png" alt="${c.name}" loading="lazy" /></span><span class="rt-name">${c.name}</span>`
  thumb.addEventListener('click', () => { sfx.unlock(); selectCharacter(c, idx) })
  thumb.addEventListener('dblclick', () => { sfx.unlock(); startBattle(c.key) })
  thumb.addEventListener('mouseenter', () => { if (view instanceof MenuView) view.focusChar(idx) })
  thumb.addEventListener('mouseleave', () => { if (view instanceof MenuView) view.focusChar(selectedIdx) })
  rosterRoot.appendChild(thumb)
  rosterThumbs.push(thumb)
})

document.getElementById('btn-sortie')!.addEventListener('click', () => {
  sfx.unlock()
  if (pendingNet && pendingNetSortie) {
    pendingNetSortie() // オンライン: ready交換→双方揃ったら開始
    const sortie = document.getElementById('btn-sortie')!
    sortie.textContent = '相手を待っています…'
    ;(sortie as HTMLButtonElement).disabled = true
    setTimeout(() => { sortie.textContent = '出 撃'; (sortie as HTMLButtonElement).disabled = false }, 8000)
  } else {
    startBattle(selectedChar.key)
  }
})
selectCharacter(CHARACTERS[0], 0) // 初期選択

document.getElementById('btn-start')!.addEventListener('click', () => {
  sfx.unlock()
  bgm.unlock()
  bgm.play('select')
  showScreen('mode')
})
document.getElementById('btn-rematch')!.addEventListener('click', () => {
  sfx.unlock()
  if (lastWasOnline) {
    // オンライン対戦の再戦: P2P接続は終了済みなので、黙ってオフライン戦を始めず再接続のためロビーへ戻す。
    pendingNet = null
    pendingNetSortie = null
    lobbyCleanup()
    lobbyReset()
    showScreen('lobby')
  } else {
    startBattle(lastChar)
  }
})
document.getElementById('btn-reselect')!.addEventListener('click', () => {
  sfx.unlock()
  backToMenu('select')
})
document.getElementById('btn-remode')!.addEventListener('click', () => {
  sfx.unlock()
  backToMenu('mode')
})
resumeOverlay.addEventListener('click', () => {
  sfx.unlock()
  input.requestLock()
})

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight)
  postfx.resize(window.innerWidth, window.innerHeight)
  view.resize()
})

// 開発用デバッグフック
;(window as any).__tw = {
  get battle() {
    return battle
  },
  startBattle,
  setMode(botLevel: number, practice = true) {
    pendingMode = { botLevel, practice }
  },
  TOKENS,
  sfx,
  bgm,
  sim: simulateMatch,
  simMatrix: simulateMatrix,
  simSummary: summarize,
  // タブ非表示でrAFが止まってもフレームバッファを更新して撮影できるよう、手動でN frame回す(検証用)
  renderNow(frames = 1) {
    for (let i = 0; i < Math.max(1, frames); i++) {
      view.update(1 / 60)
      view.render()
    }
  },
  // マップ俯瞰デバッグビュー(レーン/カバー配置の検証用)。topView(h)で高さh真上から、topView(0)で解除。
  // 永続モード: メインループが描画を切り替えるので、rAFに上書きされず撮影できる。
  topView(h = 78) {
    ;(window as any).__topH = h
    return true
  },
  // 計測ファースト: 最適化の前後を数値で比較する。draw call数/三角形/弾・fx数とフレーム時間p50/p95/maxを返す。
  // 打ち合い中に呼んで、p95やmaxが跳ねていない=スパイクが無いことを確認する。
  perf() {
    const r = renderer.info.render
    const s = frameMs.slice().sort((a, b) => a - b)
    const at = (q: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : 0)
    const round = (x: number) => Math.round(x * 10) / 10
    return {
      drawCalls: r.calls,
      triangles: r.triangles,
      qScale: round(qScale),
      frameMs: { p50: round(at(0.5)), p95: round(at(0.95)), max: round(s[s.length - 1] || 0), n: s.length },
      fps: round(1000 / Math.max(0.001, at(0.5))),
      ...(battle ? battle.debugPerf() : {}),
    }
  },
  // オンライン対戦Phase0検証: LoopbackTransportでNetInputを送り、RemoteCommanderが
  // 受信入力で前進/発砲するか(=ネットコードの土台が機能するか)をローカルで確認する。
  netSelfTest() {
    if (!battle) return { err: 'バトル未開始(先に startBattle)' }
    const b = battle
    const combat = (b as any).combat as Combat
    const remote = new RemoteCommander(b.world, combat, sfx, CHARACTERS[0], 'red', new THREE.Vector3(0, 0, 6))
    b.world.addUnit(remote)
    const [host, client] = LoopbackTransport.pair(0)
    remote.attach(host)
    let seq = 0
    const send = (ni: Partial<NetInput>) =>
      client.send('input', { seq: ++seq, mx: 0, mz: 0, yaw: 0, pitch: 0, fire: false, charge: false, jump: false, zoom: false, ...ni })
    const startPos = remote.pos.clone()
    let maxBolts = 0
    for (let f = 0; f < 30; f++) { send({ mz: 1, fire: true }); remote.update(1 / 60); maxBolts = Math.max(maxBolts, combat.boltCount) }
    const movedDist = remote.pos.distanceTo(startPos)
    const afterMove = remote.pos.clone()
    for (let f = 0; f < 60; f++) { send({ mz: 0, fire: false }); remote.update(1 / 60) }
    const idleDrift = remote.pos.distanceTo(afterMove)
    remote.alive = false
    b.world.removeUnit(remote)
    return {
      moved_forward_m: +movedDist.toFixed(2), // 受信入力で前進したか(>0期待)
      fired_bolts: maxBolts, // 受信fireで発射したか(>0期待)
      idle_drift_m: +idleDrift.toFixed(2), // 入力停止で慣性減衰し停止したか(小さい値期待)
      ok: movedDist > 1 && maxBolts > 0,
    }
  },
  // PvP Phase1検証: 同一ページでWebRTC host+joinをブローカー経由で接続し、hello交換を確認。
  // 結果は window.__netTestResult に格納(非同期のためポーリングで読む)。
  netConnectTest() {
    ;(window as any).__netTestResult = { status: 'running' }
    const fin = (r: any) => { (window as any).__netTestResult = r }
    const { transport: h, ready } = WebRtcTransport.host()
    let hostGotHello = false
    let clientGotHello = false
    h.onMessage((ch, d: any) => { if (ch === 'event' && d && d.hello) hostGotHello = true })
    const killer = setTimeout(() => { try { h.close() } catch {} fin({ status: 'timeout' }) }, 15000)
    ready.then((code: string) => {
      const { transport: c, connected } = WebRtcTransport.join(code)
      c.onMessage((ch, d: any) => { if (ch === 'event' && d && d.hello) clientGotHello = true })
      connected.then(() => {
        // 双方のチャネルが open になってから送る(実ロビーは各自のopenで送るのと同条件)
        setTimeout(() => {
          c.send('event', { hello: 'client' })
          h.send('event', { hello: 'host' })
        }, 400)
        setTimeout(() => {
          clearTimeout(killer)
          const r = { status: 'done', code, hostState: h.state, clientState: c.state, hostGotHello, clientGotHello, ok: h.state === 'open' && c.state === 'open' && hostGotHello && clientGotHello }
          try { c.close() } catch {} try { h.close() } catch {}
          fin(r)
        }, 1400)
      }).catch((e: any) => { clearTimeout(killer); fin({ status: 'join-failed', err: String(e) }) })
    }).catch((e: any) => { clearTimeout(killer); fin({ status: 'host-failed', err: String(e) }) })
    return 'started — poll window.__netTestResult'
  },
  // PvP Phase2検証: ループバックで host+client のBattleViewを作り、host sim→snapshot→client puppet を確認。
  netMatchTest() {
    const [h, c] = LoopbackTransport.pair(0)
    const noop = () => {}
    const host = new BattleView({ charKey: 'renji', botLevel: 6, practice: false, mapKey: 'skyhaven' }, noop, { transport: h, role: 'host', oppCharKey: 'mimi' })
    const client = new BattleView({ charKey: 'mimi', botLevel: 6, practice: false, mapKey: 'skyhaven' }, noop, { transport: c, role: 'client', oppCharKey: 'renji' })
    // ホスト青将を動かし(puppet追従)＋自機(赤)HPを削る(HPバー/被弾演出の確認)。青将HPはループ中に削る(下記)。
    host.player.pos.set(5, 0, 10); host.player.group.position.copy(host.player.pos)
    host.bot.hp = 70 // client視点では自機(赤)被弾→onDamaged/dmgTaken
    let snapsSeen = 0
    const origIngest = (client as any).puppets.ingest.bind((client as any).puppets)
    ;(client as any).puppets.ingest = (s: any) => { snapsSeen++; origIngest(s) }
    // ホスト青将が発射→onFireで中継→クライアントが視覚弾を再生するか
    const hc = (host as any).combat
    const cc = (client as any).combat
    let fireEvents = 0
    const origFB = cc.fireBolt.bind(cc)
    cc.fireBolt = (o: any, d: any, opts: any) => { if (opts && opts.visual) fireEvents++; return origFB(o, d, opts) }
    let peakClientBolts = 0
    for (let f = 0; f < 40; f++) {
      if (f % 4 === 0) hc.fireBolt(new THREE.Vector3(2, 1.5, 9), new THREE.Vector3(0.1, 0.2, 1), { damage: 10, team: 'blue', from: host.player, speed: 130, size: 0.09 })
      if (f % 6 === 0 && host.player.hp > 25) host.player.hp -= 8 // 青将を徐々に削る→client視点で相手被弾→ヒットマーカー/dmgDealt
      host.update(1 / 60); client.update(1 / 60)
      peakClientBolts = Math.max(peakClientBolts, cc.boltCount)
    }
    const clientVisualBolts = fireEvents // クライアントが視覚弾として再生した発射数
    // 配備同期: クライアントが配備要求→ホストが赤陣トークンを権威spawn
    const hostRedTokBefore = host.world.units.filter((u) => u.team === 'red' && !u.isCommander).length
    c.send('event', { type: 'deploy', key: 'gunner', x: 0, z: -5 })
    for (let f = 0; f < 12; f++) { host.update(1 / 60); client.update(1 / 60) }
    const deploySpawnedToken = host.world.units.filter((u) => u.team === 'red' && !u.isCommander).length > hostRedTokBefore
    // 自軍(赤)トークン弾の中継: クライアントが配備した赤トークンの発射も相手(ホスト)→クライアントへ中継され視覚弾になる
    const redTok = host.world.units.find((u) => u.team === 'red' && !u.isCommander)
    const relayBefore = fireEvents
    if (redTok) hc.fireBolt(redTok.group.position.clone(), new THREE.Vector3(0, 0, 1), { damage: 10, team: 'red', from: redTok, speed: 130, size: 0.09 })
    for (let f = 0; f < 6; f++) { host.update(1 / 60); client.update(1 / 60) }
    const redTokenBoltRelayed = fireEvents > relayBefore
    // 自機将(クライアント本人=RemoteCommander)の弾は中継しない(クライアント側でローカル予測描画→二重描画回避)
    const ownBefore = fireEvents
    hc.fireBolt(new THREE.Vector3(0, 1.5, 0), new THREE.Vector3(0, 0, 1), { damage: 10, team: 'red', from: host.bot, speed: 130, size: 0.09 })
    for (let f = 0; f < 6; f++) { host.update(1 / 60); client.update(1 / 60) }
    const ownCommanderBoltNotRelayed = fireEvents === ownBefore
    // スキル同期: クライアントがスキル発動→ホストのRemoteCommanderが権威適用(skillCdが立つ)
    c.send('event', { type: 'skill' })
    for (let f = 0; f < 4; f++) { host.update(1 / 60); client.update(1 / 60) }
    const skillActivated = (host.bot as any).skillCd > 0
    // スフィア確保フィードバック(client側): ホストで中央を赤(=client自分)が確保→clientが「確保!」バナーを鳴らす
    let clientSphereBanner: any = null
    const origKB = (client as any).hud.killBanner.bind((client as any).hud)
    ;(client as any).hud.killBanner = (msg: string, good: boolean) => { clientSphereBanner = { msg, good }; return origKB(msg, good) }
    ;(host as any).objectives.center.charge = -0.9 // 中央を赤(client)が確保した状態に
    for (let f = 0; f < 8; f++) { host.update(1 / 60); client.update(1 / 60) }
    ;(client as any).hud.killBanner = origKB
    const clientSphereCaptureFeedback = !!clientSphereBanner && /確保/.test(clientSphereBanner.msg) && clientSphereBanner.good === true
    // momentum指標(client): blueがリード=red(client本人)が劣勢→client側で tpRegenMul が上がりHUDのmomentumが点灯する
    ;(host as any).objectives.count.blue = 5
    for (let f = 0; f < 6; f++) { host.update(1 / 60); client.update(1 / 60) }
    const clientMomentumWhenBehind = (client as any).player.tpRegenMul > 1
    ;(host as any).objectives.count.blue = 0 // スコアを同点に戻す(後続のサドンデス検証は同点が前提=非同点だとhostが即finishする)
    for (let f = 0; f < 4; f++) { host.update(1 / 60); client.update(1 / 60) }
    // 死亡/リスポーンのクライアントHUD: ホストでclient将(RemoteCommander赤)を死亡→clientにリスポーンカウントダウン、復帰でクリア
    ;(host.bot as any).alive = false
    for (let f = 0; f < 6; f++) { host.update(1 / 60); client.update(1 / 60) }
    const clientDeathCountdown = (client as any).clientDeadCountdown > 0 // 死亡中にカウントダウンが出る(true期待)
    ;(host.bot as any).alive = true
    for (let f = 0; f < 6; f++) { host.update(1 / 60); client.update(1 / 60) }
    const clientRespawnCleared = (client as any).clientDeadCountdown === null && client.player.alive // 復帰でクリア+生存(true期待)
    // サドンデス同期: ホストがサドンデス突入→snapshot.sd→クライアントもsuddenDeath化(HUDのSD表示・告知)
    ;(host as any).suddenDeath = true
    for (let f = 0; f < 8; f++) { host.update(1 / 60); client.update(1 / 60) }
    const suddenDeathSynced = (client as any).suddenDeath === true
    // マッチ終了同期: ホストの終了通知(占領達成/時間切れ等)→クライアントも確定スコアで終了
    // 併せて勝敗ジングルの視点を検証: client=赤で blue30>red5 は敗北→finish()は'lose'を鳴らすべき
    // (旧実装はblue視点固定で'win'が鳴り勝敗の音が逆転していた)。bgm.jingleを一時フックして捕捉。
    let clientEndJingle: string | null = null
    const origJingle = (bgm as any).jingle.bind(bgm)
    ;(bgm as any).jingle = (k: string) => { clientEndJingle = k; return origJingle(k) }
    h.send('event', { type: 'matchEnd', score: [30, 5] })
    for (let f = 0; f < 4; f++) { host.update(1 / 60); client.update(1 / 60) }
    ;(bgm as any).jingle = origJingle
    const matchEndSynced = client.over === true && client.scores.blue === 30
    const clientLossPerspective = clientEndJingle === 'lose' // 自陣(赤)視点で敗北の音が鳴る(true期待)
    // クライアントのpuppet群(ホストの青将renji等)の位置を取得
    const pm = (client as any).puppets
    const puppetCount = (pm as any).puppets.size
    // ホスト青将に対応するpuppetの位置(クライアント視点で敵=青将)
    let bluePuppetPos: any = null
    let bluePuppetHp: any = null
    for (const [, p] of (pm as any).puppets) { bluePuppetPos = { x: +p.group.position.x.toFixed(1), z: +p.group.position.z.toFixed(1) }; bluePuppetHp = { hp: p.hp, mhp: p.mhp }; break }
    const r = {
      snapsReceived: snapsSeen,
      clientPuppetCount: puppetCount,
      hostBluePos: { x: 5, z: 10 },
      aBluePuppetPos: bluePuppetPos,
      aBluePuppetHp: bluePuppetHp, // {hp:60, mhp:115}期待(ホストで削ったHPがpuppetに同期)
      clientScores: client.scores,
      hostScores: host.scores,
      clientPlayerTeam: client.player.team,
      clientVisualBolts, // ホスト発射が視覚弾としてクライアントに再生された数(>0期待)
      peakClientBolts, // 同時に飛んでいたクライアント視覚弾のピーク
      deploySpawnedToken, // クライアント配備要求→ホストがトークンspawn(true期待)
      redTokenBoltRelayed, // 自軍(赤)トークンの弾も相手画面に中継される(true期待)
      ownCommanderBoltNotRelayed, // 自機将の弾は中継しない=二重描画回避(true期待)
      skillActivated, // クライアントのスキル発動→ホストが権威適用(true期待)
      clientSphereCaptureFeedback, // クライアントがスフィア確保時にバナー/SEを鳴らす(true期待)
      clientMomentumWhenBehind, // 劣勢時にmomentum指標が点灯(client tpRegenMul>1, true期待)
      clientDeathCountdown, // 死亡中にリスポーンカウントダウンがHUDに出る(true期待)
      clientRespawnCleared, // 復帰でカウントダウンがクリアされ生存(true期待)
      suddenDeathSynced, // ホストのサドンデス→snapshot.sd→クライアントも同期(true期待)
      matchEndSynced, // ホストの終了通知→クライアントも終了(true期待)
      clientLossPerspective, // 自陣(赤)視点で敗北ジングルが鳴る=勝敗の音が逆転しない(true期待)
      clientCombatFeedback: { dealt: Math.round(client.stats.dmgDealt), taken: Math.round(client.stats.dmgTaken) }, // 相手被弾→dealt, 自機被弾→taken(両>0期待)
      ok: snapsSeen > 0 && puppetCount > 0 && clientVisualBolts > 0 && deploySpawnedToken && redTokenBoltRelayed && ownCommanderBoltNotRelayed && skillActivated && clientSphereCaptureFeedback && clientMomentumWhenBehind && clientDeathCountdown && clientRespawnCleared && suddenDeathSynced && matchEndSynced && clientLossPerspective && client.stats.dmgDealt > 0 && client.stats.dmgTaken > 0,
    } as any
    // 切断ハンドリング検証: クライアント切断→両者のマッチがover(フリーズしない)
    c.close()
    for (let f = 0; f < 5; f++) { host.update(1 / 60); client.update(1 / 60) }
    r.disconnectEndsMatch = host.over && client.over
    r.ok = r.ok && r.disconnectEndsMatch
    host.dispose(); client.dispose()
    return r
  },
  // PvP遅延/ジッタ耐性検証: 片道latencyMs+片側ジッタjitterMs(到着のバースト化=実DataChannelのhead-of-line)の
  // 決定的ループバックで host→client を回し、競技回線で ①例外/NaNが出ない ②相手将puppetが連続的に動く
  // (凍結/瞬間移動なし=補間が効く) ③遅延下でも発射が中継される ④自機被弾HPが同期する を確認する。
  // 既定は 80ms+ジッタ30ms(良好な実回線相当)。実時間setTimeoutではなく論理クロック(advance)で決定的に再生。
  netLagTest(latencyMs = 80, jitterMs = 30) {
    const [h, c] = LoopbackTransport.pair(latencyMs, true, jitterMs)
    const noop = () => {}
    const host = new BattleView({ charKey: 'renji', botLevel: 6, practice: false, mapKey: 'skyhaven' }, noop, { transport: h, role: 'host', oppCharKey: 'mimi' })
    const client = new BattleView({ charKey: 'mimi', botLevel: 6, practice: false, mapKey: 'skyhaven' }, noop, { transport: c, role: 'client', oppCharKey: 'renji' })
    const hc = (host as any).combat
    const cc = (client as any).combat
    let fireEvents = 0
    const origFB = cc.fireBolt.bind(cc)
    cc.fireBolt = (o: any, d: any, opts: any) => { if (opts && opts.visual) fireEvents++; return origFB(o, d, opts) }
    const pm = (client as any).puppets
    let ingestCount = 0
    const origIng = pm.ingest.bind(pm)
    pm.ingest = (s: any) => { ingestCount++; origIng(s) }
    let nanSeen = false
    let maxJump = 0      // 青将puppetの1フレーム水平移動量の最大(瞬間移動=補間破綻の検出)
    let frozenFrames = 0 // バッファ充填後にpuppetがほぼ動かなかったフレーム数(凍結=バッファ枯渇の検出)
    let prev: { x: number; z: number } | null = null
    const blueId = host.player.id // 青将(ホスト本人)のid。これに対応するpuppetだけを追う
    // スポーン周辺の開けた地面で半径2の円運動させる(マップのコライダーに当たらない=サンプルが連続)。
    // 角速度2rad/s → 周速4u/s ≒ 0.067u/frame。連続運動なので補間が効けば1frジャンプは小さい。
    const cx = host.world.basePos.blue.x, cy = host.world.basePos.blue.y, cz = host.world.basePos.blue.z
    const dtMs = 1000 / 60
    for (let f = 0; f < 300; f++) {
      const t = f / 60
      host.player.pos.set(cx + Math.sin(t * 2) * 2, cy, cz + Math.cos(t * 2) * 2)
      if (f % 12 === 0) hc.fireBolt(host.player.pos.clone(), new THREE.Vector3(0, 0.1, 1), { damage: 8, team: 'blue', from: host.player, speed: 130, size: 0.09 })
      if (f % 60 === 0 && host.bot.hp > 30) host.bot.hp -= 15 // client視点で自機(赤)被弾→HP同期(遅延下でも届く)
      host.update(1 / 60); client.update(1 / 60)
      h.advance(dtMs); c.advance(dtMs)
      const bp = (pm as any).puppets.get(blueId)
      const pp: any = bp ? bp.group.position : null
      if (pp) {
        if (isNaN(pp.x) || isNaN(pp.z)) nanSeen = true
        if (prev && f > 60) { // 補間バッファが溜まった後のみ評価
          const jump = Math.hypot(pp.x - prev.x, pp.z - prev.z)
          if (jump > maxJump) maxJump = jump
          if (jump < 1e-4) frozenFrames++
        }
        prev = { x: pp.x, z: pp.z }
      }
    }
    const r: any = {
      latencyMs,
      jitterMs,
      noNaN: !nanSeen,
      maxPuppetJumpPerFrame: +maxJump.toFixed(3), // 連続運動→小さいはず(<1.0期待)。瞬間移動があれば跳ねる
      frozenFrames,                               // 補間が効けば0〜少数。多ければバッファ枯渇=凍結
      ingestCount,                                // 受信スナップショット数(5s×20Hz≒100期待。激減なら送信側の問題)
      smoothUnderLatency: maxJump < 0.5 && frozenFrames < 20,
      relayedUnderLatency: fireEvents > 0,        // 遅延下でも発射が中継・再生された
      clientTookDamage: client.stats.dmgTaken > 0, // 遅延下でも自機被弾HPが同期した
    }
    r.ok = r.noNaN && r.smoothUnderLatency && r.relayedUnderLatency && r.clientTookDamage
    host.dispose(); client.dispose()
    return r
  },
  // PvP自機予測の精度検証: クライアントの自機はローカル予測(PlayerCommander)、ホストは権威(RemoteCommander)。
  // 両者は同一移動モデルだが、ホストは入力を遅延後に適用する分だけ遅れる。その「予測ズレ」が
  // スナップ補正閾値(3m)を大きく下回る=滑らかに一致し続けることを確認する(下回れば補正は発火しない=予測が良好)。
  // 入力はモジュールグローバル`input`を一時操作して駆動し、終了時に必ず復元する。
  netPredictTest(latencyMs = 80, jitterMs = 30) {
    const [h, c] = LoopbackTransport.pair(latencyMs, true, jitterMs)
    const noop = () => {}
    const host = new BattleView({ charKey: 'renji', botLevel: 6, practice: false, mapKey: 'skyhaven' }, noop, { transport: h, role: 'host', oppCharKey: 'mimi' })
    const client = new BattleView({ charKey: 'mimi', botLevel: 6, practice: false, mapKey: 'skyhaven' }, noop, { transport: c, role: 'client', oppCharKey: 'renji' })
    // 自機(client赤)とホスト権威(host.bot=RemoteCommander赤)を同じ赤スポーンに揃える
    const sp = host.world.basePos.red
    const hb = host.bot as any // host時は RemoteCommander(.pos を持つ)
    hb.pos.copy(sp); hb.group.position.copy(sp)
    client.player.pos.copy(client.world.basePos.red)
    const savedKeys = [...input.keys] // グローバル入力の復元用
    const dtMs = 1000 / 60
    let maxDrift = 0, finalDrift = 0, nanSeen = false, snapWouldFire = 0, samples = 0
    try {
      for (let f = 0; f < 300; f++) {
        // 計測は「補正前」の予測ズレ(前フレーム終端の予測位置 vs 権威位置)。f>40で定常化後を見る。
        if (f > 40) {
          const cp = client.player.pos, ap = host.bot.group.position
          const drift = Math.hypot(cp.x - ap.x, cp.z - ap.z)
          if (isNaN(drift)) nanSeen = true
          maxDrift = Math.max(maxDrift, drift); finalDrift = drift; samples++
          if (drift > 3) snapWouldFire++ // 補正(3m超でスナップ)が発火する状況の回数
        }
        // 入力パターン: スポーン近傍の開けた地面で前後・左右に小さく往復(壁/コライダーを避ける)。yawは緩く振る。
        input.keys.clear()
        if ((f % 80) < 40) input.keys.add('KeyW'); else input.keys.add('KeyS')
        if ((f % 120) < 60) input.keys.add('KeyD'); else input.keys.add('KeyA')
        client.player.yaw = Math.sin(f / 90) * 0.4 // 緩い旋回(±0.4rad)。振幅小=往復範囲が狭く開けた範囲に留まる
        host.update(1 / 60); client.update(1 / 60)
        h.advance(dtMs); c.advance(dtMs)
      }
    } finally {
      input.keys.clear(); for (const k of savedKeys) input.keys.add(k) // グローバル入力を必ず復元
    }
    const r: any = {
      latencyMs,
      jitterMs,
      maxDriftM: +maxDrift.toFixed(3),     // 予測位置と権威位置の最大ズレ(m)。速度6×(遅延+α)程度に収まるはず(<1.5期待)
      finalDriftM: +finalDrift.toFixed(3),
      snapWouldFire,                       // 3m超スナップ補正が起きた回数(予測良好なら0期待)
      samples,
      noNaN: !nanSeen,
      // 予測が締まっている: ズレがスナップ閾値3mを大きく下回り、補正が一度も要らない
      predictionTight: !nanSeen && maxDrift < 1.5 && snapWouldFire === 0,
    }
    r.ok = r.predictionTight
    host.dispose(); client.dispose()
    return r
  },
  // PvP一時停止の凍結回避検証: オンラインではポインタ解除("一時停止")でも update が早期returnせず、
  // snapshot適用/入力送信を続ける(=対戦が凍結しない)ことを確認。オフラインは従来どおり凍結する。
  netNoPauseFreeze() {
    const [h, c] = LoopbackTransport.pair(0, true)
    const noop = () => {}
    const host = new BattleView({ charKey: 'renji', botLevel: 6, practice: false, mapKey: 'skyhaven' }, noop, { transport: h, role: 'host', oppCharKey: 'mimi' })
    const client = new BattleView({ charKey: 'mimi', botLevel: 6, practice: false, mapKey: 'skyhaven' }, noop, { transport: c, role: 'client', oppCharKey: 'renji' })
    const pm = (client as any).puppets
    let ing = 0
    const origIng = pm.ingest.bind(pm)
    pm.ingest = (s: any) => { ing++; origIng(s) }
    const savedLocked = input.locked
    const dtMs = 1000 / 60
    let ingestedWhilePaused = 0, hostAdvanced = false
    try {
      // ウォームアップ(通常状態=ロック中: paused にならない)で接続+puppet生成
      input.locked = true; client.everLocked = true
      for (let f = 0; f < 30; f++) { host.update(1 / 60); client.update(1 / 60); h.advance(dtMs); c.advance(dtMs) }
      // 「一時停止」を模擬: ポインタ解除(locked=false)。client は everLocked && !locked で paused 状態になる。
      input.locked = false
      const ingBefore = ing
      const hostTimerStart = host.timer
      for (let f = 0; f < 60; f++) { host.update(1 / 60); client.update(1 / 60); h.advance(dtMs); c.advance(dtMs) }
      ingestedWhilePaused = ing - ingBefore // 一時停止中もsnapshotを取り込み続けたか(オンライン=凍結しない→>0期待)
      hostAdvanced = hostTimerStart - host.timer > 0.5 // ホスト権威simが進んだ(タイマー減少)
    } finally {
      input.locked = savedLocked
    }
    const r: any = {
      ingestedWhilePaused,
      hostAdvanced,
      ok: ingestedWhilePaused > 0 && hostAdvanced, // 一時停止中も同期が流れ、対戦が進行している
    }
    host.dispose(); client.dispose()
    return r
  },
  // PvP持続的整合性(soak)検証: 遅延+ジッタ下で host+client を長時間(既定30s分=1800f)回し、
  // 経時バグ(同期ズレの蓄積/NaN/ユニット・puppetのリーク/例外)が無いことを通しで確認する総仕上げテスト。
  // ホストのスコアを段階的に増やしてスコア同期経路も持続負荷下で検証。入力はグローバルを一時操作し必ず復元。
  netSoakTest(latencyMs = 60, jitterMs = 30, frames = 1800) {
    const [h, c] = LoopbackTransport.pair(latencyMs, true, jitterMs)
    const noop = () => {}
    const host = new BattleView({ charKey: 'renji', botLevel: 6, practice: false, mapKey: 'skyhaven' }, noop, { transport: h, role: 'host', oppCharKey: 'mimi' })
    const client = new BattleView({ charKey: 'mimi', botLevel: 6, practice: false, mapKey: 'skyhaven' }, noop, { transport: c, role: 'client', oppCharKey: 'renji' })
    const pm = (client as any).puppets
    let ingestCount = 0
    const origIng = pm.ingest.bind(pm)
    pm.ingest = (s: any) => { ingestCount++; origIng(s) }
    const startUnits = host.world.units.length
    let nanSeen = false, maxScoreDiv = 0, maxTimerDiv = 0, maxUnits = startUnits, maxPuppets = 0
    const savedKeys = [...input.keys]
    const dtMs = 1000 / 60
    try {
      for (let f = 0; f < frames; f++) {
        // 入力: スポーン近傍の開けた地面で小さく往復+時々発砲(戦闘負荷)。yawは緩く旋回。
        input.keys.clear()
        if ((f % 80) < 40) input.keys.add('KeyW'); else input.keys.add('KeyS')
        if ((f % 140) < 70) input.keys.add('KeyD'); else input.keys.add('KeyA')
        input.mouseDown = (f % 30) < 6 // 散発的に発砲
        client.player.yaw = Math.sin(f / 110) * 0.4
        // ホストの占領カウント(権威の蓄積元。scoresはここからfloorで導出される)を段階的に増やして占領を模擬。
        // CAPTURE_TO_WIN=30未満に留めて途中終了を避ける。
        if (f > 0 && f % 240 === 0) {
          const oc = (host as any).objectives.count
          oc.blue = Math.min(8, Math.floor(oc.blue) + 1)
          if (f % 480 === 0) oc.red = Math.min(6, Math.floor(oc.red) + 1)
        }
        host.update(1 / 60); client.update(1 / 60)
        h.advance(dtMs); c.advance(dtMs)
        if (f > 60) { // 定常化後に整合性を計測(クライアントは~遅延分だけ遅れて追従)
          const cp = client.player.pos
          if (isNaN(cp.x) || isNaN(cp.z)) nanSeen = true
          const sd = Math.abs(client.scores.blue - host.scores.blue) + Math.abs(client.scores.red - host.scores.red)
          maxScoreDiv = Math.max(maxScoreDiv, sd)
          maxTimerDiv = Math.max(maxTimerDiv, Math.abs(client.timer - host.timer))
          maxUnits = Math.max(maxUnits, host.world.units.length)
          maxPuppets = Math.max(maxPuppets, (pm as any).puppets.size)
        }
      }
    } finally {
      input.mouseDown = false
      input.keys.clear(); for (const k of savedKeys) input.keys.add(k)
    }
    const r: any = {
      frames, latencyMs, jitterMs,
      noNaN: !nanSeen,
      maxScoreDiv,                                 // スコア同期のズレ最大(遅延分のみ=小。≤2期待。増え続けるなら同期破綻)
      maxTimerDivS: +maxTimerDiv.toFixed(3),       // タイマー同期のズレ最大(s)。遅延+1スナップ間隔程度(<0.5期待)
      ingestCount,                                 // 受信スナップショット数(frames/3≒20Hz相当。途切れなく流れたか)
      unitLeak: maxUnits - startUnits,             // ユニット数の増分(配備していないので0期待=リーク無し)
      maxPuppets,                                  // クライアントpuppet数の最大(青将のみ=1期待。増殖=削除漏れ)
      finalScores: { host: { ...host.scores }, client: { ...client.scores } },
      // 通しで安定: NaN無し・スコア/タイマーのズレが遅延相当に収まる・リーク無し・puppet増殖無し
      stable: !nanSeen && maxScoreDiv <= 2 && maxTimerDiv < 0.5 && (maxUnits - startUnits) === 0 && maxPuppets <= 1,
    }
    r.ok = r.stable && ingestCount > frames / 6 // スナップショットが継続して流れている
    host.dispose(); client.dispose()
    return r
  },
  // 接続タイムアウト検証(手動プローブ): 無効な部屋コードへ短いタイムアウトで参加し、無限スピナーにならず
  // 必ず reject する(timeout か peer-unavailable)ことを確認。実PeerJSブローカーへ繋ぐためネットワーク必須=okスイート外。
  netTimeoutProbe(timeoutMs = 2500) {
    const t0 = performance.now()
    const { connected } = WebRtcTransport.join('tw-nonexistent-room-zzz', timeoutMs)
    return connected.then(
      () => ({ rejected: false, note: '予期せず接続成功(無効コードのはず)' }),
      (e: any) => ({ rejected: true, reason: (e && (e.type || e.message)) || 'unknown', ms: Math.round(performance.now() - t0) }),
    )
  },
  // PvP実トランスポート検証(手動プローブ): netMatchTest相当のフル同期(snapshot/発射event/score/HP/sphere/skill/
  // 死亡復帰/サドンデス/matchEnd/切断)を、Loopbackではなく『実WebRtcTransport×同一ページ2ピア×生PeerJSブローカー
  // ×DataChannel』で回す。Loopbackでは原理的に出ない実トランスポート固有の4系統(①非同期配送 ②BinaryPack
  // シリアライズ[undefined脱落/数値round-trip] ③state==='open'前のsend欠落 ④単一onMessageの後勝ち=ロビー→
  // BattleView引き継ぎ順序)を捕捉する。非同期=結果は window.__netTestResultRTC にポーリング可能な形で書く。要ネット。
  netMatchTestRTC() {
    ;(window as any).__netTestResultRTC = { status: 'running' }
    const fin = (r: any) => { (window as any).__netTestResultRTC = r }
    const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms))
    const tick = async (frames: number, host: any, client: any, h: any, c: any, gapMs = 16) => {
      for (let i = 0; i < frames; i++) {
        if (h.state !== 'open' && c.state !== 'open') break
        host.update(1 / 60); client.update(1 / 60)
        await sleep(gapMs) // 配送(マイクロタスク/イベントループ跨ぎ)を進める実時間ギャップ=Loopbackと違い必須
      }
    }
    const run = async () => {
      const { transport: h, ready } = WebRtcTransport.host()
      let host: any = null, client: any = null, killed = false, c: any = null
      const killer = setTimeout(() => {
        killed = true
        try { client?.dispose() } catch {} try { host?.dispose() } catch {}
        try { h.close() } catch {}
        if ((window as any).__netTestResultRTC?.status === 'running') fin({ status: 'timeout' })
      }, 45000)
      try {
        const code = await ready
        const joined = WebRtcTransport.join(code); c = joined.transport
        await joined.connected
        for (let w = 0; w < 100 && !(h.state === 'open' && c.state === 'open'); w++) await sleep(20)
        const bothOpen = h.state === 'open' && c.state === 'open'
        // ④ 単一onMessage後勝ち + ロビー→BattleView引き継ぎの再現(BattleView生成前にhello交換)
        let hGotHello: string | null = null, cGotHello: string | null = null
        h.onMessage((ch: any, d: any) => { if (ch === 'event' && d && d.type === 'hello') hGotHello = d.ck })
        c.onMessage((ch: any, d: any) => { if (ch === 'event' && d && d.type === 'hello') cGotHello = d.ck })
        c.send('event', { type: 'hello', ck: 'mimi' })
        h.send('event', { type: 'hello', ck: 'renji' })
        for (let w = 0; w < 60 && !(hGotHello && cGotHello); w++) await sleep(20)
        const earlyHandshakeOk = hGotHello === 'mimi' && cGotHello === 'renji'
        const noop = () => {}
        host = new BattleView({ charKey: 'renji', botLevel: 6, practice: false, mapKey: 'skyhaven' }, noop, { transport: h, role: 'host', oppCharKey: hGotHello ?? 'mimi' })
        client = new BattleView({ charKey: 'mimi', botLevel: 6, practice: false, mapKey: 'skyhaven' }, noop, { transport: c, role: 'client', oppCharKey: cGotHello ?? 'renji' })
        let snapsSeen = 0
        const origIngest = (client as any).puppets.ingest.bind((client as any).puppets)
        ;(client as any).puppets.ingest = (s: any) => { snapsSeen++; origIngest(s) }
        const hc = (host as any).combat, cc = (client as any).combat
        let fireEvents = 0
        const origFB = cc.fireBolt.bind(cc)
        cc.fireBolt = (o: any, d: any, opts: any) => { if (opts && opts.visual) fireEvents++; return origFB(o, d, opts) }
        host.player.pos.set(5, 0, 10); host.player.group.position.copy(host.player.pos)
        host.bot.hp = 70
        // ① 非同期配送の観測: send直後『同一tick』ではpuppet未更新(Loopbackは同tick到達)
        const snapsBeforeOneTick = snapsSeen
        host.update(1 / 60)
        await sleep(120)
        client.update(1 / 60)
        const asyncDeliveryObserved = snapsSeen === snapsBeforeOneTick
        let peakClientBolts = 0
        for (let f = 0; f < 60; f++) {
          if (f % 4 === 0) hc.fireBolt(new THREE.Vector3(2, 1.5, 9), new THREE.Vector3(0.1, 0.2, 1), { damage: 10, team: 'blue', from: host.player, speed: 130, size: 0.09 })
          if (f % 6 === 0 && host.player.hp > 25) host.player.hp -= 8
          host.update(1 / 60); client.update(1 / 60)
          peakClientBolts = Math.max(peakClientBolts, cc.boltCount)
          await sleep(16)
        }
        const clientVisualBolts = fireEvents
        const hostRedTokBefore = host.world.units.filter((u: any) => u.team === 'red' && !u.isCommander).length
        c.send('event', { type: 'deploy', key: 'gunner', x: 0, z: -5 })
        await tick(20, host, client, h, c)
        const deploySpawnedToken = host.world.units.filter((u: any) => u.team === 'red' && !u.isCommander).length > hostRedTokBefore
        const redTok = host.world.units.find((u: any) => u.team === 'red' && !u.isCommander)
        const relayBefore = fireEvents
        if (redTok) hc.fireBolt(redTok.group.position.clone(), new THREE.Vector3(0, 0, 1), { damage: 10, team: 'red', from: redTok, speed: 130, size: 0.09 })
        await tick(12, host, client, h, c)
        const redTokenBoltRelayed = fireEvents > relayBefore
        const ownBefore = fireEvents
        hc.fireBolt(new THREE.Vector3(0, 1.5, 0), new THREE.Vector3(0, 0, 1), { damage: 10, team: 'red', from: host.bot, speed: 130, size: 0.09 })
        await tick(12, host, client, h, c)
        const ownCommanderBoltNotRelayed = fireEvents === ownBefore
        c.send('event', { type: 'skill' })
        await tick(10, host, client, h, c)
        const skillActivated = (host.bot as any).skillCd > 0
        let clientSphereBanner: any = null
        const origKB = (client as any).hud.killBanner.bind((client as any).hud)
        ;(client as any).hud.killBanner = (msg: string, good: boolean) => { clientSphereBanner = { msg, good }; return origKB(msg, good) }
        ;(host as any).objectives.center.charge = -0.9
        await tick(16, host, client, h, c)
        ;(client as any).hud.killBanner = origKB
        const clientSphereCaptureFeedback = !!clientSphereBanner && /確保/.test(clientSphereBanner.msg) && clientSphereBanner.good === true
        ;(host as any).objectives.count.blue = 5
        await tick(12, host, client, h, c)
        const clientMomentumWhenBehind = (client as any).player.tpRegenMul > 1
        ;(host as any).objectives.count.blue = 0
        await tick(8, host, client, h, c)
        ;(host.bot as any).alive = false
        await tick(12, host, client, h, c)
        const clientDeathCountdown = (client as any).clientDeadCountdown > 0
        ;(host.bot as any).alive = true
        await tick(12, host, client, h, c)
        const clientRespawnCleared = (client as any).clientDeadCountdown === null && client.player.alive
        ;(host as any).suddenDeath = true
        await tick(16, host, client, h, c)
        const suddenDeathSynced = (client as any).suddenDeath === true
        let clientEndJingle: string | null = null
        const origJingle = (bgm as any).jingle.bind(bgm)
        ;(bgm as any).jingle = (k: string) => { clientEndJingle = k; return origJingle(k) }
        h.send('event', { type: 'matchEnd', score: [30, 5] })
        await tick(10, host, client, h, c)
        ;(bgm as any).jingle = origJingle
        const matchEndSynced = client.over === true && client.scores.blue === 30
        const clientLossPerspective = clientEndJingle === 'lose'
        const pm = (client as any).puppets
        const puppetCount = (pm as any).puppets.size
        let bluePuppetHp: any = null
        for (const [, p] of (pm as any).puppets) { bluePuppetHp = { hp: p.hp, mhp: p.mhp }; break }
        const jsonRoundTripOk = !!bluePuppetHp && Number.isFinite(bluePuppetHp.hp) && bluePuppetHp.hp <= 70
        const r: any = {
          status: 'done',
          code, bothOpen, earlyHandshakeOk, asyncDeliveryObserved, jsonRoundTripOk,
          snapsReceived: snapsSeen, clientPuppetCount: puppetCount, aBluePuppetHp: bluePuppetHp,
          clientScores: client.scores, hostScores: host.scores, clientPlayerTeam: client.player.team,
          clientVisualBolts, peakClientBolts, deploySpawnedToken, redTokenBoltRelayed, ownCommanderBoltNotRelayed,
          skillActivated, clientSphereCaptureFeedback, clientMomentumWhenBehind, clientDeathCountdown,
          clientRespawnCleared, suddenDeathSynced, matchEndSynced, clientLossPerspective,
          clientCombatFeedback: { dealt: Math.round(client.stats.dmgDealt), taken: Math.round(client.stats.dmgTaken) },
          hostState: h.state, clientState: c.state,
        }
        r.ok = bothOpen && earlyHandshakeOk && asyncDeliveryObserved && jsonRoundTripOk &&
          snapsSeen > 0 && puppetCount > 0 && clientVisualBolts > 0 && deploySpawnedToken &&
          redTokenBoltRelayed && ownCommanderBoltNotRelayed && skillActivated &&
          clientSphereCaptureFeedback && clientMomentumWhenBehind && clientDeathCountdown &&
          clientRespawnCleared && suddenDeathSynced && matchEndSynced && clientLossPerspective &&
          client.stats.dmgDealt > 0 && client.stats.dmgTaken > 0
        try { c.close() } catch {}
        await tick(8, host, client, h, c)
        r.disconnectEndsMatch = host.over && client.over
        r.ok = r.ok && r.disconnectEndsMatch
        if (!killed) { clearTimeout(killer); fin(r) }
      } catch (e: any) {
        clearTimeout(killer)
        if (!killed) fin({ status: 'error', err: String(e && (e.message || e)), hostState: h.state, clientState: c?.state })
      } finally {
        try { client?.dispose() } catch {} try { host?.dispose() } catch {}
        try { c?.close() } catch {} try { h.close() } catch {}
      }
    }
    run()
    return 'started — poll window.__netTestResultRTC'
  },
  // クライアント側の描画を実機なしで目視する診断: ループバックでホストを駆動しつつ、本物の startBattle 経路で
  // クライアント(view)を描画する。相手将/トークンがpuppetとしてどう描画されるか screenshot で確認できる。
  // 停止: window.__rcStop = true。ホスト参照: window.__rcHost。
  renderClientMatch() {
    const [h, c] = LoopbackTransport.pair(30, false) // 実時間setTimeout遅延30ms(描画ループと同時に配送)
    const noop = () => {}
    const host = new BattleView({ charKey: 'renji', botLevel: 6, practice: false, mapKey: 'skyhaven' }, noop, { transport: h, role: 'host', oppCharKey: 'mimi' })
    ;(window as any).__rcHost = host
    ;(window as any).__rcStop = false
    startBattle('mimi', { transport: c, role: 'client', oppCharKey: 'renji' }) // view=client を描画ループが回す
    let f = 0
    const loop = () => {
      if ((window as any).__rcStop) return
      f++
      host.player.pos.set(Math.sin(f / 70) * 3, 0, 4 + Math.cos(f / 70) * 2) // 青将を中央付近で動かす(puppet追従が見える)
      host.player.group.position.copy(host.player.pos)
      if (f === 40) c.send('event', { type: 'deploy', key: 'gunner', x: 1.5, z: 3 }) // 赤トークンも配備→puppet
      host.update(1 / 60)
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
    return 'client rendering. window.__tw.battle=client. screenshotで相手将/トークンpuppetの描画を確認。__rcStop=trueで停止。'
  },
  // クライアントのpuppetモデル差し替え検証: 対戦開始時にGLB未ロードだと敵が箱(placeholder)になる不具合の修正確認。
  // ①存在しないckで生成→placeholder(箱) ②modelKeyを実在キーへ差し替え再ingest→tryUpgradeで本物(SkinnedMesh)へ。
  netPuppetUpgradeTest() {
    const scene = new THREE.Scene()
    const pm = new PuppetManager(scene)
    pm.setLocalCommanderTeam('red')
    const mkSnap = (ck: string): any => ({ t: 0, units: [{ id: 99, kind: 'commander', team: 'blue', ck, x: 0, y: 0, z: 0, yaw: 0, hp: 100, mhp: 100, alive: true }], spheres: [0, 0, 0], score: [0, 0], timer: 180 })
    pm.ingest(mkSnap('__nomodel__')) // GLB未ロード/未知キーを模擬→placeholder(箱)
    const p = (pm as any).puppets.get(99)
    const wasPlaceholder = p?.placeholder === true
    let boxBefore = false; p?.group.traverse((o: any) => { if (o.isMesh && !o.isSkinnedMesh && o.geometry?.type === 'BoxGeometry') boxBefore = true })
    p.modelKey = 'char_renji' // 実モデルが読めた状況を模擬(キーを実在のものへ)
    pm.ingest(mkSnap('__nomodel__')) // 同id再受信→else if(placeholder)→tryUpgradeで本物へ差し替え
    const upgraded = p.placeholder === false
    let skinnedAfter = false; p.group.traverse((o: any) => { if (o.isSkinnedMesh) skinnedAfter = true })
    pm.dispose()
    return { wasPlaceholder, boxBefore, upgraded, hasSkinnedMeshAfter: skinnedAfter, ok: wasPlaceholder && boxBefore && upgraded && skinnedAfter }
  },
}

// --- メインループ ---
const clock = new THREE.Clock()
// 動的解像度コントローラ: 0.5秒窓の平均フレーム時間を見て、重ければ解像度を下げ軽ければ戻す。
// 高性能機は常時フル、非力機は自動で軽くなり処理落ちを避ける(見た目より滑らかさを優先する局面のみ作動)。
let perfWin = 0, perfAcc = 0, perfN = 0, perfWarmup = 3
// 計測用フレーム時間リング(__tw.perf で p50/p95/max を読む)。打ち合い前後のスパイク有無を数値で確認するため
const frameMs: number[] = []
renderer.setAnimationLoop(() => {
  try {
    const dt = Math.min(0.05, clock.getDelta())
    frameMs.push(dt * 1000)
    if (frameMs.length > 180) frameMs.shift()
    renderer.info.reset() // フレーム先頭でreset→このフレームの全パスのdraw callが info.render に積算される
    view.update(dt)
    const th = (window as any).__topH as number | undefined
    if (th && battle) {
      const cam = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 1, 400)
      cam.up.set(0, 0, -1) // -Z(赤陣)を上に
      cam.position.set(0, th, 0.001)
      cam.lookAt(0, 0, 0)
      postfx.render(battle.world.scene, cam)
    } else {
      view.render()
    }
    input.endFrame()
    // --- 動的解像度 ---
    perfAcc += dt; perfN++; perfWin += dt
    if (perfWin >= 0.5) {
      const avgMs = (perfAcc / Math.max(1, perfN)) * 1000
      perfWin = 0; perfAcc = 0; perfN = 0
      if (perfWarmup > 0) { perfWarmup-- } // 起動直後のヒッチで誤判定しないよう数窓スキップ
      else {
        let nq = qScale
        if (avgMs > 21 && qScale > 0.6) nq = Math.max(0.6, qScale - 0.12)        // 約47fps未満→下げる
        else if (avgMs < 13 && qScale < 1) nq = Math.min(1, qScale + 0.06)        // 約77fps超で余裕→戻す
        if (nq !== qScale) { qScale = nq; applyPixelRatio() }
      }
    }
  } catch (e) {
    console.error('[loop error]', e)
  }
})
