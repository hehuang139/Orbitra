import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createSecureServer } from 'node:https'
import { createAccountApi } from './account-api.mjs'

const port = Number(process.env.ADVANCE_LIBRARY_PORT || 4174)
const host = process.env.ADVANCE_LIBRARY_HOST || '0.0.0.0'
const tlsCertificatePath = process.env.ADVANCE_LIBRARY_TLS_CERT_PATH
const tlsKeyPath = process.env.ADVANCE_LIBRARY_TLS_KEY_PATH
const api = createAccountApi()

if (Boolean(tlsCertificatePath) !== Boolean(tlsKeyPath)) {
  console.error('ADVANCE_LIBRARY_TLS_CERT_PATH 与 ADVANCE_LIBRARY_TLS_KEY_PATH 必须同时配置。')
  process.exit(1)
}

const tls =
  tlsCertificatePath && tlsKeyPath
    ? { cert: readFileSync(tlsCertificatePath), key: readFileSync(tlsKeyPath) }
    : null
const server = tls
  ? createSecureServer(tls, (request, response) => void api(request, response))
  : createServer((request, response) => void api(request, response))
const protocol = tls ? 'https' : 'http'

server.on('close', api.close)
server.listen(port, host, () => {
  console.log(`Orbitra online library: ${protocol}://${host}:${port}`)
})
