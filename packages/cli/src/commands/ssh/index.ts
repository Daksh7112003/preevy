import { Args } from '@oclif/core'
import DriverCommand from '@preevy/cli-core/src/driver-command'
import { ssh } from '@preevy/cli-core/src/lib/commands'
import { sshKeysStore } from '@preevy/cli-core/src/lib/state/ssh'

// eslint-disable-next-line no-use-before-define
export default class Ssh extends DriverCommand<typeof Ssh> {
  static description = 'SSH into a preview environment machine'

  static hidden = true
  static strict = false

  static flags = {
  }

  static args = {
    envId: Args.string({ description: 'Environment id', required: true }),
  }

  static enableJsonFlag = false

  async run(): Promise<unknown> {
    const { args, raw } = await this.parse(Ssh)
    const driver = await this.driver()
    const sshKey = await sshKeysStore(this.store).getKey(await driver.getKeyPairAlias())
    if (!sshKey) {
      this.error('SSH key not found for connecting to machine')
    }

    const restArgs = raw.filter(arg => arg.type === 'arg').slice(1).map(arg => arg.input)

    const { code } = await ssh({
      envId: args.envId,
      dataDir: this.config.dataDir,
      args: restArgs,
      sshKeyPair: sshKey,
      machineDriver: driver,
      log: this.logger,
    })

    this.exit(code ?? 0)

    return undefined
  }
}
