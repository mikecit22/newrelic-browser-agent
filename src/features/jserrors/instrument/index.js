/*
 * Copyright 2020 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { handle } from '../../../common/event-emitter/handle'
import { now } from '../../../common/timing/now'
import { InstrumentBase } from '../../utils/instrument-base'
import { FEATURE_NAME } from '../constants'
import { FEATURE_NAMES } from '../../../loaders/features/features'
import { globalScope } from '../../../common/constants/runtime'
import { eventListenerOpts } from '../../../common/event-listener/event-listener-opts'
import { stringify } from '../../../common/util/stringify'
import { UncaughtError } from './uncaught-error'

export class Instrument extends InstrumentBase {
  static featureName = FEATURE_NAME

  #seenErrors = new Set()

  constructor (agentIdentifier, aggregator, auto = true) {
    super(agentIdentifier, aggregator, FEATURE_NAME, auto)

    try {
      // this try-catch can be removed when IE11 is completely unsupported & gone
      this.removeOnAbort = new AbortController()
    } catch (e) {}

    // Capture function errors early in case the spa feature is loaded
    this.ee.on('fn-err', (args, obj, error) => {
      if (!this.abortHandler || this.#seenErrors.has(error)) return
      this.#seenErrors.add(error)

      handle('err', [this.#castError(error), now()], undefined, FEATURE_NAMES.jserrors, this.ee)
    })

    this.ee.on('internal-error', (error) => {
      if (!this.abortHandler) return
      handle('ierr', [this.#castError(error), now(), true], undefined, FEATURE_NAMES.jserrors, this.ee)
    })

    globalScope.addEventListener('unhandledrejection', (promiseRejectionEvent) => {
      if (!this.abortHandler) return

      handle('err', [this.#castPromiseRejectionEvent(promiseRejectionEvent), now(), false, { unhandledPromiseRejection: 1 }], undefined, FEATURE_NAMES.jserrors, this.ee)
    }, eventListenerOpts(false, this.removeOnAbort?.signal))

    globalScope.addEventListener('error', (errorEvent) => {
      if (!this.abortHandler) return
      if (this.#seenErrors.has(errorEvent.error)) {
        this.#seenErrors.delete(errorEvent.error)
        return
      }

      handle('err', [this.#castErrorEvent(errorEvent), now()], undefined, FEATURE_NAMES.jserrors, this.ee)
    }, eventListenerOpts(false, this.removeOnAbort?.signal))

    this.abortHandler = this.#abort // we also use this as a flag to denote that the feature is active or on and handling errors
    this.importAggregator()
  }

  /** Restoration and resource release tasks to be done if JS error loader is being aborted. Unwind changes to globals. */
  #abort () {
    this.removeOnAbort?.abort()
    this.#seenErrors.clear()
    this.abortHandler = undefined // weakly allow this abort op to run only once
  }

  #castError (error) {
    if (error instanceof Error) {
      return error
    }

    if (typeof error.message !== 'undefined') {
      return new UncaughtError(error.message, error.filename, error.lineno, error.colno)
    }

    return new UncaughtError(error)
  }

  /**
   * Attempts to convert a PromiseRejectionEvent object to an Error object
   * @param {PromiseRejectionEvent} unhandledRejectionEvent The unhandled promise rejection event
   * @returns {Error} An Error object with the message as the casted reason
   */
  #castPromiseRejectionEvent (promiseRejectionEvent) {
    let prefix = 'Unhandled Promise Rejection: '
    if (promiseRejectionEvent?.reason instanceof Error) {
      try {
        promiseRejectionEvent.reason.message = prefix + promiseRejectionEvent.reason.message
        return promiseRejectionEvent.reason
      } catch (e) {
        return promiseRejectionEvent.reason
      }
    }
    if (typeof promiseRejectionEvent.reason === 'undefined') return new Error(prefix)
    try {
      return new Error(prefix + stringify(promiseRejectionEvent.reason))
    } catch (e) {
      return new Error(promiseRejectionEvent.reason)
    }
  }

  /**
   * Attempts to convert an ErrorEvent object to an Error object
   * @param {ErrorEvent} errorEvent The error event
   * @returns {Error|UncaughtError} The error event converted to an Error object
   */
  #castErrorEvent (errorEvent) {
    if (errorEvent.error instanceof Error) {
      return errorEvent.error
    }

    return new UncaughtError(errorEvent.message, errorEvent.filename, errorEvent.lineno, errorEvent.colno)
  }
}
