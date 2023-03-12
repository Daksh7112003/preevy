import retry from 'p-retry'
import { Logger } from '../../../log'
import { MachineDriver, scripts } from '../../machine'
import { nodeSshClient } from '../../ssh/client'
import { SSHKeyConfig } from '../../ssh/keypair'
import { scriptExecuter } from './scripts'

const ensureMachine = async ({
  machineDriver,
  envId,
  sshKey,
  log,
}: {
  machineDriver: MachineDriver
  sshKey: SSHKeyConfig
  envId: string
  log: Logger
}) => {
  log.debug('check for existing machine')
  const existingMachine = await machineDriver.getMachine({ envId })
  if (!existingMachine) {
    log.debug('provisioning new machine')
    const machine = await machineDriver.createMachine({ envId, keyConfig: sshKey })
    return {
      machine,
      installed: machine.fromSnapshot,
    }
  }
  return { machine: existingMachine, installed: true }
}

export const ensureCustomizedMachine = async ({
  machineDriver,
  envId,
  sshKey,
  log,
}: {
  machineDriver: MachineDriver
  envId: string
  sshKey: SSHKeyConfig
  log: Logger
}) => {
  const { machine, installed } = await ensureMachine({ machineDriver, envId, sshKey, log })

  const sshClient = await retry(() => nodeSshClient({
    host: machine.publicIPAddress,
    username: machine.sshUsername,
    privateKey: sshKey.privateKey.toString('utf-8'),
    log,
  }), { minTimeout: 2000, maxTimeout: 5000, retries: 10 })

  try {
    const execScript = scriptExecuter({ sshClient, log })

    if (!installed) {
      log.debug('Executing machine scripts')
      for (const script of scripts.CUSTOMIZE_BARE_MACHINE) {
        // eslint-disable-next-line no-await-in-loop
        await execScript(script)
      }
      log.info('Creating snapshot in background')
      await machineDriver.ensureMachineSnapshot({ driverMachineId: machine.providerId, envId }).catch(() => {
        log.info('Failed to create machine snapshot')
      })
    }

    log.debug('Executing instance-specific scripts')

    for (const script of scripts.INSTANCE_SPECIFIC) {
      // eslint-disable-next-line no-await-in-loop
      await execScript(script)
    }
  } catch (e) {
    sshClient.dispose()
    throw e
  }

  return { machine, sshClient }
}
