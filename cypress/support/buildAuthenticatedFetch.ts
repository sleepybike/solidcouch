/*
Copyright 2021 Inrupt Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal in 
the Software without restriction, including without limitation the rights to use, 
copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the 
Software, and to permit persons to whom the Software is furnished to do so, 
subject to the following conditions:

The above copyright notice and this permission notice shall be included in 
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, 
INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A 
PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT 
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION 
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE 
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

// https://github.com/inrupt/solid-client-authn-js/blob/a7b06d69d4c77790818370a9546e5f7053c369ec/packages/core/src/authenticatedFetch/fetchFactory.ts

import type { KeyPair } from '@inrupt/solid-client-authn-core'
import {
  createDpopHeader,
  EVENTS,
  InvalidResponseError,
  OidcProviderError,
  REFRESH_BEFORE_EXPIRATION_SECONDS,
  RefreshOptions,
} from '@inrupt/solid-client-authn-core'
import type { EventEmitter } from 'events'

/**
 * If expires_in isn't specified for the access token, we assume its lifetime is
 * 10 minutes.
 */
const DEFAULT_EXPIRATION_TIME_SECONDS = 600

function isExpectedAuthError(statusCode: number): boolean {
  // As per https://tools.ietf.org/html/rfc7235#section-3.1 and https://tools.ietf.org/html/rfc7235#section-3.1,
  // a response failing because the provided credentials aren't accepted by the
  // server can get a 401 or a 403 response.
  return [401, 403].includes(statusCode)
}

async function buildDpopFetchOptions(
  targetUrl: string,
  authToken: string,
  dpopKey: KeyPair,
  defaultOptions?: RequestInit,
): Promise<RequestInit> {
  const headers = new Headers(defaultOptions?.headers)
  // Any pre-existing Authorization header should be overriden.
  headers.set('Authorization', `DPoP ${authToken}`)
  headers.set(
    'DPoP',
    await createDpopHeader(targetUrl, defaultOptions?.method ?? 'get', dpopKey),
  )
  return {
    ...defaultOptions,
    headers,
  }
}

async function buildAuthenticatedHeaders(
  targetUrl: string,
  authToken: string,
  dpopKey?: KeyPair,
  defaultOptions?: RequestInit,
): Promise<RequestInit> {
  if (dpopKey !== undefined) {
    return buildDpopFetchOptions(targetUrl, authToken, dpopKey, defaultOptions)
  }
  const headers = new Headers(defaultOptions?.headers)
  // Any pre-existing Authorization header should be overriden.
  headers.set('Authorization', `Bearer ${authToken}`)
  return {
    ...defaultOptions,
    headers,
  }
}

async function makeAuthenticatedRequest(
  accessToken: string,
  url: RequestInfo | URL,
  defaultRequestInit?: RequestInit,
  dpopKey?: KeyPair,
  customFetch?: typeof globalThis.fetch,
) {
  customFetch ??= globalThis.fetch
  return customFetch(
    url,
    await buildAuthenticatedHeaders(
      url.toString(),
      accessToken,
      dpopKey,
      defaultRequestInit,
    ),
  )
}

async function refreshAccessToken(
  refreshOptions: RefreshOptions,
  dpopKey?: KeyPair,
  eventEmitter?: EventEmitter,
): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }> {
  const tokenSet = await refreshOptions.tokenRefresher.refresh(
    refreshOptions.sessionId,
    refreshOptions.refreshToken,
    dpopKey,
  )
  eventEmitter?.emit(
    EVENTS.SESSION_EXTENDED,
    tokenSet.expiresIn ?? DEFAULT_EXPIRATION_TIME_SECONDS,
  )
  if (typeof tokenSet.refreshToken === 'string') {
    eventEmitter?.emit(EVENTS.NEW_REFRESH_TOKEN, tokenSet.refreshToken)
  }
  return {
    accessToken: tokenSet.accessToken,
    refreshToken: tokenSet.refreshToken,
    expiresIn: tokenSet.expiresIn,
  }
}

/**
 *
 * @param expiresIn Delay until the access token expires.
 * @returns a delay until the access token should be refreshed.
 */
const computeRefreshDelay = (expiresIn?: number): number => {
  if (expiresIn !== undefined) {
    return expiresIn - REFRESH_BEFORE_EXPIRATION_SECONDS > 0
      ? // We want to refresh the token 5 seconds before they actually expire.
        expiresIn - REFRESH_BEFORE_EXPIRATION_SECONDS
      : expiresIn
  }
  return DEFAULT_EXPIRATION_TIME_SECONDS
}

/**
 * @param accessToken an access token, either a Bearer token or a DPoP one.
 * @param options The option object may contain two objects: the DPoP key token
 * is bound to if applicable, and options to customize token renewal behavior.
 *
 * @returns A fetch function that adds an appropriate Authorization header with
 * the provided token, and adds a DPoP header if applicable.
 */
