import { supabase } from '../supabaseClient'

export const CACHE_KEY = 'claw_toys_cache'
export const DEFAULT_TTL = 604800000 // 7 days in milliseconds
const M = 2.2

/**
 * Serialize a CacheEntry to a JSON string.
 * @param {{ data: object, timestamp: number }} entry
 * @returns {string}
 */
export function serializeCacheEntry(entry) {
  return JSON.stringify(entry)
}

/**
 * Deserialize a JSON string back to a CacheEntry.
 * @param {string} json
 * @returns {{ data: object, timestamp: number }}
 */
export function deserializeCacheEntry(json) {
  return JSON.parse(json)
}

/**
 * Remove the toy cache entry from localStorage.
 */
export function clearToyCache() {
  try {
    localStorage.removeItem(CACHE_KEY)
  } catch (e) {
    // Graceful degradation — ignore localStorage errors
  }
}

/**
 * Transform raw Supabase rows into the toy data map keyed by name.
 * @param {Array} rows - Raw rows from the toys table
 * @returns {object} - Toy data keyed by toy name
 */
function transformToyRows(rows) {
  const toys = {}
  rows.forEach((toy) => {
    toys[toy.name] = {
      w: toy.width * M,
      h: toy.height * M,
      sw: toy.sprite_width * M,
      sh: toy.sprite_height * M,
      st: toy.sprite_top * M,
      sl: toy.sprite_left * M,
      mime: toy.mime_type || 'image/png',
      sNormal: toy.sprite_normal,
      sGrabbed: toy.sprite_grabbed,
      sCollected: toy.sprite_collected,
      group: toy.group,
    }
  })
  return toys
}

/**
 * Fetch toy data from Supabase.
 * @returns {Promise<object|null>}
 */
async function fetchFromSupabase() {
  const { data, error } = await supabase
    .from('toys')
    .select('name, width, height, sprite_width, sprite_height, sprite_top, sprite_left, mime_type, sprite_normal, sprite_grabbed, sprite_collected, group')
  if (error) throw error
  if (!data) return null
  return transformToyRows(data)
}

/**
 * Retrieve toy data, using cache when valid.
 * @param {{ ttl?: number }} options
 * @returns {Promise<object|null>} - Toy data keyed by toy name, or null on failure
 */
export async function getCachedToys({ ttl = DEFAULT_TTL } = {}) {
  // 1. Try reading from localStorage
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (raw) {
      const entry = deserializeCacheEntry(raw)
      if (entry && entry.data && typeof entry.timestamp === 'number') {
        const age = Date.now() - entry.timestamp
        if (age < ttl) {
          return entry.data
        }
      }
    }
  } catch (e) {
    // localStorage read error or malformed JSON — fall through to Supabase
  }

  // 2. Cache miss or expired — fetch from Supabase
  try {
    const toys = await fetchFromSupabase()
    if (!toys) return null

    // 3. Try to store in localStorage
    try {
      const entry = { data: toys, timestamp: Date.now() }
      localStorage.setItem(CACHE_KEY, serializeCacheEntry(entry))
    } catch (writeErr) {
      console.warn('toyCache: failed to write to localStorage (quota exceeded?)', writeErr)
    }

    return toys
  } catch (fetchErr) {
    console.error('toyCache: Supabase fetch failed', fetchErr)
    return null
  }
}
