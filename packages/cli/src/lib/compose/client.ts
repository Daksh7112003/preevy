import { ChildProcess, spawn, StdioOptions } from 'child_process'
import yaml from 'yaml'
import { WriteStream } from 'fs'
import { ComposeModel } from './model'
import { childProcessPromise, childProcessStdoutPromise } from '../child-process'

const composeFileArgs = (
  composeFiles: string[] | Buffer,
  projectName?: string,
) => [
  ...(projectName ? ['-p', projectName] : []),
  ...(Buffer.isBuffer(composeFiles) ? ['-f', '-'] : composeFiles.flatMap(file => ['-f', file])),
]

type Executer = (opts: { args: string[]; stdin?: Buffer }) => Promise<string>

const composeClient = (
  executer: Executer,
  composeFiles: string[] | Buffer,
) => {
  const execComposeCommand = (args: string[]) => executer({
    args,
    stdin: Buffer.isBuffer(composeFiles) ? composeFiles : undefined,
  })

  const getModel = async () => yaml.parse(await execComposeCommand(['convert'])) as ComposeModel

  return {
    startService: (...services: string[]) => execComposeCommand(['start', ...services]),
    getModel,
    getModelName: async () => (await getModel()).name,
    getServiceLogs: (service: string) => execComposeCommand(['logs', '--no-color', '--no-log-prefix', service]),
    getServiceUrl: (service: string, port: number) => execComposeCommand(['port', service, String(port)]),
  }
}

export type ComposeClient = ReturnType<typeof composeClient>

// from: https://stackoverflow.com/a/67605309
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ParametersExceptFirst<F> = F extends (arg0: any, ...rest: infer R) => any ? R : never;

export const localComposeClient = (composeFiles: string[] | Buffer, projectName?: string) => {
  const insertStdin = (stdio: StdioOptions | undefined) => {
    if (!Buffer.isBuffer(composeFiles)) {
      return stdio
    }
    if (Array.isArray(stdio)) {
      return [null, ...stdio.slice(1)]
    }
    if (typeof stdio === 'string') {
      return [null, stdio, stdio]
    }
    return [null, null, null]
  }

  const spawnComposeArgs = (...[args, opts]: ParametersExceptFirst<typeof spawn>): Parameters<typeof spawn> => [
    'docker',
    [
      'compose',
      ...composeFileArgs(composeFiles, projectName),
      ...args,
    ],
    {
      ...opts,
      env: {
        ...process.env,
        ...opts.env,
      },
      stdio: insertStdin(opts.stdio),
    },
  ]

  const addStdIn = (p: ChildProcess) => {
    if (Buffer.isBuffer(composeFiles)) {
      const stdin = p.stdin as WriteStream
      stdin.write(composeFiles)
      stdin.end()
    }
    return p
  }

  const spawnCompose = (
    ...args: Parameters<typeof spawnComposeArgs>
  ) => addStdIn(spawn(...spawnComposeArgs(...args)))

  const spawnComposePromise = (
    ...args: Parameters<typeof spawnComposeArgs>
  ) => childProcessPromise(spawnCompose(...args))

  const executer: Executer = ({ args }) => childProcessStdoutPromise(spawnCompose(args, {}))

  return Object.assign(composeClient(executer, composeFiles), {
    getServiceLogsProcess: (
      service: string,
      opts: Parameters<typeof spawnComposeArgs>[1] = {}
    ) => spawnCompose(['logs', '--no-color', '--no-log-prefix', '--follow', service], opts),
    spawn: spawnCompose,
    spawnPromise: spawnComposePromise,
  })
}
