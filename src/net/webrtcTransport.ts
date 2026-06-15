import { Peer, type DataConnection } from 'peerjs'
import type { NetTransport, NetChannel, NetRole, NetState } from './transport'

// WebRTC DataChannel トランスポート(PeerJS無償ブローカーでシグナリング)。NetTransportを実装し、
// LoopbackTransportと差し替え可能。ホストは部屋コード(=peer id)を発行、参加者はコードで接続する。
// GitHub Pages(静的)だけで動作し、サーバ常駐不要。設計は docs/NETCODE_DESIGN.md。
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

  /** ホストとして待受。ready は発行された部屋コード(=peer id)で解決する。 */
  static host(): { transport: WebRtcTransport; ready: Promise<string> } {
    const t = new WebRtcTransport('host')
    t.setState('connecting')
    const ready = new Promise<string>((resolve, reject) => {
      const peer = new Peer()
      t.peer = peer
      peer.on('open', (id) => { t.roomCode = id; resolve(id) })
      peer.on('connection', (conn) => t.bind(conn)) // 参加者が来たら接続を確立
      peer.on('error', (e) => { t.setState('failed'); reject(e) })
    })
    return { transport: t, ready }
  }

  /** 部屋コードで参加。connected はDataChannelが開いたら解決する。 */
  static join(code: string): { transport: WebRtcTransport; connected: Promise<void> } {
    const t = new WebRtcTransport('client')
    t.setState('connecting')
    const connected = new Promise<void>((resolve, reject) => {
      const peer = new Peer()
      t.peer = peer
      peer.on('open', () => {
        const conn = peer.connect(code, { reliable: true })
        t.bind(conn, resolve)
      })
      peer.on('error', (e) => { t.setState('failed'); reject(e) })
    })
    return { transport: t, connected }
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
