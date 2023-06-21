/* eslint-disable no-await-in-loop */
import fetch from 'node-fetch'
import { exec } from 'child_process'
import * as jose from 'jose'
import { z } from 'zod'
import { VirtualFS, localFs } from './store'
import { Logger } from './log'
import { withSpinner } from './spinner'

export class TokenExpiredError extends Error {
  constructor() {
    super('Token is expired')
  }
}

const PERSISTENT_TOKEN_FILE_NAME = 'lc-access-token.json'

const wait = (timeInMs: number) => new Promise<void>(resolve => {
  setTimeout(() => { resolve() }, timeInMs)
})

const tokensResponseDataSchema = z.object({ access_token: z.string(), id_token: z.string() })

export type TokesFileSchema = z.infer<typeof tokensResponseDataSchema>

const pollTokensFromAuthEndpoint = async (
  loginUrl: string,
  deviceCode: string,
  logger: Logger,
  interval: number
) => {
  try {
    while (true) {
      const tokenResponse = await fetch(`${loginUrl}/oauth/token`, { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
          client_id: 'jEnySAwuAaWaLOdWdALbvXj6dZEqgAJB' }) })

      if (tokenResponse.status !== 403) {
        if (!tokenResponse.ok) throw new Error(`Bad response from token endpoint: ${tokenResponse.status}: ${tokenResponse.statusText}`)

        return tokensResponseDataSchema.parse(await tokenResponse.json())
      }

      await wait(interval)
    }
  } catch (e) {
    logger.info('Error getting tokens', e)
    throw e
  }
}

const deviceCodeSchema = z.object({ device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  expires_in: z.number(),
  interval: z.number(),
  verification_uri_complete: z.string() })

const deviceFlow = async (loginUrl: string, logger: Logger) => {
  const deviceCodeResponse = await fetch(`${loginUrl}/oauth/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams({
      client_id: 'jEnySAwuAaWaLOdWdALbvXj6dZEqgAJB',
      scope: 'email openid profile',
      audience: 'https://livecycle-preevy-cli/',
    }),
  })

  const responseData = deviceCodeSchema.parse(await deviceCodeResponse.json())

  exec(`open ${responseData.verification_uri_complete}`) // TODO - use cross-platform, safer, opener - once we get esm modules working
  logger.info(`If your browser did not open, here: ${responseData.verification_uri_complete}`)
  logger.info('Make sure code is ', responseData.user_code)
  return withSpinner(
    () => pollTokensFromAuthEndpoint(
      loginUrl,
      responseData.device_code,

      logger,

      responseData.interval * 1000
    ),
    { opPrefix: 'Waiting for approval', successText: 'Done!' }
  )
}

export const getTokensFromLocalFs = async (fs: VirtualFS) : Promise<TokesFileSchema | undefined> => {
  const tokensFile = await fs.read(PERSISTENT_TOKEN_FILE_NAME)
  if (tokensFile === undefined) return undefined

  const tokens: TokesFileSchema = JSON.parse(tokensFile.toString())
  const accessToken = jose.decodeJwt(tokens.access_token)
  if (accessToken.exp === undefined || (accessToken.exp < Math.floor(Date.now() / 1000))) {
    throw new TokenExpiredError()
  }
  return tokens
}

export const login = async (dataDir: string, loginUrl: string, lcUrl: string, logger: Logger) => {
  const fs = localFs(dataDir)
  let tokens: TokesFileSchema
  try {
    const tokensMaybe = await getTokensFromLocalFs(fs)
    if (tokensMaybe !== undefined) {
      logger.info(`Already logged in as: ${jose.decodeJwt(tokensMaybe.id_token).email} 👌`)
      return
    }
    tokens = await deviceFlow(loginUrl, logger)
  } catch (e) {
    if (!(e instanceof TokenExpiredError)) {
      throw e
    }

    tokens = await deviceFlow(loginUrl, logger)
  }

  await fs.write(PERSISTENT_TOKEN_FILE_NAME, JSON.stringify(tokens))

  const postLoginResponse = await fetch(
    `${lcUrl}/post-login`,
    { method: 'POST',
      body: JSON.stringify({ id_token: tokens.id_token }),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.access_token}` } }
  )

  if (postLoginResponse.ok) {
    logger.info(`Logged in successfully as: ${jose.decodeJwt(tokens.id_token).email} 👌`)
  } else {
    throw new Error(`Bad response from post-login endpoint ${postLoginResponse.status}: ${postLoginResponse.statusText}`)
  }
}
