import { describe, it, expect, vi, beforeEach } from 'vitest'
import fc from 'fast-check'
import {
  getCachedToys,
  clearToyCache,
  serializeCacheEntry,
  deserializeCacheEntry,
  CACHE_KEY,
  DEFAULT_TTL,
} from './toyCache.js'

// --- localStorage mock ---
const store = {}
const localStorageMock = {
  getItem: vi.fn((key) => (key in store ? store[key] : null)),
  setItem: vi.fn((key, value) => { store[key] = value }),
  removeItem: vi.fn((key) => { delete store[key] }),
  clear: vi.fn(() => { for (const k in store) delete store[k] }),
}
vi.stubGlobal('localStorage', localStorageMock)

// --- Mock supabaseClient so the module never makes real network calls ---
vi.mock('../supabaseClient', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => Promise.resolve({ data: null, error: null })),
    })),
  },
}))

// --- Arbitrary generators ---

/** Generate a single toy data object (values the cache stores per toy). */
const toyEntryArb = fc.record({
  w: fc.double({ min: 1, max: 500, noNaN: true }),
  h: fc.double({ min: 1, max: 500, noNaN: true }),
  sw: fc.double({ min: 1, max: 500, noNaN: true }),
  sh: fc.double({ min: 1, max: 500, noNaN: true }),
  st: fc.double({ min: 1, max: 500, noNaN: true }),
  sl: fc.double({ min: 1, max: 500, noNaN: true }),
  mime: fc.constantFrom('image/png', 'image/jpeg', 'image/webp'),
  sNormal: fc.base64String({ minLength: 1, maxLength: 20 }),
  sGrabbed: fc.base64String({ minLength: 1, maxLength: 20 }),
  sCollected: fc.base64String({ minLength: 1, maxLength: 20 }),
  group: fc.string({ minLength: 1, maxLength: 10 }),
})

/** Generate a toy data map (1-5 toys keyed by name). */
const toyDataArb = fc
  .array(
    fc.tuple(fc.string({ minLength: 1, maxLength: 15 }), toyEntryArb),
    { minLength: 1, maxLength: 5 }
  )
  .map((pairs) => Object.fromEntries(pairs))


/** Generate a raw Supabase toy row (pre-transform shape). */
const supabaseRowArb = fc.record({
  name: fc.string({ minLength: 1, maxLength: 15 }),
  width: fc.double({ min: 1, max: 200, noNaN: true }),
  height: fc.double({ min: 1, max: 200, noNaN: true }),
  sprite_width: fc.double({ min: 1, max: 200, noNaN: true }),
  sprite_height: fc.double({ min: 1, max: 200, noNaN: true }),
  sprite_top: fc.double({ min: 1, max: 200, noNaN: true }),
  sprite_left: fc.double({ min: 1, max: 200, noNaN: true }),
  mime_type: fc.constantFrom('image/png', 'image/jpeg', 'image/webp'),
  sprite_normal: fc.base64String({ minLength: 1, maxLength: 20 }),
  sprite_grabbed: fc.base64String({ minLength: 1, maxLength: 20 }),
  sprite_collected: fc.base64String({ minLength: 1, maxLength: 20 }),
  group: fc.string({ minLength: 1, maxLength: 10 }),
})

/** Generate 1-5 raw Supabase rows with unique names. */
const supabaseRowsArb = fc
  .array(supabaseRowArb, { minLength: 1, maxLength: 5 })
  .map((rows) => {
    const seen = new Set()
    return rows.filter((r) => {
      if (seen.has(r.name)) return false
      seen.add(r.name)
      return true
    })
  })
  .filter((rows) => rows.length > 0)

// ---------------------------------------------------------------------------
// **Feature: toy-data-caching, Property 1: Cache hit returns cached data for any fresh entry**
// ---------------------------------------------------------------------------
describe('Property 1: Cache hit returns cached data for any fresh entry', () => {
  beforeEach(() => {
    localStorageMock.clear()
    vi.clearAllMocks()
  })

  it('returns cached data without fetching when entry is within TTL', async () => {
    const { supabase } = await import('../supabaseClient')

    await fc.assert(
      fc.asyncProperty(
        toyDataArb,
        // TTL between 1 second and 7 days
        fc.integer({ min: 1000, max: DEFAULT_TTL }),
        // Age as a fraction of TTL so it's always fresh (0–99% of TTL)
        fc.double({ min: 0, max: 0.99, noNaN: true }),
        async (toyData, ttl, ageFraction) => {
          // Reset mocks and store for each iteration
          localStorageMock.clear()
          vi.clearAllMocks()

          const age = Math.floor(ageFraction * ttl)
          const timestamp = Date.now() - age
          const entry = { data: toyData, timestamp }

          // Seed localStorage with a fresh cache entry
          store[CACHE_KEY] = serializeCacheEntry(entry)

          const result = await getCachedToys({ ttl })

          // The returned data must deep-equal the cached data
          expect(result).toEqual(toyData)

          // Supabase should NOT have been called
          expect(supabase.from).not.toHaveBeenCalled()
        }
      ),
      { numRuns: 100 }
    )
  })
})


