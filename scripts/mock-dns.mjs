import dgram from 'node:dgram'

// Sandbox-only DNS: the browser fixture can pass the app's real MX validation offline.
const server = dgram.createSocket('udp4')
server.on('message', (request, remote) => {
  let end = 12
  const labels = []
  while (end < request.length && request[end]) {
    const size = request[end++]
    labels.push(request.subarray(end, end + size).toString('ascii'))
    end += size
  }
  if (end + 5 > request.length) return
  const domain = labels.join('.').toLowerCase()
  const question = request.subarray(12, end + 5)
  const mx = domain === 'example.com' && request.readUInt16BE(end + 1) === 15
  const header = Buffer.from(request.subarray(0, 12))
  header.writeUInt16BE(mx ? 0x8180 : 0x8183, 2)
  header.writeUInt16BE(mx ? 1 : 0, 6)
  header.fill(0, 8, 12)
  const answer = mx ? Buffer.from([
    0xc0, 0x0c, 0x00, 0x0f, 0x00, 0x01, 0, 0, 0, 60,
    0, 20, 0, 10, 4, 109, 97, 105, 108,
    7, 101, 120, 97, 109, 112, 108, 101, 3, 99, 111, 109, 0,
  ]) : Buffer.alloc(0)
  server.send(Buffer.concat([header, question, answer]), remote.port, remote.address)
})
server.bind(55353, '127.0.0.1')
