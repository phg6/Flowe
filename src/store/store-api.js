/* globals ENV, SUPABASE_CONFIG */
import browser from 'webextension-polyfill'

import { createClient } from '@supabase/supabase-js'

import trigger from './store-trigger.js'
import fuzzySearch from './search.js'
import {badgeUpdate} from '../background/badge.js'
import {getDefaultTemplates, defaultTags, defaultSettings} from './default-data.js'
import htmlToText from '../content/utils/html-to-text.js'
import {getExtensionData, setExtensionData} from './extension-data.js'

export {getExtensionData, setExtensionData} from './extension-data.js'
export {openPopup} from './open-popup.js'

// Supabase client for the extension
const supabase = createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey, {
  auth: {
    // Store in IndexedDB via localStorage shim is not available in SW; rely on memory + refresh via /session
    persistSession: true,
    autoRefreshToken: true,
  }
})

// Silence lint: reference ENV
const __env = ENV; void __env

const SUPABASE_SESSION_KEY = 'supabaseSession'
let _sessionLoaded = false

async function saveSession (session) {
  await browser.storage.local.set({ [SUPABASE_SESSION_KEY]: session })
}

async function loadSession () {
  if (_sessionLoaded) return
  const data = await browser.storage.local.get(SUPABASE_SESSION_KEY)
  const stored = data[SUPABASE_SESSION_KEY]
  if (stored?.access_token) {
    try {
      await supabase.auth.setSession(stored)
    } catch {
      // ignore restore errors
    }
  }
  _sessionLoaded = true
}

supabase.auth.onAuthStateChange((_event, session) => {
  // persist any change
  saveSession(session)
})

// convert firestore timestamps to dates
function convertToNativeDates (obj = {}) {
  const parsed = Object.assign({}, obj)
  ;['created_datetime','modified_datetime','deleted_datetime'].forEach((prop) => {
    const v = obj[prop]
    if (typeof v === 'string' || v instanceof Date) {
      parsed[prop] = new Date(v)
    }
  })
  return parsed
}

async function clearDataCache () {
  // cache stats,
  // to keep them between login sessions
  const extensionData = await getExtensionData()
  const words = extensionData.words

  await browser.storage.local.clear()

  // restore time-saved stats
  return setExtensionData({
    words: words,
  })
}

async function templatesOwnedQuery (user) {
  return supabase.from('templates').select('*')
    .eq('customer', user.customer)
    .is('deleted_datetime', null)
    .eq('owner', user.id)
}

async function templatesSharedQuery (user) {
  return supabase.from('templates').select('*')
    .eq('customer', user.customer)
    .is('deleted_datetime', null)
    .eq('sharing', 'custom')
    .contains('shared_with', [user.id])
    .neq('owner', user.id)
}

async function templatesEveryoneQuery (user) {
  return supabase.from('templates').select('*')
    .eq('customer', user.customer)
    .is('deleted_datetime', null)
    .eq('sharing', 'everyone')
    .neq('owner', user.id)
}

const allCollections = [
  'users',
  'customers',
  'tags',
  'templatesOwned',
  'templatesShared',
  'templatesEveryone',
]

function getCollectionQuery (name, user) {
  if (name === 'templatesOwned') return templatesOwnedQuery(user)
  if (name === 'templatesShared') return templatesSharedQuery(user)
  if (name === 'templatesEveryone') return templatesEveryoneQuery(user)

  if (name === 'users') {
    return supabase.from('users').select('*').eq('id', user.id)
  }
  if (name === 'customers') {
    return supabase.from('customers').select('*').contains('members', [user.id])
  }
  if (name === 'tags') {
    return supabase.from('tags').select('*').eq('customer', user.customer)
  }
}

const collectionRequestQueue = {}

function getCollection (params = {}) {
  // request is already in progress
  if (collectionRequestQueue[params.collection]) {
    return collectionRequestQueue[params.collection]
  }

  // get from cache
  return browser.storage.local.get(params.collection)
    .then((res) => {
      if (res[params.collection]) {
        return res[params.collection]
      }

      const query = getCollectionQuery(params.collection, params.user)
      collectionRequestQueue[params.collection] = Promise.resolve(query).then((res) => {
        collectionRequestQueue[params.collection] = null
        if (res.error) throw res.error
        // normalize { data: [{id,...}]} into {id: row}
        const snapshot = { docs: (res.data || []).map((row) => ({ id: row.id, data: () => row })) }
        return refreshLocalData(params.collection, snapshot)
      })

      return collectionRequestQueue[params.collection]
    })
}

// refresh local data cache from snapshot listeners
function refreshLocalData (collectionName, querySnapshot) {
  const data = {}
  querySnapshot.docs.forEach((doc) => {
    data[doc.id] = doc.data()
  })

  return updateCache({
    collection: collectionName,
    data: data
  })
}

async function updateCache (params = {}) {
  await browser.storage.local.set({
    [params.collection]: params.data
  })

  const eventName = params.collection.includes('templates') ? 'templates-updated' : `${params.collection}-updated`
  trigger(eventName, params.data)

  await setExtensionData({
    lastSync: Date.now(),
  })

  return params.data
}