// ---------------------------------------------------------------------------
// **Feature: toy-data-caching, Property 2: Cache miss or expiry fetches and stores fresh data**
// ---------------------------------------------------------------------------
describe('Property 2: Cache miss or expiry fetches and stores fresh data', () => {
  beforeEach(() => {
    localStorageMock.clear()
    vi.clearAllMocks()
  })

  const M = 2.2

  /** Compute expected transformed data from raw Supabase rows. */
  function expectedTransform(rows) {
    const toys = {}
    rows.forEach((row) => {
      toys[row.name] = {
        w: row.width * M,
        h: row.height * M,
        sw: row.sprite_width * M,
        sh: row.sprite_height * M,
        st: row.sprite_top * M,
        sl: row.sprite_left * M,
        mime: row.mime_type || 'image/png',
        sNormal: row.sprite_normal,
        sGrabbed: row.sprite_grabbed,
        sCollected: row.sprite_collected,
        group: row.group,
      }
    })
    return toys
  }

  it('fetches from Supabase and stores when cache is empty', async () => {
    const { supabase } = await import('../supabaseClient')

    await fc.assert(
      fc.asyncProperty(supabaseRowsArb, async (rows) => {
        // Reset state
        localStorageMock.clear()
        vi.clearAllMocks()

        // Mock Supabase to return the generated rows
        supabase.from.mockReturnValue({
          select: vi.fn(() => Promise.resolve({ data: rows, error: null })),
        })

        const result = await getCachedToys()

        const expected = expectedTransform(rows)

        // Returned data matches the transformed rows
        expect(result).toEqual(expected)

        // Supabase was called
        expect(supabase.from).toHaveBeenCalledWith('toys')

        // Data was stored in localStorage
        expect(store[CACHE_KEY]).toBeDefined()
        const stored = JSON.parse(store[CACHE_KEY])
        expect(stored.data).toEqual(expected)
        expect(typeof stored.timestamp).toBe('number')
      }),
      { numRuns: 100 }
    )
  })

  it('fetches from Supabase and stores when cache is expired', async () => {
    const { supabase } = await import('../supabaseClient')

    await fc.assert(
      fc.asyncProperty(
        supabaseRowsArb,
        // TTL between 1 second and 7 days
        fc.integer({ min: 1000, max: DEFAULT_TTL }),
        // Expired age: 1x to 3x the TTL past expiry
        fc.double({ min: 1.0, max: 3.0, noNaN: true }),
        async (rows, ttl, expiryMultiplier) => {
          // Reset state
          localStorageMock.clear()
          vi.clearAllMocks()

          // Seed localStorage with an expired entry (stale data)
          const expiredTimestamp = Date.now() - Math.ceil(expiryMultiplier * ttl)
          const staleEntry = { data: { stale: true }, timestamp: expiredTimestamp }
          store[CACHE_KEY] = JSON.stringify(staleEntry)

          // Mock Supabase to return fresh rows
          supabase.from.mockReturnValue({
            select: vi.fn(() => Promise.resolve({ data: rows, error: null })),
          })

          const result = await getCachedToys({ ttl })

          const expected = expectedTransform(rows)

          // Returned data matches the fresh transformed rows
          expect(result).toEqual(expected)

          // Supabase was called
          expect(supabase.from).toHaveBeenCalledWith('toys')

          // localStorage was updated with fresh data
          const stored = JSON.parse(store[CACHE_KEY])
          expect(stored.data).toEqual(expected)
          expect(stored.timestamp).toBeGreaterThan(expiredTimestamp)
        }
      ),
      { numRuns: 100 }
    )
  })
})


// ---------------------------------------------------------------------------
// **Feature: toy-data-caching, Property 3: Serialization round-trip preserves Cache_Entry**
// ---------------------------------------------------------------------------
describe('Property 3: Serialization round-trip preserves Cache_Entry', () => {
  /** Generate a valid CacheEntry: { data: toyDataMap, timestamp: number } */
  const cacheEntryArb = fc.record({
    data: toyDataArb,
    timestamp: fc.integer({ min: 0, max: 2000000000000 }),
  })

  it('deserialize(serialize(entry)) deep-equals the original entry', () => {
    fc.assert(
      fc.property(cacheEntryArb, (entry) => {
        const roundTripped = deserializeCacheEntry(serializeCacheEntry(entry))
        expect(roundTripped).toEqual(entry)
      }),
      { numRuns: 100 }
    )
  })
})


