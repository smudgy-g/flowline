import http from 'node:http'

const received = []
http.createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json')
  if (req.method === 'GET' && req.url === '/received') {
    res.end(JSON.stringify(received))
    return
  }
  if (req.method === 'POST' && req.url === '/emails/batch') {
    try {
      let body = ''
      for await (const chunk of req) body += chunk
      const emails = JSON.parse(body)
      if (!Array.isArray(emails) || emails.some(email => !email.to?.length)) throw Error('Invalid email batch')
      received.push(...emails)
      res.end(JSON.stringify({ data: emails.map((_, index) => ({ id: `uat-email-${received.length - emails.length + index}` })) }))
    } catch {
      res.statusCode = 400
      res.end(JSON.stringify({ message: 'Invalid email batch', name: 'validation_error' }))
    }
    return
  }
  res.statusCode = 404
  res.end(JSON.stringify({ message: 'Not found', name: 'not_found' }))
}).listen(Number(process.env.FAKE_RESEND_PORT ?? 55354), '127.0.0.1')
