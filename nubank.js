const Future = require('fluture')
const { ms, mms, cms, mapRej } = require('@mugos/ftw')
const {
  pick, compose, map, objOf, prop, merge, chain, path, identity, assocPath, assoc,
  curry
} = require('ramda')
const { trace } = require('@mugos/log')

// Utils
const stringify = x => JSON.stringify(x)
const cms2 = curry((fn, ctx) => compose(chain(r => map(merge(r), ctx)), chain(fn))(ctx))

// Config
const REQUEST_HEADERS_SAUCE = {
  'Content-Type': 'application/json',
  'X-Correlation-Id': 'WEB-APP.pewW9',
  'User-Agent': 'lambdaNu Client - https://github.com/yurifrl/lambdaNu',
}
const TOKEN_URL = 'https://prod-auth.nubank.com.br/api/token'
const DISCOVERY_URL = 'https://prod-s0-webapp-proxy.nubank.com.br/api/discovery'
const URL = 'https://prod-customers.nubank.com.br/api/customers'
const mockRequest = () => Future.of({ data: {
  _links: {},
  access_token: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6IjIwMTUtMTItMDRUMTc6MzY6MjIuNjY0LXU5ZC1ldWN1Ri1zQUFBRlJiaER3aUEifQ.eyJhdWQiOiJvdGhlci5jb250YSIsInN1YiI6IjU1YzM2NWUzLTc5Y2YtNDliMC1hYmJiLTRkMmMwODBkZTQ4YyIsImlzcyI6Imh0dHBzOlwvXC93d3cubnViYW5rLmNvbS5iciIsImV4cCI6MTUzODE0MTE0OCwic2NvcGUiOiJhdXRoXC91c2VyIHVzZXIiLCJqdGkiOiJtQnJIMVVCSXpCY0FBQUZsX0U3UF9nIiwibXRscyI6dHJ1ZSwiYWNsIjpudWxsLCJ2ZXJzaW9uIjoiMiIsImlhdCI6MTUzNzUzNjM0OH0.Qa_m3MfFzcsJGpk98aBesyNS0yADTCHvjVyw1waX7f9OCuHUr5ixGiw4b3Lgmt4CciWkC_ZuuYvAlwhMwBqbH6pqVgWe5n_3Nmq_x1xwHZGUIj5rF4PFpSJqxqN0ubYMLqG-KIY60yJz_aGx58gpkAAjE-Cw5AhSCSngMEGCJIOgD_-5d95tSmbBKlrAlqlNP9o688VSNxKr7rTDU7VA3I8B4E4GelA5AllCmccfqkqA-2EPp2JpY2E0oZIJYUwwQPnf8dicpcTztwlGXEV-xjK6IoMMd0udipFjyoKBGk0BpFzHD_amW93stBPLdfQjdj18hSLMLzy3UnNackwPGw'
} })

const parseRequest = compose(
  (r) => ({ token: r.access_token, links: r._links }),
  prop('data')
)
// Domains
const login = ({ request }) => compose(
  mapRej(trace),
  map(trace),
  map(ms('headers', ({ headers, token }) => assoc('Authorization', token, headers))),
  cms2(compose(map(parseRequest), mockRequest)),
  // cms2(compose(map(parseRequest), request)),
  map(({ url, data, headers }) => ({ url, data, headers, method: 'post' })),
  mms('url', compose(map(prop('login')), urls({ request }))),
  ms('headers', () => REQUEST_HEADERS_SAUCE),
  objOf('data'),
  stringify,
  parseForLogin,
  // @TODO: Throw error if login or pass not set
)
const feed = ({ request }) => compose(
  x => Future.of(x),
)
const parseForLogin = ({ login, password }) => ({
  login,
  password,
  grant_type: 'password',
  client_id: 'other.conta',
  client_secret: 'yQPeLzoHuJzlMMSAjC-LgNUJdUecx8XO',
})
const urls = ({ request }) => compose(
  map(prop('data')),
  ({ headers }) => request({
    url: DISCOVERY_URL,
    method: 'get',
    headers,
  }),
  ms('headers', () => REQUEST_HEADERS_SAUCE),
)

module.exports = ({ request }) => ({
  login: login({ request }),
  feed: feed({ request }),
})
