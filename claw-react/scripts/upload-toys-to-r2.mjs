import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';

config();

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY
);

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME;
const PUBLIC_URL = process.env.R2_PUBLIC_URL;

// Parse --since flag from CLI args
function parseSinceArg() {
  const idx = process.argv.indexOf('--since');
  if (idx === -1 || !process.argv[idx + 1]) return null;
  const date = new Date(process.argv[idx + 1]);
  if (isNaN(date.getTime())) {
    console.error(`Invalid date: ${process.argv[idx + 1]}`);
    process.exit(1);
  }
  return date.toISOString();
}

async function uploadSprites(toy) {
  const spriteTypes = ['sprite_normal', 'sprite_grabbed', 'sprite_collected'];
  const urls = {};

  for (const type of spriteTypes) {
    if (!toy[type]) continue;

    const buffer = Buffer.from(toy[type], 'base64');
    const key = `toys/${toy.name}/${type}.png`;

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: toy.mime_type || 'image/png',
    }));

    urls[type] = `${PUBLIC_URL}/${key}`;
  }

  return urls;
}

async function uploadToys() {
  const since = parseSinceArg();

  if (since) {
    console.log(`Incremental mode: uploading toys created after ${since}`);
  } else {
    console.log('Full mode: uploading all toys');
  }

  // 1. Fetch toys that need sprite uploads (full rows with base64 data)
  let toysToUpload;
  if (since) {
    const { data, error } = await supabase
      .from('toys')
      .select('*')
      .gte('created_at', since);
    if (error) throw error;
    toysToUpload = data;
    console.log(`Found ${toysToUpload.length} new toys since ${since}`);
  } else {
    const { data, error } = await supabase.from('toys').select('*');
    if (error) throw error;
    toysToUpload = data;
    console.log(`Found ${toysToUpload.length} toys total`);
  }

  // 2. Upload sprites for new/all toys
  const uploadedMap = {};
  for (const toy of toysToUpload) {
    const urls = await uploadSprites(toy);
    uploadedMap[toy.name] = urls;
    console.log(`Uploaded sprites: ${toy.name}`);
  }

  // 3. Build full toys.json from Supabase metadata (no sprites, no R2 egress)
  //    Query all toys but only the lightweight columns
  const { data: allToys, error: metaErr } = await supabase
    .from('toys')
    .select('name, width, height, sprite_width, sprite_height, sprite_top, sprite_left, mime_type, "group"');
  if (metaErr) throw metaErr;

  const metadata = allToys.map((toy) => {
    const base = `${PUBLIC_URL}/toys/${toy.name}`;
    return {
      ...toy,
      sprite_normal: `${base}/sprite_normal.png`,
      sprite_grabbed: `${base}/sprite_grabbed.png`,
      sprite_collected: `${base}/sprite_collected.png`,
    };
  });

  // 4. Upload merged toys.json
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: 'toys/toys.json',
    Body: JSON.stringify(metadata, null, 2),
    ContentType: 'application/json',
  }));

  if (since) {
    console.log(`\nDone! Uploaded ${toysToUpload.length} new toy sprites + rebuilt toys.json (${metadata.length} total)`);
  } else {
    console.log(`\nDone! Uploaded ${metadata.length} toys + toys.json`);
  }
  console.log(`Metadata URL: ${PUBLIC_URL}/toys/toys.json`);
}

uploadToys().catch(console.error);