export async function refetchCollections (collections = []) {
  const collectionsToClear = collections.length ? collections : allCollections
  const cache = {}
  collectionsToClear.forEach((c) => {
    cache[c] = null
  })

  await browser.storage.local.set(cache)

  try {
    const user = await getSignedInUser()
    const free = await isFree(user)
    let collectionsToRefetch = collectionsToClear
    // don't refetch shared templates for free users
    if (free) {
      collectionsToRefetch = collectionsToClear.filter((c) => !['templatesShared', 'templatesEveryone'].includes(c))
    }

    return Promise.all(
      collectionsToRefetch.map((c) => getCollection({
        collection: c,
        user: user,
      }))
    )
  } catch (err) {
    if (isLoggedOut(err)) {
      return
    }

    throw err
  }
}

// three hours
const defaultSyncTimeout = 3 * 60 * 60 * 1000
export async function autosync (timeout = defaultSyncTimeout) {
  const data = await getExtensionData()
  const lastSync = new Date(data.lastSync)
  // auto sync if last sync was more than timeout ago
  if (new Date() - lastSync > timeout) {
    return refetchCollections()
  }

  return
}

// removed fetch wrapper; Supabase client handles auth

// return user and token
// no generic token fetcher needed; supabase client manages requests

export function getSettings () {
  return getSignedInUser()
    .then((user) => {
      return Promise.all([
        user.id,
        getCollection({
          user: user,
          collection: 'users'
        })
      ])
    })
    .then(([id, users]) => {
      const userData = users[id]
      if (userData) {
        return Object.assign({}, defaultSettings, userData.settings)
      }

      return defaultSettings
    })
    .catch((err) => {
      if (isLoggedOut(err)) {
        // logged-out
        return defaultSettings
      }

      throw err
    })
}

var LOGGED_OUT_ERR = 'logged-out'
function isLoggedOut (err) {
  return err === LOGGED_OUT_ERR
}

async function getFirebaseUser () {
  // return faster if possible
  await loadSession()
  const { data } = await supabase.auth.getUser()
  return data.user
}

var globalUserKey = 'firebaseUser'
export async function getSignedInUser () {
  const storedUser = await browser.storage.local.get(globalUserKey)
  const user = storedUser[globalUserKey] || {}

  const firebaseUser = await getFirebaseUser()
  if (firebaseUser) {
    // logged in to firebase and storage
    if (user.id === firebaseUser.id) {
      const customer = await getActiveCustomer(user)
      // if we're no longer part of cached customer,
      // store default customer and refresh data.
      // on first run after login, user.customer is null,
      // and will be populated once signinWithToken is done.
      if (user.customer && user.customer !== customer) {
        setActiveCustomer(customer)
      }

      return {
        id: user.id,
        customer: customer,
      }
    }
  } else {
    // automatic firebase logout
    if (Object.keys(user).length) {
  badgeUpdate(false)
  clearDataCache()
  await setSignedInUser({})
  trigger('logout', {}, 0)
    }
  }

  throw LOGGED_OUT_ERR
}

function setSignedInUser (user) {
  return new Promise((resolve) => {
    let globalUser = {}
    globalUser[globalUserKey] = user
    browser.storage.local.set(globalUser).then(() => {
      resolve(user)
    })
  })
}

function isFree (user) {
  return getCollection({ user, collection: 'customers' })
    .then((customers) => {
      const customer = customers[user.customer]
      return customer.subscription?.plan === 'free'
    })
}

const templatesFreeLimit = 30

export function getTemplates () {
  return getSignedInUser()
    .then((user) => {
      return Promise.all([
        user,
        isFree(user)
      ])
    })
    .then((res) => {
      const [user, freeCustomer] = res
      let templateCollections = [
        getCollection({
          user: user,
          collection: 'templatesOwned'
        })
      ]

      if (!freeCustomer) {
        templateCollections = templateCollections.concat([
          getCollection({
            user: user,
            collection: 'templatesShared'
          }),
          getCollection({
            user: user,
            collection: 'templatesEveryone'
          })
        ])
      }

      return Promise.all(templateCollections)
        .then((res) => {
          // merge and de-duplication
          return Object.assign({}, ...res)
        })
        .then((templates) => {
          return Object.keys(templates).map((id) => {
            const template = templates[id]
            return Object.assign(convertToNativeDates(template), {
              id: id,
              _body_plaintext: htmlToText(template.body),
            })
          })
        })
        .then((templates) => {
          if (freeCustomer) {
            return templates
              .sort((a, b) => {
                return new Date(a.created_datetime || 0) - new Date(b.created_datetime || 0)
              })
              .slice(0, templatesFreeLimit)
          }
          return templates
        })
    })
    .catch((err) => {
      if (isLoggedOut(err)) {
        return getDefaultTemplates()
      }

      throw err
    })
}

const networkError = 'There was an issue signing you in. Please check your connection and try again.'

