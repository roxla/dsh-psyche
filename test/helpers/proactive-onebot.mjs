// 仅本地 OneBot 故障端；被测方使用真实 QqBridge + Node WebSocket + QQ Transport。
import http from 'node:http'
import crypto from 'node:crypto'

function frame(value) {
  const body = Buffer.from(JSON.stringify(value))
  const head = Buffer.alloc(body.length < 126 ? 2 : 4)
  head[0] = 0x81
  head[1] = body.length < 126 ? body.length : 126
  if (body.length >= 126) head.writeUInt16BE(body.length, 2)
  return Buffer.concat([head, body])
}

export async function oneBotFixture(mode = 'accepted', sender = '39999') {
  const sockets = new Set()
  const timers = new Set()
  const actions = []
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end() })
  const later = (fn, ms) => { const timer = setTimeout(() => { timers.delete(timer); fn() }, ms); timers.add(timer) }
  server.on('upgrade', (req, socket) => {
    if (new URL(req.url, 'http://127.0.0.1').searchParams.get('access_token') !== 'fixture-token') { socket.destroy(); return }
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
    sockets.add(socket)
    const send = (value) => { if (!socket.destroyed) socket.write(frame(value)) }
    send({ post_type: 'meta_event', meta_event_type: 'heartbeat', self_id: sender, status: { good: true, online: true } })
    // 出站专用连接收到入站消息也不得 announce/回复。
    send({ post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: 10001, self_id: sender, message_id: 1, raw_message: 'inbound must be ignored' })
    let pending = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk])
      let offset = 0
      while (pending.length - offset >= 2) {
        const opcode = pending[offset] & 15
        const masked = pending[offset + 1] & 128
        let length = pending[offset + 1] & 127
        let cursor = offset + 2
        if (length === 126) { if (pending.length - cursor < 2) break; length = pending.readUInt16BE(cursor); cursor += 2 }
        if (length === 127) { if (pending.length - cursor < 8) break; length = Number(pending.readBigUInt64BE(cursor)); cursor += 8 }
        if (pending.length - cursor < (masked ? 4 : 0) + length) break
        const mask = masked ? pending.subarray(cursor, cursor + 4) : null
        if (mask) cursor += 4
        const body = Buffer.from(pending.subarray(cursor, cursor + length))
        if (mask) for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4]
        offset = cursor + length
        if (opcode === 8) { socket.end(); continue }
        if (opcode !== 1) continue
        const action = JSON.parse(body.toString())
        actions.push(action)
        const accepted = { status: 'ok', retcode: 0, data: { message_id: `wire-${actions.length}` }, echo: action.echo }
        if (mode === 'disconnect') socket.destroy()
        else if (mode === 'ack-lost') { /* 请求已记录，故意丢 ACK。 */ }
        else if (mode === 'late-ack') later(() => send(accepted), 500)
        else if (mode === 'wrong-echo') send({ ...accepted, echo: 'unrelated-request' })
        else if (mode === 'wrong-then-right') { send({ ...accepted, echo: 'unrelated-request', data: { message_id: 'wrong' } }); later(() => send(accepted), 10) }
        else if (mode === 'no-echo') { const { echo, ...rest } = accepted; send(rest) }
        else if (mode === 'no-status') { const { status, ...rest } = accepted; send(rest) }
        else if (mode === 'no-status-rejected') send({ retcode: 100, echo: action.echo })
        else if (mode === '429') send({ status: 'failed', retcode: 429, echo: action.echo })
        else if (mode === 'rejected') send({ status: 'failed', retcode: 100, echo: action.echo })
        else if (mode === 'malformed') send({ status: 'failed', retcode: 0, echo: action.echo })
        else send(accepted)
      }
      pending = pending.subarray(offset)
    })
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    wsUrl: `ws://127.0.0.1:${server.address().port}/`, token: 'fixture-token', senderAccount: sender, actions,
    close: async () => {
      for (const timer of timers) clearTimeout(timer)
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
