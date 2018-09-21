const Future = require('fluture')
const axios = require('axios')
const createNubank = require('./nubank')
const { trace } = require('@mugos/log')
const {
  compose, map, chain, keys, mapObjIndexed, objOf, identity
} = require('ramda')
const { IO, Maybe, fromNull } = require('monet')

// Utils
const request = (options) => Future((reject, resolve) => { axios(options).then(resolve).catch(reject) })
const fork = (future) => future.fork(identity, identity)
const forkDebug = (future) => future.fork(x => console.error('FORK FAILED', x), x => console.log('FORK END -->', x))
const env = (key) => process.env[key]
const envs = compose(map(mapObjIndexed((value, key, _) => env(value))), IO.of)

// Config
const nubank = createNubank({ request })
const options = { login: 'NUBANK_LOGIN', password: 'NUBANK_PASSWORD' }

// Domain
const read = (key) => IO(() => env(key))
const state = {
  read
}

// Main
const start = compose(
  map(fork),
  // map(map(trace)),
  map(chain(nubank.feed)),
  map(nubank.login),
  // @TODO: Get token from storage first, if not make request
  envs,
)

start(options).run()
