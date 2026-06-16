import { Peer, type DataConnection } from 'peerjs'
import type { NetTransport, NetChannel, NetRole, NetState } from './transport'

// WebRTC DataChannel トランスポート(PeerJS無償ブローカーでシグナリング)。NetTransportを実装し、
// LoopbackTransportと差し替え可能。ホストは部屋コード(=peer id)を発行、参加者はコードで接続する。
// GitHub Pages(静的)だけで動作し、サーバ常駐不要。設計は docs/NETCODE_DESIGN.md。

type IceServer = { urls: string | string[]; username?: string; credential?: string }

// 信頼できる無償の公開STUNサーバ群。複数列挙して1台障害時の冗長性とNAT越え成功率を高める。
// STUNは「自分の外側アドレス/ポートを教えてもらう」だけで、料金・認証不要・常駐サーバ不要。
const FREE_STUN_SERVERS: IceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:global.stun.twilio.com:3478' },
]

/**
 * Peerに渡すiceServers配列を構築する。基本は無償STUNのみ。
 * TURN差し込みスロット: 実行時 window.__twTurn か ビルド時定数(VITE_TW_TURN, JSON文字列)があれば末尾に連結する。
 * どちらも無ければ何も足さず無害にSTUNのみ返す(有償TURNはここでは同梱しない)。Symmetric NAT同士の越えにはTURNが要るが、
 * その認証情報はコミットせず実行時注入する設計(漏洩回避)。window.__twTurn は単一オブジェクト/配列どちらも受け付ける。
 *   例: window.__twTurn = { urls: 'turn:turn.example.com:3478', username: 'u', credential: 'p' }
 */
function buildIceServers(): IceServer[] {
  const servers: IceServer[] = [...FREE_STUN_SERVERS]
  const extra: IceServer[] = []
  // (a) 実行時注入スロット: window.__twTurn
  try {
    const w = typeof window !== 'undefined' ? (window as any).__twTurn : undefined
    if (Array.isArray(w)) extra.push(...w)
    else if (w && typeof w === 'object') extra.push(w)
  } catch { /* window未定義等は無害にスキップ */ }
  // (b) ビルド時定数スロット: VITE_TW_TURN(TURN設定のJSON文字列)。未設定/不正は無害にスキップ。
  try {
    const raw = (import.meta as any)?.env?.VITE_TW_TURN
    if (typeof raw === 'string' && raw.trim()) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) extra.push(...parsed)
      else if (parsed && typeof parsed === 'object') extra.push(parsed)
    }
  } catch { /* 未設定/不正JSONは無害にスキップ */ }
  // urls を持つ有効なエントリだけ採用(壊れた注入で接続自体を壊さない)
  for (const e of extra) {
    if (e && (typeof e.urls === 'string' ? e.urls : Array.isArray(e.urls) && e.urls.length)) servers.push(e)
  }
  return servers
}

export class WebRtcTransport implements NetTransport {
  readonly role: NetRole
  state: NetState = 'idle'
  roomCode = ''
  private peer: Peer | null = null
  private conn: DataConnection | null = null
  private msgCb: ((ch: NetChannel, data: any) => void) | null = null
  private stateCb: ((s: NetState) => void) | null = null
  private rcCancel: (() => void) | null = null // 現役reconnectバックオフの停止関数(破棄時にstale timerを残さない)

  private constructor(role: NetRole) {
    this.role = role
  }

  /**
   * ホストとして待受。ready は発行された部屋コード(=peer id)で解決する。
   * timeoutMs 以内にブローカーがid発行(=peer'open')しなければ失敗(回線/ブローカー不通の無限待ち防止)。
   * id発行後の「参加者を待つ」時間は設計上は無制限(ユーザーが待ちたいだけ待てる)。
   */
  static host(timeoutMs = 20000): { transport: WebRtcTransport; ready: Promise<string> } {
    const t = new WebRtcTransport('host')
    t.setState('connecting')
    let idIssued = false // 部屋コード発行済み(=待受開始)か。発行後の回線ゆらぎで部屋を破棄しないための判定
    const ready = new Promise<string>((resolve, reject) => {
      const peer = new Peer(undefined, { config: { iceServers: buildIceServers() } }) // 複数STUN+任意TURNでNAT越え強化。undefinedでid自動発行を維持
      t.peer = peer
      const timer = setTimeout(() => {
        if (!idIssued && t.state === 'connecting') { t.setState('failed'); t.cleanupPeer(); reject(new Error('timeout')) }
      }, timeoutMs)
      // 再接続は上限回数＋指数バックオフ付き(broker恒久不達/id衝突での無制限WSチャーン・電池消耗を防止)。
      // 待受中(connecting)に諦めたら部屋は参加者を受けられないので state='failed' でロビーへ失敗通知。
      // 参加者確立(state='open')後は broker不要なので canRetry が false になり自然に止まる。
      const rc = t.makeReconnector(peer, () => idIssued && t.state === 'connecting', () => { t.setState('failed'); t.cleanupPeer() })
      peer.on('open', (id) => { idIssued = true; rc.onOpen(); clearTimeout(timer); t.roomCode = id; resolve(id) }) // 部屋コード発行(待受開始)
      // 参加者が来たら接続を確立。既に対戦相手が居る(conn確立済み)場合の2人目は拒否=送信先(this.conn)の乗っ取りを防ぐ。
      peer.on('connection', (conn) => {
        if (t.conn) { try { conn.close() } catch { /* noop */ } return }
        t.bind(conn)
      })
      peer.on('error', (e) => {
        // id衝突(unavailable-id)は同idでの再接続が不可能なので即断念(待受中なら失敗通知)。
        if ((e as { type?: string })?.type === 'unavailable-id') rc.markFatal()
        // 部屋コード発行前(待受確立前)の error のみ致命=即reject。発行後(参加者待ち中)の network/socket-* は
        // 一時的な回線ゆらぎなので peer を破棄せず部屋を生かす(従来は無条件 destroy で部屋がサイレント死していた)。
        if (!idIssued) { clearTimeout(timer); t.setState('failed'); t.cleanupPeer(); reject(e) }
      })
      // 待受中にブローカーとのソケットが切れたら、同じidで(上限・バックオフ付きで)再接続を試み、
      // 遅れて来る参加者を受け入れられるよう部屋コードを生かす。
      peer.on('disconnected', rc.onDisconnected)
    })
    return { transport: t, ready }
  }

