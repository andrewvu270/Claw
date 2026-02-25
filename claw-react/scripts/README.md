# Scripts

## upload-toys-to-r2.mjs

Uploads toy sprites from Supabase to Cloudflare R2 and rebuilds `toys.json`.

### Usage

```bash
# Only upload toys since a specific date
node scripts/upload-toys-to-r2.mjs --since 2026-02-20

# Full upload (all toys)
node scripts/upload-toys-to-r2.mjs
```

The `--since` flag uses `created_at` to only fetch and upload sprites for toys added on or after that date. It then rebuilds `toys.json` from all Supabase metadata (lightweight, no sprites). Zero R2 egress.
