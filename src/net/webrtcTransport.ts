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
    const ready = new Promise<string>((resolve, reject) => {
      const peer = new Peer(undefined, { config: { iceServers: buildIceServers() } }) // 複数STUN+任意TURNでNAT越え強化。undefinedでid自動発行を維持
      t.peer = peer
      const timer = setTimeout(() => {
        if (t.state === 'connecting') { t.setState('failed'); t.cleanupPeer(); reject(new Error('timeout')) }
      }, timeoutMs)
      peer.on('open', (id) => { clearTimeout(timer); t.roomCode = id; resolve(id) }) // 部屋コード発行(待受開始)
      peer.on('connection', (conn) => t.bind(conn)) // 参加者が来たら接続を確立
      peer.on('error', (e) => { clearTimeout(timer); t.setState('failed'); t.cleanupPeer(); reject(e) })
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
      peer.on('open', () => {
        const conn = peer.connect(code, { reliable: true })
        t.bind(conn, done)
      })
      peer.on('error', (e) => { clearTimeout(timer); t.setState('failed'); t.cleanupPeer(); reject(e) })
    })
    return { transport: t, connected }
  }

  /** 失敗時にpeer/connを破棄(リーク・ゾンビ接続防止)。state は呼び出し側が設定済み。 */
  private cleanupPeer() {
    try { this.conn?.close() } catch { /* noop */ }
    try { this.peer?.destroy() } catch { /* noop */ }
    this.conn = null
    this.peer = null
  }

  private bind(conn: DataConnection, onOpen?: () => void) {
    this.conn = conn
    conn.on('open', () => { this.setState('open'); onOpen?.() })
    conn.on('data', (d: any) => { if (d && typeof d === 'object' && d.ch) this.msgCb?.(d.ch as NetChannel, d.data) })
    conn.on('close', () => this.setState('closed'))
    conn.on('error', () => this.setState('failed'))
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
    if (this.state === 'closed') return
    try { this.conn?.close() } catch { /* noop */ }
    try { this.peer?.destroy() } catch { /* noop */ }
    this.conn = null
    this.peer = null
    this.setState('closed')
  }

  private setState(s: NetState) {
    this.state = s
    this.stateCb?.(s)
  }
}