export async function buildAuthenticatedFetch(
  accessToken: string,
  options: {
    dpopKey?: KeyPair
    refreshOptions?: RefreshOptions
    expiresIn?: number
    eventEmitter?: EventEmitter
    customFetch?: typeof globalThis.fetch
  } = {},
): Promise<typeof fetch> {
  options.customFetch ??= globalThis.fetch
  let currentAccessToken = accessToken
  let latestTimeout: Parameters<typeof clearTimeout>[0]
  const currentRefreshOptions: RefreshOptions | undefined =
    options?.refreshOptions
  // Setup the refresh timeout outside of the authenticated fetch, so that
  // an idle app will not get logged out if it doesn't issue a fetch before
  // the first expiration date.
  if (currentRefreshOptions !== undefined) {
    const proactivelyRefreshToken = async () => {
      try {
        const {
          accessToken: refreshedAccessToken,
          refreshToken,
          expiresIn,
        } = await refreshAccessToken(
          currentRefreshOptions,
          // If currentRefreshOptions is defined, options is necessarily defined too.

          options!.dpopKey,

          options!.eventEmitter,
        )
        // Update the tokens in the closure if appropriate.
        currentAccessToken = refreshedAccessToken
        if (refreshToken !== undefined) {
          currentRefreshOptions.refreshToken = refreshToken
        }
        // Each time the access token is refreshed, we must plan for the next
        // refresh iteration.
        clearTimeout(latestTimeout)
        latestTimeout = setTimeout(
          proactivelyRefreshToken,
          computeRefreshDelay(expiresIn) * 1000,
        )
        // If currentRefreshOptions is defined, options is necessarily defined too.

        options!.eventEmitter?.emit(EVENTS.TIMEOUT_SET, latestTimeout)
      } catch (e) {
        // It is possible that an underlying library throws an error on refresh flow failure.
        // If we used a log framework, the error could be logged at the `debug` level,
        // but otherwise the failure of the refresh flow should not blow up in the user's
        // face, so we just swallow the error.
        if (e instanceof OidcProviderError) {
          // The OIDC provider refused to refresh the access token and returned an error instead.
          /* istanbul ignore next 100% coverage would require testing that nothing
              happens here if the emitter is undefined, which is more cumbersome
              than what it's worth. */
          options?.eventEmitter?.emit(EVENTS.ERROR, e.error, e.errorDescription)
          /* istanbul ignore next 100% coverage would require testing that nothing
            happens here if the emitter is undefined, which is more cumbersome
            than what it's worth. */
          options?.eventEmitter?.emit(EVENTS.SESSION_EXPIRED)
        }
        if (
          e instanceof InvalidResponseError &&
          e.missingFields.includes('access_token')
        ) {
          // In this case, the OIDC provider returned a non-standard response, but
          // did not specify that it was an error. We cannot refresh nonetheless.
          /* istanbul ignore next 100% coverage would require testing that nothing
            happens here if the emitter is undefined, which is more cumbersome
            than what it's worth. */
          options?.eventEmitter?.emit(EVENTS.SESSION_EXPIRED)
        }
      }
    }
    latestTimeout = setTimeout(
      proactivelyRefreshToken,
      // If currentRefreshOptions is defined, options is necessarily defined too.

      computeRefreshDelay(options!.expiresIn) * 1000,
    )

    options!.eventEmitter?.emit(EVENTS.TIMEOUT_SET, latestTimeout)
  } else if (options !== undefined && options.eventEmitter !== undefined) {
    // If no refresh options are provided, the session expires when the access token does.
    const expirationTimeout = setTimeout(
      () => {
        // The event emitter is always defined in our code, and it would be tedious
        // to test for conditions when it is not.

        options.eventEmitter!.emit(EVENTS.SESSION_EXPIRED)
      },
      computeRefreshDelay(options.expiresIn) * 1000,
    )

    options.eventEmitter!.emit(EVENTS.TIMEOUT_SET, expirationTimeout)
  }
  return async (url, requestInit?): Promise<Response> => {
    let response = await makeAuthenticatedRequest(
      currentAccessToken,
      url,
      requestInit,
      options?.dpopKey,
      options.customFetch,
    )

    const failedButNotExpectedAuthError =
      !response.ok && !isExpectedAuthError(response.status)
    if (response.ok || failedButNotExpectedAuthError) {
      // If there hasn't been a redirection, or if there has been a non-auth related
      // issue, it should be handled at the application level
      return response
    }
    const hasBeenRedirected = response.url !== url
    if (hasBeenRedirected && options?.dpopKey !== undefined) {
      // If the request failed for auth reasons, and has been redirected, we should
      // replay it generating a DPoP header for the rediration target IRI. This
      // doesn't apply to Bearer tokens, as the Bearer tokens aren't specific
      // to a given resource and method, while the DPoP header (associated to a
      // DPoP token) is.
      response = await makeAuthenticatedRequest(
        currentAccessToken,
        // Replace the original target IRI (`url`) by the redirection target
        response.url,
        requestInit,
        options.dpopKey,
        options.customFetch,
      )
    }
    return response
  }
}