// ---------------------------------------------------------------------------
// **Feature: toy-data-caching, Property 4: Clearing cache removes the entry**
// ---------------------------------------------------------------------------
describe('Property 4: Clearing cache removes the entry', () => {
  /** Generate a valid CacheEntry: { data: toyDataMap, timestamp: number } */
  const cacheEntryArb = fc.record({
    data: toyDataArb,
    timestamp: fc.integer({ min: 0, max: 2000000000000 }),
  })

  beforeEach(() => {
    localStorageMock.clear()
    vi.clearAllMocks()
  })

  it('clearToyCache removes the cache key from localStorage for any stored entry', () => {
    fc.assert(
      fc.property(cacheEntryArb, (entry) => {
        // Store the entry in localStorage
        store[CACHE_KEY] = serializeCacheEntry(entry)

        // Verify it's there
        expect(store[CACHE_KEY]).toBeDefined()

        // Clear the cache
        clearToyCache()

        // The cache key must be absent
        expect(store[CACHE_KEY]).toBeUndefined()
      }),
      { numRuns: 100 }
    )
  })
})


// ---------------------------------------------------------------------------
// Unit tests for edge cases and constants (Task 1.6)
// ---------------------------------------------------------------------------
describe('Unit tests: edge cases and constants', () => {
  beforeEach(() => {
    localStorageMock.clear()
    vi.clearAllMocks()
  })

  it('DEFAULT_TTL equals 604,800,000 ms (7 days)', () => {
    expect(DEFAULT_TTL).toBe(604800000)
  })

  it('localStorage read error triggers Supabase fallback (Requirement 4.1)', async () => {
    const { supabase } = await import('../supabaseClient')

    const rows = [
      { name: 'bear', width: 10, height: 20, sprite_width: 5, sprite_height: 5, sprite_top: 0, sprite_left: 0, mime_type: 'image/png', sprite_normal: 'abc', sprite_grabbed: 'def', sprite_collected: 'ghi', group: 'A' },
    ]
    supabase.from.mockReturnValue({
      select: vi.fn(() => Promise.resolve({ data: rows, error: null })),
    })

    // Make getItem throw
    localStorageMock.getItem.mockImplementationOnce(() => { throw new Error('read error') })

    const result = await getCachedToys()

    expect(supabase.from).toHaveBeenCalledWith('toys')
    expect(result).toBeDefined()
    expect(result.bear).toBeDefined()
  })

  it('malformed JSON in cache triggers Supabase fallback (Requirement 4.2)', async () => {
    const { supabase } = await import('../supabaseClient')

    const rows = [
      { name: 'duck', width: 8, height: 12, sprite_width: 4, sprite_height: 4, sprite_top: 1, sprite_left: 1, mime_type: 'image/jpeg', sprite_normal: 'x', sprite_grabbed: 'y', sprite_collected: 'z', group: 'B' },
    ]
    supabase.from.mockReturnValue({
      select: vi.fn(() => Promise.resolve({ data: rows, error: null })),
    })

    // Seed localStorage with invalid JSON
    store[CACHE_KEY] = '{not valid json!!!'

    const result = await getCachedToys()

    expect(supabase.from).toHaveBeenCalledWith('toys')
    expect(result).toBeDefined()
    expect(result.duck).toBeDefined()
  })

  it('localStorage write error (quota exceeded) logs warning and returns data (Requirement 4.3)', async () => {
    const { supabase } = await import('../supabaseClient')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const rows = [
      { name: 'cat', width: 6, height: 10, sprite_width: 3, sprite_height: 3, sprite_top: 0, sprite_left: 0, mime_type: 'image/webp', sprite_normal: 'n', sprite_grabbed: 'g', sprite_collected: 'c', group: 'C' },
    ]
    supabase.from.mockReturnValue({
      select: vi.fn(() => Promise.resolve({ data: rows, error: null })),
    })

    // Make setItem throw to simulate quota exceeded
    localStorageMock.setItem.mockImplementationOnce(() => { throw new Error('QuotaExceededError') })

    const result = await getCachedToys()

    expect(supabase.from).toHaveBeenCalledWith('toys')
    expect(result).toBeDefined()
    expect(result.cat).toBeDefined()
    expect(warnSpy).toHaveBeenCalled()

    warnSpy.mockRestore()
  })
})
