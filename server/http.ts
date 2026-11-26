import type express from 'express'

/* What every route shares at the HTTP edge. Express 5 passes a rejected promise from any handler
   or middleware on to the error handlers (a handler that catches its own errors answers as it
   always did), and `routeErrorAnswer`, mounted after every route, answers whatever is left. */

/** Express 4's body parsers left `{}` on a request they did not parse (no body, or another
 *  content type); Express 5's leave `undefined`. Mounted right after the app-wide JSON parser,
 *  this keeps `{}`, so a route that reads or validates the body sees what it always saw. A
 *  parser that runs later (a route's own `express.raw`) still reads the body: body-parser 2
 *  skips only a request whose body was already read. */
export const emptyBodyByDefault: express.RequestHandler = (req, _res, next) => {
  req.body ??= {}
  next()
}

export const INTERNAL_ERROR = 'Something went wrong on the server. Please try again.'

type HttpErrorFields = { status?: unknown; statusCode?: unknown; expose?: unknown; message?: unknown }

function httpErrorFields(error: unknown): HttpErrorFields {
  return typeof error === 'object' && error !== null ? (error as HttpErrorFields) : {}
}

/** The status an error asks for itself (body-parser's 400 and 413 do), which Express's own final
 *  handler honoured; 500 when it names none. */
function errorStatus(error: unknown): number {
  const { status, statusCode } = httpErrorFields(error)
  const code = typeof status === 'number' ? status : statusCode
  /* Express 5's res.status throws on anything but an integer */
  return typeof code === 'number' && Number.isInteger(code) && code >= 400 && code < 600 ? code : 500
}

/** What the client is told: a 4xx's own message only when the error marks it safe to show
 *  (`expose`, as http-errors sets it), never a 5xx's (it can carry SQL, paths or tokens). */
function errorBody(error: unknown, status: number): { error: string } {
  if (status >= 500) return { error: INTERNAL_ERROR }
  const { expose, message } = httpErrorFields(error)
  return { error: expose === true && typeof message === 'string' ? message : 'Bad request' }
}

/** The last error handler, after every route: a failure nothing else answered is answered as
 *  JSON, with the status the error asks for (500 when none), and a 5xx is logged. A response
 *  already sent is left alone; one cut off midway is left to Express, which closes the
 *  connection. */
export const routeErrorAnswer: express.ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent && !res.writableEnded) return next(error)
  const status = errorStatus(error)
  /* the path only: a query can carry secrets (an OAuth callback's code and state) */
  if (status >= 500) console.error(`[route-error] ${req.method} ${req.originalUrl.split('?')[0]}`, error)
  if (res.writableEnded) return
  res.status(status).json(errorBody(error, status))
}
