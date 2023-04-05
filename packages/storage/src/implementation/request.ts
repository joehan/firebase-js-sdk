/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @fileoverview Defines methods used to actually send HTTP requests from
 * abstract representations.
 */

import { ExponentialBackoff } from './backoff';
import { appDeleted, canceled, retryLimitExceeded, unknown } from './error';
import { ErrorHandler, RequestHandler, RequestInfo } from './requestinfo';
import { isJustDef } from './type';
import { makeQueryString } from './url';
import { Connection, ErrorCode, Headers, ConnectionType } from './connection';
import { isRetryStatusCode } from './utils';
import { Deferred } from '@firebase/util';

export interface Request<T> {
  getPromise(): Promise<T>;

  /**
   * Cancels the request. IMPORTANT: the promise may still be resolved with an
   * appropriate value (if the request is finished before you call this method,
   * but the promise has not yet been resolved), so don't just assume it will be
   * rejected if you call this function.
   * @param appDelete - True if the cancelation came from the app being deleted.
   */
  cancel(appDelete?: boolean): void;
}

/**
 * Handles network logic for all Storage Requests, including error reporting and
 * retries with backoff.
 *
 * @param I - the type of the backend's network response.
 * @param - O the output type used by the rest of the SDK. The conversion
 * happens in the specified `callback_`.
 */
class NetworkRequest<I extends ConnectionType, O> implements Request<O> {
  private pendingConnection_: Connection<I> | null = null;
  private backoffHandler: ExponentialBackoff<Connection<I>> | null = null;
  private resolve_!: (value?: O | PromiseLike<O>) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private reject_!: (reason?: any) => void;
  private appDelete_: boolean = false;
  private canceled_: boolean = false;
  private promise_: Promise<O>;

  constructor(
    private url_: string,
    private method_: string,
    private headers_: Headers,
    private body_: string | Blob | Uint8Array | null,
    private successCodes_: number[],
    private additionalRetryCodes_: number[],
    private callback_: RequestHandler<I, O>,
    private errorCallback_: ErrorHandler | null,
    private timeout_: number,
    private progressCallback_: ((p1: number, p2: number) => void) | null,
    private connectionFactory_: () => Connection<I>,
    private retry = true
  ) {
    this.promise_ = new Promise((resolve, reject) => {
      this.resolve_ = resolve as (value?: O | PromiseLike<O>) => void;
      this.reject_ = reject;
      this.start_();
    });
  }

  private makeRequest_: () => Promise<Connection<I>> = () =>{
    const connection = this.connectionFactory_();
    this.pendingConnection_ = connection;
    const deferred = new Deferred<Connection<I>>();
    // Should this move out?
    const progressListener: (progressEvent: ProgressEvent) => void = (
      progressEvent: ProgressEvent
    ) => {
      const { loaded } = progressEvent;
      const total = progressEvent.lengthComputable ? progressEvent.total : -1;
      if (this.progressCallback_ !== null) {
        this.progressCallback_(loaded, total);
      }
    };
    if (this.progressCallback_ !== null) {
      connection.addUploadProgressListener(progressListener);
    }
    // connection.send() never rejects, so we don't need to have a error handler or use catch on the returned promise.
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    connection
      .send(this.url_, this.method_, this.body_, this.headers_)
      .then(() => {
        if (this.progressCallback_ !== null) {
          connection.removeUploadProgressListener(progressListener);
        }
        this.pendingConnection_ = null;
        const hitServer = connection.getErrorCode() === ErrorCode.NO_ERROR;
        const status = connection.getStatus();
        const shouldRetry =
          !hitServer ||
          (isRetryStatusCode(status, this.additionalRetryCodes_) && this.retry);
        if (shouldRetry) {
          const wasCanceled = connection.getErrorCode() === ErrorCode.ABORT;
          deferred.reject({ wasCanceled, retry: true });
        } else {
          const successCode = this.successCodes_.indexOf(status) !== -1;
          if (!successCode) {
            deferred.reject({ retry: false, connection });
          } else {
            deferred.resolve(connection);
          }
        }
      });
    return deferred.promise;
  };