  /**
   * 部屋コードで参加。connected はDataChannelが開いたら解決する。
   * timeoutMs 以内に開かなければ失敗で reject(無効コード/相手不在/NAT到達不可で peerjs が沈黙し
   * 無限スピナーになる事故を防ぐ最重要の安全弁)。
   */
  static join(code: string, timeoutMs = 20000): { transport: WebRtcTransport; connected: Promise<void> } {
    const t = new WebRtcTransport('client')
    t.setState('connecting')
    const connected = new Promise<void>((resolve, reject) => {
      const peer = new Peer(undefined, { config: { iceServers: buildIceServers() } }) // 複数STUN+任意TURNでNAT越え強化。undefinedでid自動発行を維持
      t.peer = peer
      const timer = setTimeout(() => {
        if (t.state !== 'open') { t.setState('failed'); t.cleanupPeer(); reject(new Error('timeout')) }
      }, timeoutMs)
      const done = () => { clearTimeout(timer); resolve() }
      // 再接続は上限回数＋指数バックオフ付き(broker恒久不達/id衝突での無制限WSチャーン・電池消耗を防止)。
      // DataChannel確立(state='open')後のみ試行し、諦めても DataChannel が生きていれば対戦は継続(沈黙)。
      const rc = t.makeReconnector(peer, () => t.state === 'open', () => { /* DataChannel生存で対戦継続。broker再接続のみ断念 */ })
      // peer.connect は初回'open'の一度きり。良性のブローカーWS瞬断→peer.reconnect()→WS再オープンで
      // peer'open'が【再発火】するため、無ガードだと2本目のDataConnection(conn2)を張ってしまう。host側は
      // conn2を即closeする設計で、その遅延closeが bind()のclose時に this.conn=conn2 を null化+state='closed'
      // させ、生存中の健全なマッチ(conn1)をクライアント側だけ誤終了させていた(第7監査でclient reconnectを
      // 対称化した際の回帰)。ラッチで初回のみ接続し、reconnect後の'open'では既存connを維持する。
      let connectedOnce = false
      peer.on('open', () => {
        rc.onOpen() // broker再接続成功で再試行カウンタをリセット
        if (connectedOnce) return // reconnect後の'open'再発火: 既存DataChannelを維持し二重connectを抑止
        connectedOnce = true
        const conn = peer.connect(code, { reliable: true })
        t.bind(conn, done)
      })
      // 接続確立前(open前)の error のみ致命=reject。open後(対戦中)のブローカー由来 network/socket-* は握りつぶす
      // (host() line 85 と対称化。これが無いとブローカー一時エラーでクライアント側だけマッチが強制終了していた)。
      // open後の本当の切断は DataChannel の conn.on('close'/'error')(bind)が検知する。
      peer.on('error', (e) => {
        if ((e as { type?: string })?.type === 'unavailable-id') rc.markFatal() // id衝突は再接続不能=即断念
        if (t.state !== 'open') { clearTimeout(timer); t.setState('failed'); t.cleanupPeer(); reject(e) }
      })
      // open後にブローカーWSが切れても DataChannel を生かしたまま同idで(上限・バックオフ付きで)再接続を試みる(host側と対称)。
      peer.on('disconnected', rc.onDisconnected)
    })
    return { transport: t, connected }
  }