function signinError (err) {
  if (err && err.code === 'auth/too-many-requests') {
    // recaptcha verifier is not supported in browser extensions
    // only http/https
    throw 'Too many unsuccessful login attempts. Please try again later. '
  }

  // catch "TypeError: Failed to fetch" errors
  if (!err.message || err instanceof TypeError) {
    throw networkError
  }

  throw err.message
}

export async function signin (params = {}) {
  try {
    await loadSession()
    const { data, error } = await supabase.auth.signInWithPassword({
      email: params.email,
      password: params.password,
    })
    if (error) throw error

    await clearDataCache()
    const user = await setSignedInUser({ id: data.user.id, customer: null })
    badgeUpdate(true)
    const customer = await getActiveCustomer(user)
    await setSignedInUser({ id: user.id, customer })
    trigger('login', {}, 0)
    return true
  } catch (err) {
    return signinError(err)
  }
}

export async function getSession () {
  await loadSession()
  const { data } = await supabase.auth.getSession()
  if (data?.session?.user) {
    const current = await browser.storage.local.get(globalUserKey)
    if (!current[globalUserKey]) {
      await setSignedInUser({ id: data.session.user.id, customer: null })
    }
    return true
  }
  throw LOGGED_OUT_ERR
}

export async function logout () {
  await supabase.auth.signOut()
  await setSignedInUser({})

  badgeUpdate(false)
  clearDataCache()
  trigger('logout', {}, 0)
  await browser.storage.local.set({ [SUPABASE_SESSION_KEY]: null })
  return true
}

// removed custom-token signin; using supabase.auth.signInWithPassword

export function getCustomer (customerId) {
  return getSignedInUser()
    .then((user) => {
      return getCollection({
        user: user,
        collection: 'customers'
      })
    })
    .then((customers) => {
      return customers[customerId]
    })
}

async function getActiveCustomer (user = {}) {
  const users = await getCollection({
      user: {id: user.id},
      collection: 'users'
    })

  const userData = users[user.id]
  const customers = userData.customers

  // make sure we are still part of this customer
  if (user.customer && customers.includes(user.customer)) {
    return user.customer
  }

  // active customer,
  // default to first customer
  return userData.customers[0]
}

export async function setActiveCustomer (customerId) {
  return setSignedInUser({
  id: (await supabase.auth.getUser()).data.user.id,
      customer: customerId,
    })
    .then(() => {
      // update data when customer changes
      refetchCollections([
        'templatesOwned',
        'templatesShared',
        'templatesEveryone',
        'tags',
      ])
      return
    })
}

export function updateTemplateStats ({id = '', _body_plaintext = ''}) {
  return getExtensionData()
    .then((data) => {
      // last used cache
      let lastuseCache = data.templatesLastUsed || {}
      lastuseCache[id] = new Date().toISOString()
      // time saved (words)
      const wordCount = (_body_plaintext || '').split(' ').length
      const words = data.words + wordCount

      return setExtensionData({
        templatesLastUsed: lastuseCache,
        words: words,
      })
    })
}

export function getAccount () {
  return getSignedInUser()
    .then((user) => {
      return Promise.all([
        user,
        getCollection({
          user: user,
          collection: 'users'
        })
      ])
    })
    .then(([cachedUser, users]) => {
      const userData = users[cachedUser.id]
      return {
        id: cachedUser.id,
        customer: cachedUser.customer,

        customers: userData.customers,
        email: userData.email,
        full_name: userData.full_name,
      }
    })
}

export function getTags () {
  return getSignedInUser()
    .then((user) => {
      return getCollection({
        collection: 'tags',
        user: user
      })
    })
    .then((tags) => {
      return Object.keys(tags).map((id) => {
        return Object.assign({id: id}, tags[id])
      })
    })
    .catch((err) => {
      if (isLoggedOut(err)) {
        // logged-out
        return defaultTags
      }

      throw err
    })
}

function parseTags (tagIds = [], allTags = []) {
  return tagIds
    .map((tagId) => {
      return allTags.find((t) => t.id === tagId)
    })
    .filter(Boolean)
}

function getSearchList (templates = [], allTags = []) {
  return templates.map((template) => {
    return Object.assign({}, template, {
      body: template._body_plaintext,
      tags: parseTags(template.tags, allTags).map((t) => t?.title),
    })
  })
}

let lastSearchQuery = ''
export function searchTemplates (query = '') {
  lastSearchQuery = query

  return Promise.all([
      getTemplates(),
      getTags(),
    ])
    .then(([templates, tags]) => {
      // avoid triggering fuzzySearch
      // if this is not the latest search query, for better performance.
      if (query !== lastSearchQuery) {
        return {
          query: '_SEARCH_CANCELED',
          results: [],
        }
      }

      const templateSearchList = getSearchList(templates, tags)
      return {
        query: query,
        results: fuzzySearch(templates, templateSearchList, query),
      }
    })
}

export async function isCached () {
  const key = 'templatesOwned'
  const cache = await browser.storage.local.get(key)
  if (cache[key]) {
    return true
  }

  return false
}
