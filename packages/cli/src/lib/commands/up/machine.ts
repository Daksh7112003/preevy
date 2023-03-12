import retry from 'p-retry'
import { Logger } from '../../../log'
import { Machine, MachineDriver, scripts } from '../../machine'
import { nodeSshClient } from '../../ssh/client'
import { NamedSshKeyPair } from '../../ssh/keypair'
import { PersistentState } from '../../state'
import { scriptExecuter } from './scripts'

type MachineState = 'existing' | 'fromSnapshot' | 'fromScratch'

const ensureMachine = async ({
  machineDriver,
  envId,
  state,
  log,
}: {
  machineDriver: MachineDriver
  envId: string
  state: PersistentState
  log: Logger
}): Promise<{ machine: Machine; keyPair: NamedSshKeyPair; state: MachineState }> => {
  const getFirstExistingKeyPair = async () => {
    for await (const keyPairName of machineDriver.listKeyPairs()) {
      const keyPair = await state.machineSshKeys.read(keyPairName)
      if (keyPair) {
        return Object.assign(keyPair, { name: keyPairName })
      }
    }
    return undefined
  }

  const createAndWriteKeyPair = async (): Promise<NamedSshKeyPair> => {
    log.info('Creating key pair')
    const keyPair = await machineDriver.createKeyPair({ envId })
    await state.machineSshKeys.write(keyPair.name, keyPair)
    return keyPair
  }

  let removePromise: Promise<void> | undefined
  const existingMachine = await machineDriver.getMachine({ envId })

  if (existingMachine) {
    const keyPair = await state.machineSshKeys.read(existingMachine.sshKeyName)
    if (keyPair) {
      return { machine: existingMachine, keyPair, state: 'existing' }
    }

    log.warn(`No matching key pair found for ${existingMachine.sshKeyName}, recreating machine`)
    removePromise = machineDriver.removeMachine(existingMachine.providerId)
  }

  log.info('Fetching key pair')
  const keyPair = (await getFirstExistingKeyPair()) || (await createAndWriteKeyPair())
  log.info('Creating machine')
  const machine = await machineDriver.createMachine({ envId, keyPairName: keyPair.name })
  await removePromise

  return { machine, keyPair, state: machine.fromSnapshot ? 'fromSnapshot' : 'fromScratch' }
}

export const ensureCustomizedMachine = async ({
  machineDriver,
  envId,
  state,
  log,
}: {
  machineDriver: MachineDriver
  envId: string
  state: PersistentState
  log: Logger
}) => {
  const { machine, keyPair, state: machineState } = await ensureMachine({ machineDriver, envId, state, log })

  const sshClient = await retry(() => nodeSshClient({
    host: machine.publicIPAddress,
    username: machine.sshUsername,
    privateKey: keyPair.privateKey.toString('utf-8'),
    log,
  }), { minTimeout: 2000, maxTimeout: 5000, retries: 10 })

  try {
    const execScript = scriptExecuter({ sshClient, log })

    if (machineState === 'fromScratch') {
      log.debug('Executing machine scripts')
      for (const script of scripts.CUSTOMIZE_BARE_MACHINE) {
        // eslint-disable-next-line no-await-in-loop
        await execScript(script)
      }
    }

    if (machineState !== 'existing') {
      log.info('Finishing machine creation')
      await machineDriver.onMachineCreated({
        providerId: machine.providerId,
        envId,
        fromSnapshot: machineState === 'fromSnapshot',
      })
    }

    log.debug('Executing instance-specific scripts')

    for (const script of scripts.INSTANCE_SPECIFIC) {
      // eslint-disable-next-line no-await-in-loop
      await execScript(script)
    }
  } catch (e) {
    if (machineState !== 'existing') {
      log.debug('Removing new machine due to error')
      await machineDriver.removeMachine(machine.providerId)
    }
    sshClient.dispose()
    throw e
  }

  return { machine, keyPair, sshClient }
}