  /**
   * Actually starts the retry loop.
   */
  private start_(): void {
    interface HandleErrorArgs {
      wasCanceled: boolean;
      connection: Connection<I> | null;
    }
    const handleError: (handleErrorArgs: HandleErrorArgs) => void = ({
      wasCanceled,
      connection
    }) => {
      console.log('handling error');
      if (connection !== null) {
        console.log("connection exists");
        const err = unknown();
        console.log('getting error text', connection);
        err.serverResponse = connection.getErrorText();
        console.log('done getting error text');
        if (this.errorCallback_) {
          console.log('reject');
          reject(this.errorCallback_(connection, err));
        } else {
          console.log('reject');
          reject(err);
        }
      } else {
        console.log("connection doesn't exist");
        if (wasCanceled) {
          const err = this.appDelete_ ? appDeleted() : canceled();
          console.log('reject');
          reject(err);
        } else {
          const err = retryLimitExceeded();
          console.log('reject');
          reject(err);
        }
      }
    };
    if (this.canceled_) {
      handleError({ wasCanceled: true, connection: null });
      return;
    }
    this.backoffHandler = new ExponentialBackoff(
      this.makeRequest_,
      this.timeout_
    );
    const resolve = this.resolve_;
    const reject = this.reject_;

    this.backoffHandler
      .getPromise()
      .then(connection => {
        try {
          const result = this.callback_(connection, connection.getResponse());
          if (isJustDef(result)) {
            resolve(result);
          } else {
            resolve();
          }
        } catch (e) {
          reject(e);
        }
      })
      .catch(handleError);

    this.backoffHandler.start();
  }

  /** @inheritDoc */
  getPromise(): Promise<O> {
    return this.promise_;
  }

  /** @inheritDoc */
  cancel(appDelete?: boolean): void {
    console.log('calling cancel');
    this.canceled_ = true;
    this.appDelete_ = appDelete || false;
    if (this.backoffHandler !== null) {
      console.log('calling stop');
      this.backoffHandler.stop();
    }
    if (this.pendingConnection_ !== null) {
      this.pendingConnection_.abort();
    }
  }
}

/**
 * A collection of information about the result of a network request.
 * @param opt_canceled - Defaults to false.
 */
export class RequestEndStatus<I extends ConnectionType> {
  /**
   * True if the request was canceled.
   */
  canceled: boolean;

  constructor(
    public wasSuccessCode: boolean,
    public connection: Connection<I> | null,
    canceled?: boolean
  ) {
    this.canceled = !!canceled;
  }
}

export function addAuthHeader_(
  headers: Headers,
  authToken: string | null
): void {
  if (authToken !== null && authToken.length > 0) {
    headers['Authorization'] = 'Firebase ' + authToken;
  }
}

export function addVersionHeader_(
  headers: Headers,
  firebaseVersion?: string
): void {
  headers['X-Firebase-Storage-Version'] =
    'webjs/' + (firebaseVersion ?? 'AppManager');
}

export function addGmpidHeader_(headers: Headers, appId: string | null): void {
  if (appId) {
    headers['X-Firebase-GMPID'] = appId;
  }
}

export function addAppCheckHeader_(
  headers: Headers,
  appCheckToken: string | null
): void {
  if (appCheckToken !== null) {
    headers['X-Firebase-AppCheck'] = appCheckToken;
  }
}

export function makeRequest<I extends ConnectionType, O>(
  requestInfo: RequestInfo<I, O>,
  appId: string | null,
  authToken: string | null,
  appCheckToken: string | null,
  requestFactory: () => Connection<I>,
  firebaseVersion?: string,
  retry = true
): Request<O> {
  const queryPart = makeQueryString(requestInfo.urlParams);
  const url = requestInfo.url + queryPart;
  const headers = Object.assign({}, requestInfo.headers);
  addGmpidHeader_(headers, appId);
  addAuthHeader_(headers, authToken);
  addVersionHeader_(headers, firebaseVersion);
  addAppCheckHeader_(headers, appCheckToken);
  return new NetworkRequest<I, O>(
    url,
    requestInfo.method,
    headers,
    requestInfo.body,
    requestInfo.successCodes,
    requestInfo.additionalRetryCodes,
    requestInfo.handler,
    requestInfo.errorHandler,
    requestInfo.timeout,
    requestInfo.progressCallback,
    requestFactory,
    retry
  );
}
