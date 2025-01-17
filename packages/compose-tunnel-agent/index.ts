import fs from 'fs'
import path from 'path'
import Docker from 'dockerode'
import { rimraf } from 'rimraf'
import pino from 'pino'
import pinoPretty from 'pino-pretty'
import {
  requiredEnv,
  formatPublicKey,
  parseSshUrl,
  SshConnectionConfig,
  tunnelNameResolver,
  MachineStatusCommand,
  COMPOSE_TUNNEL_AGENT_PORT,
} from '@preevy/common'
import { inspect } from 'util'
import { createApp } from './src/api-server'
import { sshClient as createSshClient } from './src/ssh'
import { runMachineStatusCommand } from './src/machine-status'
import { envMetadata } from './src/metadata'
import { readAllFiles } from './src/files'
import { eventsClient as dockerEventsClient, filteredClient as dockerFilteredClient } from './src/docker'

const homeDir = process.env.HOME || '/root'
const dockerSocket = '/var/run/docker.sock'

const targetComposeProject = process.env.COMPOSE_PROJECT
const defaultAccess = process.env.DEFAULT_ACCESS_LEVEL === 'private' ? 'private' : 'public'

const sshConnectionConfigFromEnv = async (): Promise<{ connectionConfig: SshConnectionConfig; sshUrl: string }> => {
  const sshUrl = requiredEnv('SSH_URL')
  const parsed = parseSshUrl(sshUrl)

  const clientPrivateKey = process.env.SSH_PRIVATE_KEY || fs.readFileSync(
    path.join(homeDir, '.ssh', 'id_rsa'),
    { encoding: 'utf8' },
  )

  const knownServerPublicKeys = await readAllFiles(path.join(homeDir, 'known_server_keys'))

  return {
    sshUrl,
    connectionConfig: {
      ...parsed,
      clientPrivateKey,
      username: requiredEnv('PREEVY_ENV_ID'),
      knownServerPublicKeys,
      insecureSkipVerify: Boolean(process.env.INSECURE_SKIP_VERIFY),
      tlsServerName: process.env.TLS_SERVERNAME || undefined,
    },
  }
}

const fastifyListenArgsFromEnv = async () => {
  const portOrPath = process.env.PORT ?? COMPOSE_TUNNEL_AGENT_PORT
  const portNumber = Number(portOrPath)
  if (typeof portOrPath === 'string' && Number.isNaN(portNumber)) {
    await rimraf(portOrPath)
    return { path: portOrPath }
  }
  return { port: portNumber, host: '0.0.0.0' }
}

const machineStatusCommand = process.env.MACHINE_STATUS_COMMAND
  ? JSON.parse(process.env.MACHINE_STATUS_COMMAND) as MachineStatusCommand
  : undefined

const log = pino({
  level: process.env.DEBUG || process.env.DOCKER_PROXY_DEBUG ? 'debug' : 'info',
}, pinoPretty({ destination: pino.destination(process.stderr) }))

const main = async () => {
  let endRequested = false
  const { connectionConfig, sshUrl } = await sshConnectionConfigFromEnv()

  log.debug('ssh config: %j', {
    ...connectionConfig,
    clientPrivateKey: '*** REDACTED ***',
    clientPublicKey: formatPublicKey(connectionConfig.clientPrivateKey),
  })

  const docker = new Docker({ socketPath: dockerSocket })
  const dockerClient = dockerEventsClient({
    log: log.child({ name: 'docker' }),
    docker,
    debounceWait: 500,
    defaultAccess,
    composeProject: targetComposeProject,
  })

  const sshLog = log.child({ name: 'ssh' })
  const sshClient = await createSshClient({
    connectionConfig,
    tunnelNameResolver: tunnelNameResolver({ envId: requiredEnv('PREEVY_ENV_ID') }),
    log: sshLog,
  })

  sshClient.ssh.on('close', () => {
    if (!endRequested) {
      log.error('ssh client closed unexpectedly')
      process.exit(1)
    }
    log.info('ssh client closed')
  })

  sshLog.info('ssh client connected to %j', sshUrl)
  let currentTunnels = dockerClient.getRunningServices().then(services => sshClient.updateTunnels(services))

  void dockerClient.startListening({
    onChange: async services => {
      currentTunnels = sshClient.updateTunnels(services)
    },
  })

  const app = await createApp({
    log: log.child({ name: 'api' }),
    currentSshState: async () => (await currentTunnels),
    machineStatus: machineStatusCommand
      ? async () => await runMachineStatusCommand({ log, docker })(machineStatusCommand)
      : undefined,
    envMetadata: await envMetadata({ env: process.env, log }),
    composeModelPath: '/preevy/docker-compose.yaml',
    docker,
    dockerFilter: dockerFilteredClient({ docker, composeProject: targetComposeProject }),
  })

  void app.listen({ ...await fastifyListenArgsFromEnv() })
  app.server.unref()

  const end = async () => {
    endRequested = true
    await Promise.all([
      app.close(),
      sshClient.end(),
    ])
  }

  return { end }
}

const SHUTDOWN_TIMEOUT = 5000

void main().then(
  ({ end }) => {
    ['SIGTERM', 'SIGINT', 'uncaughtException'].forEach(signal => {
      process.once(signal, async (...args) => {
        const argsStr = args ? args.map(arg => inspect(arg)).join(', ') : undefined
        log.warn(`shutting down on ${[signal, argsStr].filter(Boolean).join(': ')}`)
        const endResult = await Promise.race([
          end().then(() => true),
          new Promise<void>(resolve => { setTimeout(resolve, SHUTDOWN_TIMEOUT) }),
        ])
        if (!endResult) {
          log.error(`timed out while waiting ${SHUTDOWN_TIMEOUT}ms for server to close, exiting`)
        }
        process.exit(1)
      })
    })
  },
  err => {
    log.error(err)
    process.exit(1)
  }
)
