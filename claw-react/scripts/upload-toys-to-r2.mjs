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

async function uploadToys() {
  console.log('Fetching toys from Supabase...');
  const { data: toys, error } = await supabase.from('toys').select('*');
  if (error) throw error;
  console.log(`Found ${toys.length} toys`);

  const metadata = [];

  for (const toy of toys) {
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

    const { sprite_normal, sprite_grabbed, sprite_collected, ...rest } = toy;
    metadata.push({ ...rest, ...urls });
    console.log(`Uploaded: ${toy.name}`);
  }

  // Upload metadata JSON
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: 'toys/toys.json',
    Body: JSON.stringify(metadata, null, 2),
    ContentType: 'application/json',
  }));

  console.log(`\nDone! Uploaded ${metadata.length} toys + toys.json`);
  console.log(`Metadata URL: ${PUBLIC_URL}/toys/toys.json`);
}

uploadToys().catch(console.error);