  /**
   * ブローカーWS切断時の再接続を「上限回数＋指数バックオフ」でスケジュールするヘルパを作る。
   * peerjs は WS が恒久不達/id衝突だと socket onclose→'disconnected' を延々と emit し、無ガードで
   * peer.reconnect() を呼ぶと new WebSocket を無制限に張り続ける(スロットルされないWSチャーン=電池/CPU浪費)。
   * - canRetry(): まだ再接続を試みるべき状況か(host=待受中, client=DataChannel生存中)。falseなら何もせず待機。
   * - onGiveUp(): 上限到達/致命エラー時の後始末(host=部屋を失敗扱い, client=沈黙して対戦継続)。
   * - onOpen(): broker再接続成功時に呼び、試行回数をリセットする。
   * - markFatal(): 再接続不能(unavailable-id 等)で即断念する。
   * peer が差し替わった(this.peer!==peer)/破棄後は自動的に停止する。
   */
  private makeReconnector(peer: Peer, canRetry: () => boolean, onGiveUp: () => void) {
    let tries = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let gaveUp = false
    const MAX = 6 // 500ms→…→8s で累計~23.5s 試行してから諦める
    const onDisconnected = () => {
      if (gaveUp || this.peer !== peer || !canRetry()) return
      if (tries >= MAX) { gaveUp = true; clearTimeout(timer); onGiveUp(); return }
      const delay = Math.min(500 * 2 ** tries, 8000)
      tries++
      clearTimeout(timer)
      timer = setTimeout(() => { if (!gaveUp && this.peer === peer && canRetry()) { try { peer.reconnect() } catch { /* noop */ } } }, delay)
    }
    const cancel = () => { gaveUp = true; clearTimeout(timer) } // 破棄時に再接続を完全停止(stale setTimeout根絶)
    this.rcCancel = cancel
    return {
      onDisconnected,
      onOpen: () => { tries = 0; clearTimeout(timer) },
      markFatal: () => { if (gaveUp) return; gaveUp = true; clearTimeout(timer); if (canRetry()) onGiveUp() },
      cancel,
    }
  }

  /** 失敗時にpeer/connを破棄(リーク・ゾンビ接続防止)。state は呼び出し側が設定済み。 */
  private cleanupPeer() {
    this.rcCancel?.() // 破棄前にreconnectバックオフを止める(destroyの同期'disconnected'再入でstale timerを残さない)
    try { this.conn?.close() } catch { /* noop */ }
    try { this.peer?.destroy() } catch { /* noop */ }
    this.conn = null
    this.peer = null
  }

  private bind(conn: DataConnection, onOpen?: () => void) {
    this.conn = conn
    conn.on('open', () => { this.setState('open'); onOpen?.() })
    conn.on('data', (d: any) => { if (d && typeof d === 'object' && d.ch) this.msgCb?.(d.ch as NetChannel, d.data) })
    // close/error時は「自分が現役connのときだけ」スロット解放＋state遷移する(setStateも必ずガード内に置く)。
    // これが無いと、open前に死んだ初回connの遅延close/errorが、後から確立した別connの対戦中に state を closed/failed へ
    // 落とし、onStateChangeが誤終了(ロビー強制退出/マッチ確定前終了)させる。同一性チェックで superseded conn の遅延
    // イベントは state を一切変えない。現役conn死亡時のみ null化+state遷移=2人目再受け入れ設計も維持。
    conn.on('close', () => { if (this.conn === conn) { this.conn = null; this.setState('closed') } })
    conn.on('error', () => { if (this.conn === conn) { this.conn = null; this.setState('failed') } })
  }

  send(ch: NetChannel, data: unknown): void {
    if (this.conn && this.state === 'open') this.conn.send({ ch, data })
  }

  onMessage(cb: (ch: NetChannel, data: any) => void): void {
    this.msgCb = cb
  }

  onStateChange(cb: (s: NetState) => void): void {
    this.stateCb = cb
    cb(this.state)
  }

  close(): void {
    // peer/conn の破棄は state に依らず常に行う(=孤立PeerJS Peer+ブローカーWSのリーク防止)。旧実装は
    // state==='closed' で即returnし peer.destroy() に到達せず、相手切断後の結果画面 close() でPeer/WSが累積リークしていた。
    // setState は冪等化済なので、conn.close() の同期'close'で先に setState('closed')が走ってもここは二重発火しない。
    this.rcCancel?.() // 破棄前にreconnectバックオフtimerを止める(destroyの同期'disconnected'再入でstale timerを残さない)
    try { this.conn?.close() } catch { /* noop */ }
    try { this.peer?.destroy() } catch { /* noop */ }
    this.conn = null
    this.peer = null
    this.setState('closed')
  }

  /** state に関わらず peer/conn を確実に破棄する(相手切断で既に state='closed' でも孤立Peer/WSを確実回収)。 */
  dispose(): void {
    this.rcCancel?.()
    try { this.conn?.close() } catch { /* noop */ }
    try { this.peer?.destroy() } catch { /* noop */ }
    this.conn = null
    this.peer = null
  }

  private setState(s: NetState) {
    if (this.state === s) return // 同一stateへの再遷移は通知しない=onStateChangeの二重発火(結果画面の二重finish/ロビー誤遷移)を全経路で根絶
    this.state = s
    this.stateCb?.(s)
  }
}
